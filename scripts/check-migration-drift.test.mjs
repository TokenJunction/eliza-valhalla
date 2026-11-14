import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildExpectedSchemaObjects,
  checkMigrationDrift,
  extractSchemaObjects,
  fetchDatabaseState,
  findMissingSchemaObjects,
  parseLocalMigrationFiles,
  stripSqlCommentsAndStrings,
} from './check-migration-drift.mjs';

const REF = 'abcdefghijklmnopqrst';

function response(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return {
    ok,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function recorded(version, name, sql) {
  return { version, name, statements: sql ? [sql] : [] };
}

function mockFetch(state, onQuery) {
  return async (url, init) => {
    if (url.endsWith('/database/query/read-only')) {
      if (onQuery) onQuery(JSON.parse(init.body));
      return response([state], { status: 201, statusText: 'Created' });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };
}

async function withMigrations(files, run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'migration-drift-'));
  try {
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(path.join(directory, name), sql);
    }
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runCheck(directory, { state, onQuery } = {}) {
  const logs = [];
  const errors = [];
  const code = await checkMigrationDrift({
    migrationsDir: directory,
    projectRef: REF,
    token: 'test-token',
    fetchImpl: mockFetch(state, onQuery),
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line),
  });
  return { code, logs, errors };
}

test('parseLocalMigrationFiles reads only versioned SQL files and rejects duplicates', () => {
  assert.deepEqual(
    parseLocalMigrationFiles([
      '20261107152912_customer_identity_mapping.sql',
      'README.md',
      'not-a-migration.sql',
    ]).map(({ version, name }) => ({ version, name })),
    [{ version: '20261107152912', name: 'customer_identity_mapping' }],
  );

  assert.throws(
    () => parseLocalMigrationFiles([
      '20261107152912_one.sql',
      '20261107152912_two.sql',
    ]),
    /Duplicate migration version 20261107152912/,
  );
});

test('stripSqlCommentsAndStrings removes comments and literals but keeps identifiers', () => {
  const stripped = stripSqlCommentsAndStrings(`
    -- create table public.line_comment ();
    /* create table public.block_comment (); */
    create table "Public"."Actual Table" (
      note text default 'create table public.string_literal ()'
    );
    do $$ begin execute 'create table public.dollar_literal ()'; end $$;
  `);

  assert.doesNotMatch(stripped, /line_comment|block_comment|string_literal|dollar_literal/);
  assert.match(stripped, /"Public"\."Actual Table"/);
});

test('stripSqlCommentsAndStrings keeps DDL after a standard string ending in a backslash', () => {
  const stripped = stripSqlCommentsAndStrings(`
    comment on table public.before is 'C:\\';
    create table public.real_table ();
    comment on table public.after is E'C:\\\\';
    create table public.after_e_string ();
  `);

  assert.match(stripped, /create table public\.real_table/);
  assert.match(stripped, /create table public\.after_e_string/);
});

test('extractSchemaObjects finds tables and triggers and ignores fake DDL', () => {
  const objects = extractSchemaObjects(`
    -- create table public.from_comment ();
    /* create table public.from_block_comment (); */
    create table if not exists "Audit"."Event Log" (
      note text default 'create table public.from_string ()'
    );
    create table public.orders ();
    do $$ begin execute 'create table public.from_dollar_quote ()'; end $$;

    create trigger audit_event
      after insert on "Audit"."Event Log"
      for each row execute function public.audit_event();

    create or replace trigger order_guard
      before update on public.orders
      for each row execute function public.order_guard();
  `);

  assert.deepEqual(objects.tables, [
    { schema: 'Audit', name: 'Event Log' },
    { schema: 'public', name: 'orders' },
  ]);
  assert.deepEqual(objects.triggers, [
    { schema: 'Audit', table: 'Event Log', name: 'audit_event' },
    { schema: 'public', table: 'orders', name: 'order_guard' },
  ]);
});

test('buildExpectedSchemaObjects applies drops and removes triggers with their table', () => {
  const expected = buildExpectedSchemaObjects([
    {
      version: '20260101000000',
      name: 'create',
      file: '20260101000000_create.sql',
      sql: `
        create table public.old_table ();
        create table public.kept_table ();
        create trigger old_trigger after insert on public.old_table
          for each row execute function public.old_trigger();
        create trigger kept_trigger after insert on public.kept_table
          for each row execute function public.kept_trigger();
      `,
    },
    {
      version: '20260102000000',
      name: 'drop',
      file: '20260102000000_drop.sql',
      sql: 'drop table public.old_table;',
    },
  ]);

  assert.deepEqual(
    expected.tables.map(({ schema, name }) => ({ schema, name })),
    [{ schema: 'public', name: 'kept_table' }],
  );
  assert.deepEqual(
    expected.triggers.map(({ schema, table, name }) => ({ schema, table, name })),
    [{ schema: 'public', table: 'kept_table', name: 'kept_trigger' }],
  );
});

test('buildExpectedSchemaObjects follows tables moved to another schema or renamed', () => {
  const expected = buildExpectedSchemaObjects([
    {
      version: '20260101000000',
      name: 'create',
      file: '20260101000000_create.sql',
      sql: `
        create table public.old_table ();
        create trigger old_trigger after insert on public.old_table
          for each row execute function public.old_trigger();
      `,
    },
    {
      version: '20260102000000',
      name: 'move',
      file: '20260102000000_move.sql',
      sql: `
        alter table public.old_table set schema api;
        alter table api.old_table rename to new_table;
      `,
    },
  ]);

  assert.deepEqual(
    expected.tables.map(({ schema, name }) => ({ schema, name })),
    [{ schema: 'api', name: 'new_table' }],
  );
  assert.deepEqual(
    expected.triggers.map(({ schema, table, name }) => ({ schema, table, name })),
    [{ schema: 'api', table: 'new_table', name: 'old_trigger' }],
  );
});

test('findMissingSchemaObjects reports missing tables and triggers', () => {
  const expected = buildExpectedSchemaObjects([
    {
      version: '20260101000000',
      name: 'create',
      file: '20260101000000_create.sql',
      sql: `
        create table public.orders ();
        create trigger orders_guard before update on public.orders
          for each row execute function public.orders_guard();
      `,
    },
  ]);

  const missing = findMissingSchemaObjects(expected, {
    tables: [],
    triggers: [],
  });

  assert.deepEqual(
    missing.tables.map(({ schema, name }) => ({ schema, name })),
    [{ schema: 'public', name: 'orders' }],
  );
  assert.deepEqual(
    missing.triggers.map(({ schema, table, name }) => ({ schema, table, name })),
    [{ schema: 'public', table: 'orders', name: 'orders_guard' }],
  );
});

test('fetchDatabaseState queries recorded migrations and live schema', async () => {
  const calls = [];
  const state = await fetchDatabaseState({
    ref: REF,
    token: 'test-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response([
        {
          migrations: [
            { version: '20260101000000', name: 'create', statements: ['create table public.orders ();'] },
          ],
          tables: [{ schema: 'public', name: 'orders' }],
          triggers: [{ schema: 'public', table: 'orders', name: 'orders_guard' }],
        },
      ], { status: 201, statusText: 'Created' });
    },
  });

  assert.deepEqual(state, {
    migrations: [
      { version: '20260101000000', name: 'create', statements: ['create table public.orders ();'] },
    ],
    tables: [{ schema: 'public', name: 'orders' }],
    triggers: [{ schema: 'public', table: 'orders', name: 'orders_guard' }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.supabase.com/v1/projects/${REF}/database/query/read-only`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  const query = JSON.parse(calls[0].init.body).query;
  assert.match(query, /supabase_migrations\.schema_migrations/);
  assert.match(query, /pg_catalog\.pg_trigger/);
});

test('checkMigrationDrift fails when a recorded migration is missing its table', async () => {
  await withMigrations({}, async (directory) => {
    const { code, errors } = await runCheck(directory, {
      state: {
        migrations: [recorded(
          '20261107152912',
          'customer_identity_mapping',
          'create table public.customer_identity ();',
        )],
        tables: [],
        triggers: [],
      },
    });

    assert.equal(code, 1);
    assert.match(
      errors.join('\n'),
      /20261107152912_customer_identity_mapping is recorded as applied but table public\.customer_identity is missing/,
    );
  });
});

test('checkMigrationDrift fails when a recorded migration is missing its trigger', async () => {
  await withMigrations({}, async (directory) => {
    const { code, errors } = await runCheck(directory, {
      state: {
        migrations: [recorded(
          '20261107152912',
          'customer_identity_mapping',
          `
            create table public.customer_identity ();
            create trigger customer_identity_touch
              before update on public.customer_identity
              for each row execute function public.touch_customer_identity();
          `,
        )],
        tables: [{ schema: 'public', name: 'customer_identity' }],
        triggers: [],
      },
    });

    assert.equal(code, 1);
    assert.match(
      errors.join('\n'),
      /20261107152912_customer_identity_mapping is recorded as applied but trigger customer_identity_touch on public\.customer_identity is missing/,
    );
  });
});

test('checkMigrationDrift passes when recorded tables and triggers exist', async () => {
  await withMigrations({}, async (directory) => {
    const { code, logs } = await runCheck(directory, {
      state: {
        migrations: [recorded(
          '20261107152912',
          'customer_identity_mapping',
          `
            create table public.customer_identity ();
            create trigger customer_identity_touch
              before update on public.customer_identity
              for each row execute function public.touch_customer_identity();
          `,
        )],
        tables: [{ schema: 'public', name: 'customer_identity' }],
        triggers: [{
          schema: 'public',
          table: 'customer_identity',
          name: 'customer_identity_touch',
        }],
      },
    });

    assert.equal(code, 0);
    assert.match(logs.join('\n'), /Verified 1 table\(s\) and 1 trigger\(s\)/);
  });
});

test('checkMigrationDrift follows a recorded table moved to another schema', async () => {
  await withMigrations({}, async (directory) => {
    const { code } = await runCheck(directory, {
      state: {
        migrations: [
          recorded('20260101000000', 'create', 'create table public.depin_nodes ();'),
          recorded('20260102000000', 'move', 'alter table public.depin_nodes set schema api;'),
        ],
        tables: [{ schema: 'api', name: 'depin_nodes' }],
        triggers: [],
      },
    });

    assert.equal(code, 0);
  });
});

test('checkMigrationDrift fails when the migrations directory is missing', async () => {
  await assert.rejects(
    () => runCheck(path.join(tmpdir(), 'migration-drift-directory-does-not-exist')),
    /Migrations directory not found/,
  );
});

test('checkMigrationDrift fails pending migrations before checking schema', async () => {
  let queried = false;
  await withMigrations({
    '20261107152912_customer_identity_mapping.sql':
      'create table public.customer_identity ();',
  }, async (directory) => {
    const { code, errors } = await runCheck(directory, {
      state: {
        migrations: [],
        tables: [],
        triggers: [],
      },
      onQuery: () => {
        queried = true;
      },
    });

    assert.equal(code, 1);
    assert.equal(queried, true);
    assert.match(
      errors.join('\n'),
      /local migration version\(s\) are not applied: 20261107152912_customer_identity_mapping/,
    );
  });
});

test('checkMigrationDrift fails a recorded migration with no SQL and no local file', async () => {
  await withMigrations({}, async (directory) => {
    const { code, errors } = await runCheck(directory, {
      state: {
        migrations: [{ version: '20261107152912', name: 'missing_sql', statements: [] }],
        tables: [],
        triggers: [],
      },
    });

    assert.equal(code, 1);
    assert.match(
      errors.join('\n'),
      /20261107152912_missing_sql has no recorded SQL to verify its tables and triggers/,
    );
  });
});

test('checkMigrationDrift falls back to a local file when recorded SQL is absent', async () => {
  await withMigrations({
    '20261107152912_customer_identity_mapping.sql':
      'create table public.customer_identity ();',
  }, async (directory) => {
    const { code, logs } = await runCheck(directory, {
      state: {
        migrations: [{ version: '20261107152912', name: 'customer_identity_mapping', statements: [] }],
        tables: [{ schema: 'public', name: 'customer_identity' }],
        triggers: [],
      },
    });

    assert.equal(code, 0);
    assert.match(logs.join('\n'), /using the local migration file/);
    assert.match(logs.join('\n'), /Verified 1 table\(s\) and 0 trigger\(s\)/);
  });
});

test('checkMigrationDrift warns about recorded migrations with no local file', async () => {
  await withMigrations({}, async (directory) => {
    const { code, logs } = await runCheck(directory, {
      state: {
        migrations: [recorded(
          '20261107152912',
          'customer_identity_mapping',
          'create table public.customer_identity ();',
        )],
        tables: [{ schema: 'public', name: 'customer_identity' }],
        triggers: [],
      },
    });

    assert.equal(code, 0);
    assert.match(
      logs.join('\n'),
      /::warning::1 recorded migration version\(s\) have no local file: 20261107152912/,
    );
  });
});

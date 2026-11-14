#!/usr/bin/env node

// Compare local migrations with Supabase's recorded migration history and
// verify that every table and trigger created by a recorded migration still
// exists in the live database.
//
// The SQL applied for each migration is read from
// supabase_migrations.schema_migrations.statements. A local migration file is
// used as a fallback only when the recorded statements are unavailable.
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=... node scripts/check-migration-drift.mjs
//
// SUPABASE_PROJECT_REF is optional and defaults to the ValhallaOS project.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MIGRATION_FILE = /^(\d{14})_(.+)\.sql$/;
const DEFAULT_API = 'https://api.supabase.com/v1';
const DEFAULT_PROJECT_REF = 'girltjnrrwlyeufrcors';
const DEFAULT_SCHEMA = 'public';

const IDENTIFIER = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';
const QUALIFIED_IDENTIFIER = `${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})?`;

const DATABASE_STATE_QUERY = `
select
  coalesce(
    (
      select pg_catalog.json_agg(
        pg_catalog.json_build_object(
          'version', m.version,
          'name', m.name,
          'statements', m.statements
        )
        order by m.version
      )
      from supabase_migrations.schema_migrations as m
    ),
    '[]'::json
  ) as migrations,
  coalesce(
    (
      select pg_catalog.json_agg(
        pg_catalog.json_build_object('schema', n.nspname, 'name', c.relname)
        order by n.nspname, c.relname
      )
      from pg_catalog.pg_class as c
      join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'f')
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg\\_%'
    ),
    '[]'::json
  ) as tables,
  coalesce(
    (
      select pg_catalog.json_agg(
        pg_catalog.json_build_object(
          'schema', n.nspname,
          'table', c.relname,
          'name', t.tgname
        )
        order by n.nspname, c.relname, t.tgname
      )
      from pg_catalog.pg_trigger as t
      join pg_catalog.pg_class as c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
      where not t.tgisinternal
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg\\_%'
    ),
    '[]'::json
  ) as triggers
`;

export function parseLocalMigrationFiles(files) {
  const migrations = [];
  const seen = new Map();

  for (const file of files) {
    const match = MIGRATION_FILE.exec(file);
    if (!match) continue;

    const [, version, name] = match;
    if (seen.has(version)) {
      throw new Error(
        `Duplicate migration version ${version}: ${seen.get(version)} and ${file}`,
      );
    }

    seen.set(version, file);
    migrations.push({ version, name, file });
  }

  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

export function compareMigrations(local, remote) {
  const localVersions = new Set(local.map((migration) => migration.version));
  const remoteVersions = new Set(remote.map((migration) => migration.version));

  return {
    pending: local.filter((migration) => !remoteVersions.has(migration.version)),
    remoteOnly: remote.filter((migration) => !localVersions.has(migration.version)),
  };
}

// Remove comments and string/dollar-quoted literals before looking for DDL.
// Double-quoted identifiers are preserved because they can change case.
export function stripSqlCommentsAndStrings(sql) {
  let result = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      result += ' ';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      result += ' ';
      continue;
    }

    if (char === "'") {
      const escapeString = index > 0
        && (sql[index - 1] === 'E' || sql[index - 1] === 'e')
        && (index < 2 || !/[A-Za-z0-9_$]/.test(sql[index - 2]));
      const unicodeString = index >= 2
        && (sql[index - 2] === 'U' || sql[index - 2] === 'u')
        && sql[index - 1] === '&';

      index += 1;
      while (index < sql.length) {
        if ((escapeString || unicodeString) && sql[index] === '\\') {
          index += 2;
        } else if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2;
        } else if (sql[index] === "'") {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      result += "''";
      continue;
    }

    if (char === '"') {
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          index += 2;
        } else if (sql[index] === '"') {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      result += sql.slice(start, index);
      continue;
    }

    if (char === '$') {
      const delimiterMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));
      if (delimiterMatch) {
        const delimiter = delimiterMatch[0];
        const end = sql.indexOf(delimiter, index + delimiter.length);
        index = end === -1 ? sql.length : end + delimiter.length;
        result += "''";
        continue;
      }
    }

    result += char;
    index += 1;
  }

  return result;
}

function identifierParts(raw) {
  return raw.match(/"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*/g) ?? [];
}

function normalizeIdentifier(part) {
  if (part.startsWith('"')) return part.slice(1, -1).replace(/""/g, '"');
  return part.toLowerCase();
}

function normalizeQualifiedName(raw) {
  const parts = identifierParts(raw).map(normalizeIdentifier);
  if (parts.length === 1) return { schema: DEFAULT_SCHEMA, name: parts[0] };
  if (parts.length === 2) return { schema: parts[0], name: parts[1] };
  return null;
}

function qualifiedNamesIn(raw) {
  return [...raw.matchAll(new RegExp(QUALIFIED_IDENTIFIER, 'g'))]
    .map((match) => normalizeQualifiedName(match[0]))
    .filter(Boolean);
}

function schemaEvents(sql) {
  const sanitized = stripSqlCommentsAndStrings(sql);
  const events = [];

  const createTable = new RegExp(
    `\\bcreate\\s+(?:unlogged\\s+)?(?:foreign\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?(${QUALIFIED_IDENTIFIER})`,
    'gi',
  );
  for (const match of sanitized.matchAll(createTable)) {
    const object = normalizeQualifiedName(match[1]);
    if (object) {
      events.push({ index: match.index, action: 'create', kind: 'table', object });
    }
  }

  const dropTable = new RegExp(
    `\\bdrop\\s+(?:foreign\\s+)?table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QUALIFIED_IDENTIFIER}(?:\\s*,\\s*${QUALIFIED_IDENTIFIER})*)`,
    'gi',
  );
  for (const match of sanitized.matchAll(dropTable)) {
    events.push({
      index: match.index,
      action: 'drop',
      kind: 'table',
      objects: qualifiedNamesIn(match[1]),
    });
  }

  const createTrigger = new RegExp(
    `\\bcreate\\s+(?:or\\s+replace\\s+)?(?:constraint\\s+)?trigger\\s+(${IDENTIFIER})\\s+[^;]*?\\bon\\s+(${QUALIFIED_IDENTIFIER})`,
    'gi',
  );
  for (const match of sanitized.matchAll(createTrigger)) {
    const table = normalizeQualifiedName(match[2]);
    if (table) {
      events.push({
        index: match.index,
        action: 'create',
        kind: 'trigger',
        object: {
          schema: table.schema,
          table: table.name,
          name: normalizeIdentifier(match[1]),
        },
      });
    }
  }

  const dropTrigger = new RegExp(
    `\\bdrop\\s+trigger\\s+(?:if\\s+exists\\s+)?(${IDENTIFIER})\\s+on\\s+(${QUALIFIED_IDENTIFIER})`,
    'gi',
  );
  for (const match of sanitized.matchAll(dropTrigger)) {
    const table = normalizeQualifiedName(match[2]);
    if (table) {
      events.push({
        index: match.index,
        action: 'drop',
        kind: 'trigger',
        object: {
          schema: table.schema,
          table: table.name,
          name: normalizeIdentifier(match[1]),
        },
      });
    }
  }

  const moveTable = new RegExp(
    `\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QUALIFIED_IDENTIFIER})\\s+set\\s+schema\\s+(${IDENTIFIER})`,
    'gi',
  );
  for (const match of sanitized.matchAll(moveTable)) {
    const object = normalizeQualifiedName(match[1]);
    if (object) {
      events.push({
        index: match.index,
        action: 'move-table',
        object,
        schema: normalizeIdentifier(match[2]),
      });
    }
  }

  const renameTable = new RegExp(
    `\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QUALIFIED_IDENTIFIER})\\s+rename\\s+to\\s+(${IDENTIFIER})`,
    'gi',
  );
  for (const match of sanitized.matchAll(renameTable)) {
    const object = normalizeQualifiedName(match[1]);
    if (object) {
      events.push({
        index: match.index,
        action: 'rename-table',
        object,
        name: normalizeIdentifier(match[2]),
      });
    }
  }

  const renameTrigger = new RegExp(
    `\\balter\\s+trigger\\s+(${IDENTIFIER})\\s+on\\s+(${QUALIFIED_IDENTIFIER})\\s+rename\\s+to\\s+(${IDENTIFIER})`,
    'gi',
  );
  for (const match of sanitized.matchAll(renameTrigger)) {
    const table = normalizeQualifiedName(match[2]);
    if (table) {
      events.push({
        index: match.index,
        action: 'rename-trigger',
        object: {
          schema: table.schema,
          table: table.name,
          name: normalizeIdentifier(match[1]),
        },
        name: normalizeIdentifier(match[3]),
      });
    }
  }

  return events.sort((a, b) => a.index - b.index);
}

function tableKey(table) {
  return JSON.stringify([table.schema, table.name]);
}

function triggerKey(trigger) {
  return JSON.stringify([trigger.schema, trigger.table, trigger.name]);
}

function renameTriggersForTable(triggers, oldTable, newTable) {
  for (const [key, trigger] of triggers) {
    if (trigger.schema === oldTable.schema && trigger.table === oldTable.name) {
      triggers.delete(key);
      const updated = { ...trigger, schema: newTable.schema, table: newTable.name };
      triggers.set(triggerKey(updated), updated);
    }
  }
}

function moveTable(tables, triggers, oldTable, newTable) {
  const key = tableKey(oldTable);
  const existing = tables.get(key);
  if (!existing) return;

  tables.delete(key);
  const updated = { ...existing, schema: newTable.schema, name: newTable.name };
  tables.set(tableKey(updated), updated);
  renameTriggersForTable(triggers, oldTable, newTable);
}

function removeTriggersForTable(triggers, table) {
  for (const [key, trigger] of triggers) {
    if (trigger.schema === table.schema && trigger.table === table.name) {
      triggers.delete(key);
    }
  }
}

function compareTableKeys(a, b) {
  return a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name);
}

function compareTriggerKeys(a, b) {
  return (
    a.schema.localeCompare(b.schema)
    || a.table.localeCompare(b.table)
    || a.name.localeCompare(b.name)
  );
}

export function buildExpectedSchemaObjects(migrations) {
  const tables = new Map();
  const triggers = new Map();

  for (const migration of migrations) {
    const origin = {
      version: migration.version,
      migration: `${migration.version}_${migration.name}`,
      file: migration.file,
    };

    for (const event of schemaEvents(migration.sql)) {
      if (event.action === 'create' && event.kind === 'table') {
        tables.set(tableKey(event.object), { ...event.object, ...origin });
      } else if (event.action === 'drop' && event.kind === 'table') {
        for (const table of event.objects) {
          tables.delete(tableKey(table));
          removeTriggersForTable(triggers, table);
        }
      } else if (event.action === 'create' && event.kind === 'trigger') {
        triggers.set(triggerKey(event.object), { ...event.object, ...origin });
      } else if (event.action === 'drop' && event.kind === 'trigger') {
        triggers.delete(triggerKey(event.object));
      } else if (event.action === 'move-table') {
        moveTable(tables, triggers, event.object, {
          schema: event.schema,
          name: event.object.name,
        });
      } else if (event.action === 'rename-table') {
        moveTable(tables, triggers, event.object, {
          schema: event.object.schema,
          name: event.name,
        });
      } else if (event.action === 'rename-trigger') {
        const key = triggerKey(event.object);
        const existing = triggers.get(key);
        if (existing) {
          triggers.delete(key);
          const updated = { ...existing, name: event.name };
          triggers.set(triggerKey(updated), updated);
        }
      }
    }
  }

  return {
    tables: [...tables.values()].sort(compareTableKeys),
    triggers: [...triggers.values()].sort(compareTriggerKeys),
  };
}

export function extractSchemaObjects(sql) {
  const expected = buildExpectedSchemaObjects([
    { version: '0', name: 'inline', file: 'inline.sql', sql },
  ]);

  return {
    tables: expected.tables.map(({ schema, name }) => ({ schema, name })),
    triggers: expected.triggers.map(({ schema, table, name }) => ({ schema, table, name })),
  };
}

async function readLocalMigrations(directory) {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Migrations directory not found: ${directory}`);
    }
    throw error;
  }

  const migrations = parseLocalMigrationFiles(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );

  return Promise.all(
    migrations.map(async (migration) => ({
      ...migration,
      sql: await readFile(path.join(directory, migration.file), 'utf8'),
    })),
  );
}

export async function fetchDatabaseState({ ref, token, fetchImpl = fetch }) {
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required');
  if (!ref) throw new Error('SUPABASE_PROJECT_REF is required');

  const response = await fetchImpl(
    `${DEFAULT_API}/projects/${encodeURIComponent(ref)}/database/query/read-only`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: DATABASE_STATE_QUERY }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(
      `Supabase database state query returned ${response.status} ${response.statusText}: ${body}`,
    );
  }

  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : payload?.result;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error('Supabase database state query returned an unexpected response');
  }

  const [row] = rows;
  if (
    !Array.isArray(row?.migrations)
    || !Array.isArray(row?.tables)
    || !Array.isArray(row?.triggers)
  ) {
    throw new Error('Supabase database state query did not return migrations, tables and triggers');
  }

  return {
    migrations: row.migrations.map((migration) => {
      if (migration?.version === null || migration?.version === undefined) {
        throw new Error('Supabase database state query returned a migration without a version');
      }
      return {
        version: String(migration.version),
        name: typeof migration.name === 'string' ? migration.name : '',
        statements: Array.isArray(migration.statements)
          ? migration.statements.filter((statement) => typeof statement === 'string')
          : [],
      };
    }),
    tables: row.tables
      .filter((table) => typeof table?.schema === 'string' && typeof table?.name === 'string')
      .map(({ schema, name }) => ({ schema, name })),
    triggers: row.triggers
      .filter(
        (trigger) => typeof trigger?.schema === 'string'
          && typeof trigger?.table === 'string'
          && typeof trigger?.name === 'string',
      )
      .map(({ schema, table, name }) => ({ schema, table, name })),
  };
}

export function findMissingSchemaObjects(expected, live) {
  const liveTables = new Set(live.tables.map(tableKey));
  const liveTriggers = new Set(live.triggers.map(triggerKey));

  return {
    tables: expected.tables.filter((table) => !liveTables.has(tableKey(table))),
    triggers: expected.triggers.filter((trigger) => !liveTriggers.has(triggerKey(trigger))),
  };
}

function verificationMigrations(recorded, local, log) {
  const localByVersion = new Map(local.map((migration) => [migration.version, migration]));
  const migrations = [];
  const unverifiable = [];

  for (const migration of recorded) {
    const localFile = localByVersion.get(migration.version);
    const recordedSql = migration.statements.join('\n').trim();
    const localSql = localFile?.sql?.trim() ?? '';
    const sql = recordedSql || localSql;

    if (!sql) {
      unverifiable.push(migration);
      continue;
    }

    if (!recordedSql) {
      log(
        `::warning::recorded migration ${migration.version}_${migration.name} has no SQL statements; using the local migration file`,
      );
    }

    migrations.push({
      version: migration.version,
      name: migration.name || localFile?.name || '',
      file: localFile?.file ?? null,
      sql,
    });
  }

  return { migrations, unverifiable };
}

export async function checkMigrationDrift({
  migrationsDir = path.resolve(process.env.MIGRATIONS_DIR || 'supabase/migrations'),
  projectRef = process.env.SUPABASE_PROJECT_REF || DEFAULT_PROJECT_REF,
  token = process.env.SUPABASE_ACCESS_TOKEN,
  fetchImpl = fetch,
  log = console.log,
  errorLog = console.error,
} = {}) {
  if (!token) {
    throw new Error('SUPABASE_ACCESS_TOKEN is required');
  }

  const local = await readLocalMigrations(migrationsDir);
  const state = await fetchDatabaseState({ ref: projectRef, token, fetchImpl });
  const { pending, remoteOnly } = compareMigrations(local, state.migrations);

  log(`Local migrations: ${local.length}`);
  log(`Recorded migrations: ${state.migrations.length}`);
  log(`Local migrations missing from history: ${pending.length}`);
  log(`Recorded migrations without a local file: ${remoteOnly.length}`);

  if (remoteOnly.length > 0) {
    log(
      `::warning::${remoteOnly.length} recorded migration version(s) have no local file: ${remoteOnly
        .map((migration) => migration.version)
        .join(', ')}`,
    );
  }

  if (pending.length > 0) {
    errorLog(
      `::error::${pending.length} local migration version(s) are not applied: ${pending
        .map((migration) => `${migration.version}_${migration.name}`)
        .join(', ')}`,
    );
    return 1;
  }

  const { migrations, unverifiable } = verificationMigrations(
    state.migrations,
    local,
    log,
  );

  if (unverifiable.length > 0) {
    errorLog(
      `::error::${unverifiable.length} recorded migration(s) have no SQL statements and no local file to verify`,
    );
    for (const migration of unverifiable) {
      errorLog(
        `::error::${migration.version}_${migration.name || 'unknown'} has no recorded SQL to verify its tables and triggers`,
      );
    }
    return 1;
  }

  const expected = buildExpectedSchemaObjects(migrations);
  if (expected.tables.length === 0 && expected.triggers.length === 0) {
    log('No tables or triggers declared by recorded migrations to verify.');
    return 0;
  }

  const missing = findMissingSchemaObjects(expected, {
    tables: state.tables,
    triggers: state.triggers,
  });

  if (missing.tables.length === 0 && missing.triggers.length === 0) {
    log(
      `Verified ${expected.tables.length} table(s) and ${expected.triggers.length} trigger(s) from recorded migrations.`,
    );
    return 0;
  }

  errorLog('Migration drift detected: recorded migrations are missing schema objects.');
  for (const table of missing.tables) {
    errorLog(
      `::error::${table.migration} is recorded as applied but table ${table.schema}.${table.name} is missing`,
    );
  }
  for (const trigger of missing.triggers) {
    errorLog(
      `::error::${trigger.migration} is recorded as applied but trigger ${trigger.name} on ${trigger.schema}.${trigger.table} is missing`,
    );
  }
  return 1;
}

async function main() {
  try {
    process.exitCode = await checkMigrationDrift();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

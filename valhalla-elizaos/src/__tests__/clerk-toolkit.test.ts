import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type {
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from '@elizaos/core';
import project from '../index.ts';
import {
  CLERK_MCP_READ_ACTION,
  CLERK_SKILL_LOOKUP_ACTION,
  CLERK_SNIPPET_ACTION,
  CLERK_TOOLKIT_PLUGIN,
  createClerkToolkitPlugin,
} from '../clerk-toolkit.ts';

const SKILLS_ROOT = fileURLToPath(
  new URL('../../skills/clerk-toolkit/skills', import.meta.url),
);

function runtime(role: string): IAgentRuntime {
  return {
    character: {
      name: 'Test Agent',
      settings: { valhallaRole: role },
    },
  } as unknown as IAgentRuntime;
}

function message(text: string, extra: Record<string, unknown> = {}): Memory {
  return {
    content: { text, ...extra },
  } as unknown as Memory;
}

async function run(
  action: NonNullable<
    ReturnType<typeof createClerkToolkitPlugin>['actions']
  >[number],
  role: string,
  text: string,
  extra: Record<string, unknown> = {},
  options: HandlerOptions = {},
): Promise<ActionResult> {
  let callbackContent: Content | undefined;
  const callback: HandlerCallback = async (value) => {
    callbackContent = value;
    return [];
  };
  const result = await action.handler(
    runtime(role),
    message(text, extra),
    undefined,
    options,
    callback,
  );
  expect(callbackContent).toBeDefined();
  return result as ActionResult;
}

function plugin(
  overrides: Parameters<typeof createClerkToolkitPlugin>[0] = {},
) {
  return createClerkToolkitPlugin({
    skillsRoot: SKILLS_ROOT,
    allowedRoles: ['zeus'],
    env: {},
    ...overrides,
  });
}

function provider(): Provider {
  return plugin().providers![0];
}

function action(name: string) {
  return plugin().actions!.find((candidate) => candidate.name === name)!;
}

it('injects the matching Clerk skill only for granted roles', async () => {
  const result = await provider().get(
    runtime('zeus'),
    message('Add Clerk auth to my Next.js app.'),
    {} as State,
  );
  expect(result.text).toContain('# Clerk toolkit (read-only)');
  expect(result.text).toContain('## Selected skill: `clerk-nextjs-patterns`');
  expect(result.text).toContain('clerkMiddleware');
  expect(result.text).toContain('Status: not configured');
  expect(result.values?.clerkSkill).toBe('clerk-nextjs-patterns');
  expect(result.data?.clerkMcpConfigured).toBe(false);
});

it('selects the setup, billing, organizations and testing skills', async () => {
  const cases: Array<[string, string]> = [
    ['Add Clerk authentication to this project', 'clerk-setup'],
    ['Set up Clerk billing with a pricing table', 'clerk-billing'],
    ['Use Clerk organizations and RBAC', 'clerk-orgs'],
    ['Write a Playwright Clerk login test', 'clerk-testing'],
  ];
  for (const [request, skill] of cases) {
    const result = await provider().get(
      runtime('zeus'),
      message(request),
      {} as State,
    );
    expect(result.values?.clerkSkill).toBe(skill);
  }
});

it('lists an extra read tool but still hides known mutating tools', async () => {
  const result = await plugin({
    extraTools: ['future_read_tool', 'create_application'],
  }).providers![0].get(
    runtime('zeus'),
    message('Clerk setup help'),
    {} as State,
  );
  expect(result.text).toContain('future_read_tool');
  expect(result.text).not.toContain('create_application');
});

it('does not inject Clerk context for unrelated messages or ungranted roles', async () => {
  const unrelated = await provider().get(
    runtime('zeus'),
    message('What is the weather?'),
    {} as State,
  );
  expect(unrelated.text).toBe('');

  const denied = await provider().get(
    runtime('cerberus'),
    message('Add Clerk auth to my Next.js app.'),
    {} as State,
  );
  expect(denied.text).toBe('');
});

it('reads a specific Clerk reference and refuses path traversal', async () => {
  const lookup = action(CLERK_SKILL_LOOKUP_ACTION);
  await expect(
    lookup.validate(
      runtime('zeus'),
      message('Read the Clerk Next.js middleware reference.'),
    ),
  ).resolves.toBe(true);

  const result = await run(
    lookup,
    'zeus',
    'Read the Clerk Next.js middleware reference.',
  );
  expect(result.success).toBe(true);
  expect(String(result.text)).toContain('Route Protection');
  expect((result.data as Record<string, unknown>).file).toBe(
    'references/middleware-strategies.md',
  );

  const traversal = await run(
    lookup,
    'zeus',
    'Read clerk skill clerk-nextjs-patterns ../../package.json',
  );
  expect(traversal.success).toBe(false);
  expect(traversal.error).toBe('SKILL_FILE_FORBIDDEN');
  expect(String(traversal.text)).not.toContain('"name": "valhalla-elizaos"');
});

it('lists all bundled skills', async () => {
  const result = await run(
    action(CLERK_SKILL_LOOKUP_ACTION),
    'zeus',
    'List Clerk skills.',
  );
  expect(result.success).toBe(true);
  const skills = (result.data as { skills: string[] }).skills;
  expect(skills).toHaveLength(20);
  expect(skills).toContain('clerk-nextjs-patterns');
  expect(skills).toContain('clerk-billing');
});

it('snippet action falls back to a bundled skill without an MCP token', async () => {
  const snippet = action(CLERK_SNIPPET_ACTION);
  await expect(
    snippet.validate(
      runtime('zeus'),
      message('Show me the Clerk SDK snippet for organizations.'),
    ),
  ).resolves.toBe(true);

  const result = await run(
    snippet,
    'zeus',
    'Show me the Clerk SDK snippet for organizations.',
  );
  expect(result.success).toBe(true);
  const data = result.data as Record<string, unknown>;
  expect(data.source).toBe('local_skill');
  expect(data.degraded).toBe(true);
  expect(data.skill).toBe('clerk-orgs');
  expect(String(result.text)).toContain('Live Clerk MCP was unavailable');
  expect(String(result.text)).toContain('# clerk-orgs');
});

it('snippet action uses the read-only MCP tool when configured', async () => {
  const fetchImpl = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'initialize') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'mock-clerk' },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 's1',
          },
        },
      );
    }
    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [
            {
              type: 'text',
              text: `# Live Clerk snippet ${body.params.arguments.slug}`,
            },
          ],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const livePlugin = plugin({
    token: 'test-token',
    mcpUrl: 'https://mcp.example.test/mcp',
    fetchImpl,
  });
  const snippet = livePlugin.actions!.find(
    (candidate) => candidate.name === CLERK_SNIPPET_ACTION,
  )!;
  const result = await run(
    snippet,
    'zeus',
    'Show me the Clerk SDK snippet for organizations.',
  );
  expect(result.success).toBe(true);
  expect(String(result.text)).toContain('Live Clerk snippet organizations');
  expect((result.data as Record<string, unknown>).source).toBe('clerk_mcp');
  expect((result.data as Record<string, unknown>).degraded).toBe(false);
});

it('MCP reads fail closed without a token and never call a mutating tool', async () => {
  const missing = await run(
    action(CLERK_MCP_READ_ACTION),
    'zeus',
    'clerk mcp whoami',
  );
  expect(missing.success).toBe(false);
  expect(missing.error).toBe('clerk_mcp_not_configured');

  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const mutatingPlugin = plugin({
    token: 'test-token',
    mcpUrl: 'https://mcp.example.test/mcp',
    fetchImpl,
  });
  const read = mutatingPlugin.actions!.find(
    (candidate) => candidate.name === CLERK_MCP_READ_ACTION,
  )!;
  const blocked = await run(
    read,
    'zeus',
    'clerk mcp create_application {"name":"prod"}',
  );
  expect(blocked.success).toBe(false);
  expect(blocked.error).toBe('clerk_tool_not_read_only');
  expect(calls).toBe(0);
});

it('publishes exactly three read-only actions and no approval or deploy path', () => {
  const names = plugin().actions?.map((candidate) => candidate.name) ?? [];
  expect(names).toEqual([
    CLERK_SKILL_LOOKUP_ACTION,
    CLERK_SNIPPET_ACTION,
    CLERK_MCP_READ_ACTION,
  ]);
  expect(
    names.some((name) => /APPROVE|APPLY|COMMIT|PUSH|DEPLOY/.test(name)),
  ).toBe(false);
  expect(plugin().routes).toBeUndefined();
});

it('is attached to every project agent but gated by role', async () => {
  const pluginNames = project.agents.map((agent) =>
    (agent.plugins ?? []).map((entry) => entry.name),
  );
  expect(
    pluginNames.every((names) => names.includes(CLERK_TOOLKIT_PLUGIN)),
  ).toBe(true);

  const zeus = project.agents.find(
    (agent) => agent.character.username === 'zeus',
  );
  const cerberus = project.agents.find(
    (agent) => agent.character.username === 'cerberus',
  );
  const zeusPlugin = zeus?.plugins?.find(
    (entry) => entry.name === CLERK_TOOLKIT_PLUGIN,
  );
  const cerberusPlugin = cerberus?.plugins?.find(
    (entry) => entry.name === CLERK_TOOLKIT_PLUGIN,
  );
  const text = 'Read clerk skill clerk-nextjs-patterns';
  expect(
    await zeusPlugin?.actions?.[0]?.validate(runtime('zeus'), message(text)),
  ).toBe(true);
  expect(
    await cerberusPlugin?.actions?.[0]?.validate(
      runtime('cerberus'),
      message(text),
    ),
  ).toBe(false);
  expect(cerberus?.character.system).toContain('Clerk toolkit grant');
  expect(cerberus?.character.system).toContain('read-only Clerk MCP tools');
});

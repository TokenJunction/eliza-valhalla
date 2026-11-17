#!/usr/bin/env node
// Human and agent CLI for the Clerk toolkit.
//
// It can browse the bundled Clerk skills and call only the read-only Clerk MCP
// tools. It deliberately has no approval, apply, commit, push, deploy or
// mutating Clerk command.

import {
  ClerkMcpClient,
  ClerkToolkitError,
  clerkToolkitDoctor,
  createClerkMcpClient,
  loadClerkCatalog,
  readClerkSkill,
  searchClerkSkills,
  selectClerkSkills,
} from './lib.mjs';

const USAGE = `Clerk toolkit for ValhallaOS

Usage:
  node cli.mjs list
  node cli.mjs show <clerk-skill> [relative-file]
  node cli.mjs search <query>
  node cli.mjs doctor [--json]
  node cli.mjs mcp tools
  node cli.mjs mcp call <read-only-tool> [json-arguments]

Examples:
  node cli.mjs show clerk-nextjs-patterns
  node cli.mjs show clerk-nextjs-patterns references/middleware-strategies.md
  node cli.mjs mcp call list_clerk_sdk_snippets
  node cli.mjs mcp call clerk_sdk_snippet '{"slug":"organizations"}'

MCP calls need CLERK_MCP_TOKEN or CLERK_MCP_TOKEN_FILE. The CLI never prints
the token, and it refuses every mutating Clerk tool before making a request.
`;

function printSkills(skills) {
  for (const skill of skills) {
    console.log(`${skill.name}\n  ${skill.description}`);
  }
}

function parseJsonArguments(raw) {
  if (!raw) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ClerkToolkitError('MCP_ARGUMENTS_INVALID', 'MCP arguments must be a JSON object.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClerkToolkitError('MCP_ARGUMENTS_INVALID', 'MCP arguments must be a JSON object.');
  }
  return value;
}

async function mcpClient() {
  const { config, client } = await createClerkMcpClient();
  if (!config.configured) {
    throw new ClerkToolkitError(
      'MCP_NOT_CONFIGURED',
      'Set CLERK_MCP_TOKEN or CLERK_MCP_TOKEN_FILE to use Clerk MCP. Local skills work without a token.',
    );
  }
  return client;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  if (command === 'list') {
    printSkills(await loadClerkCatalog());
    return;
  }

  if (command === 'show') {
    const skill = argv[1];
    if (!skill) {
      throw new ClerkToolkitError('SKILL_REQUIRED', 'Usage: show <clerk-skill> [relative-file]');
    }
    const result = await readClerkSkill(skill, { file: argv[2] });
    if (result.file === 'SKILL.md') {
      const catalog = await loadClerkCatalog();
      const selected = selectClerkSkills(result.skill, catalog, 1)[0];
      if (selected?.name === result.skill) {
        console.error(`# ${result.skill}`);
        console.error(`# ${result.description}`);
        console.error(`# references: ${result.references.length}`);
        console.error('');
      }
    }
    console.log(result.content);
    return;
  }

  if (command === 'search') {
    const query = argv.slice(1).join(' ');
    if (!query) {
      throw new ClerkToolkitError('QUERY_REQUIRED', 'Usage: search <query>');
    }
    printSkills(searchClerkSkills(query, await loadClerkCatalog()));
    return;
  }

  if (command === 'doctor') {
    const result = await clerkToolkitDoctor();
    console.log(JSON.stringify(result, null, 2));
    if (result.mcp?.status === 'error') process.exitCode = 1;
    return;
  }

  if (command === 'mcp') {
    const action = argv[1];
    if (action === 'tools') {
      const client = await mcpClient();
      const initialized = await client.initialize();
      const tools = await client.listTools();
      console.log(`server: ${initialized.serverInfo?.name || 'unknown'}`);
      console.log(`protocol: ${initialized.protocolVersion || 'unknown'}`);
      for (const tool of tools) {
        console.log(
          `${tool.readOnly ? 'READ ' : 'BLOCK'}  ${tool.name}  ${tool.description}`,
        );
      }
      return;
    }
    if (action === 'call') {
      const name = argv[2];
      if (!name) {
        throw new ClerkToolkitError(
          'TOOL_REQUIRED',
          'Usage: mcp call <read-only-tool> [json-arguments]',
        );
      }
      const client = await mcpClient();
      const result = await client.callTool(name, parseJsonArguments(argv[3]), {
        context: 'ValhallaOS operator checking Clerk reference data',
      });
      console.log(result.text || JSON.stringify(result.structuredContent, null, 2));
      return;
    }
    throw new ClerkToolkitError('UNKNOWN_COMMAND', 'Use "mcp tools" or "mcp call".');
  }

  throw new ClerkToolkitError('UNKNOWN_COMMAND', `Unknown command: ${command}`);
}

try {
  await main();
} catch (error) {
  const code = error instanceof ClerkToolkitError ? error.code : 'UNEXPECTED';
  const message = error instanceof Error ? error.message : 'The command failed.';
  console.error(`ERROR ${code}: ${message}`);
  process.exitCode = 1;
}

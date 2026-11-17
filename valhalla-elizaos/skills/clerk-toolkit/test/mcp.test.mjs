import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ClerkMcpClient,
  ClerkMcpError,
  describeClerkMcpTools,
  isReadOnlyClerkTool,
  normalizeMcpUrl,
  resolveClerkMcpConfig,
} from '../lib.mjs';

const TOKEN = 'test-token-value-that-must-not-leak';

async function startServer(options = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      response.writeHead(400);
      response.end('bad json');
      return;
    }
    requests.push({ headers: request.headers, body });

    const authorized = request.headers.authorization === `Bearer ${TOKEN}`;
    if (options.requireAuth !== false && !authorized) {
      response.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer resource_metadata="https://mcp.example.test"',
      });
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (body.method === 'initialize') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'mock-session-123',
      });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'mock-clerk', version: '1.0.0' },
          },
        }),
      );
      return;
    }
    if (body.method === 'notifications/initialized') {
      response.writeHead(202);
      response.end();
      return;
    }
    if (body.method === 'tools/list') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              { name: 'clerk_sdk_snippet', description: 'Return a snippet' },
              { name: 'list_clerk_sdk_snippets', description: 'List snippets' },
              { name: 'whoami', description: 'Show the workspace' },
              { name: 'create_application', description: 'Create an app' },
              { name: 'patch_instance_config', description: 'Patch config' },
            ],
          },
        }),
      );
      return;
    }
    if (body.method === 'tools/call') {
      if (body.params.name === 'list_clerk_sdk_snippets') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: '# Snippets\n- use-user' }] },
          })}\n\n`,
        );
        return;
      }
      if (options.echoTokenError) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `request failed with Bearer ${TOKEN}`,
                },
              ],
            },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [
              {
                type: 'text',
                text: `# Snippet ${body.params.arguments?.slug || 'none'}\ncontext: ${
                  body.params.arguments?.context || ''
                }`,
              },
            ],
          },
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    requests,
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function clientFor(server, options = {}) {
  return new ClerkMcpClient({
    url: server.url,
    token: TOKEN,
    allowInsecure: true,
    timeoutMs: 5_000,
    ...options,
  });
}

test('initializes with Clerk-compatible headers and a session id', async () => {
  const server = await startServer();
  try {
    const client = clientFor(server);
    const initialized = await client.initialize();
    assert.equal(initialized.serverInfo.name, 'mock-clerk');
    assert.equal(client.sessionId, 'mock-session-123');

    const initialize = server.requests.find((request) => request.body.method === 'initialize');
    assert.equal(initialize.headers.authorization, `Bearer ${TOKEN}`);
    assert.match(initialize.headers.accept, /text\/event-stream/);
    assert.equal(initialize.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(initialize.body.params.clientInfo.name, 'valhalla-clerk-toolkit');

    const notification = server.requests.find(
      (request) => request.body.method === 'notifications/initialized',
    );
    assert.equal(notification.headers['mcp-session-id'], 'mock-session-123');
  } finally {
    await server.close();
  }
});

test('lists tools and marks only the read-only allowlist', async () => {
  const server = await startServer();
  try {
    const tools = await clientFor(server).listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.clerk_sdk_snippet.readOnly, true);
    assert.equal(byName.whoami.readOnly, true);
    assert.equal(byName.create_application.readOnly, false);
    assert.equal(byName.patch_instance_config.readOnly, false);
  } finally {
    await server.close();
  }
});

test('calls a read-only tool with context and the session header', async () => {
  const server = await startServer();
  try {
    const client = clientFor(server);
    const result = await client.callTool('clerk_sdk_snippet', { slug: 'organizations' });
    assert.match(result.text, /Snippet organizations/);
    assert.match(result.text, /context: ValhallaOS agent/);

    const call = server.requests.find(
      (request) =>
        request.body.method === 'tools/call' &&
        request.body.params.name === 'clerk_sdk_snippet',
    );
    assert.equal(call.headers['mcp-session-id'], 'mock-session-123');
    assert.equal(call.body.params.arguments.slug, 'organizations');
    assert.ok(call.body.params.arguments.context.length <= 200);
  } finally {
    await server.close();
  }
});

test('parses an SSE tool response', async () => {
  const server = await startServer();
  try {
    const result = await clientFor(server).callTool('list_clerk_sdk_snippets');
    assert.match(result.text, /Snippets/);
    assert.match(result.text, /use-user/);
  } finally {
    await server.close();
  }
});

test('refuses mutating tools before sending a request', async () => {
  const server = await startServer();
  try {
    const client = clientFor(server);
    const before = server.requests.length;
    for (const name of [
      'create_application',
      'patch_instance_config',
      'put_instance_config',
      'create_user',
      'check_domain_dns',
      'create_production_instance',
      'set_oauth_provider_credentials',
      'submit_feedback',
      'get_more_tools',
    ]) {
      await assert.rejects(
        () => client.callTool(name),
        (error) => error instanceof ClerkMcpError && error.code === 'MCP_TOOL_NOT_ALLOWED',
        name,
      );
    }
    assert.equal(server.requests.length, before);
  } finally {
    await server.close();
  }
});

test('reports 401 as an auth requirement without leaking the token', async () => {
  const server = await startServer();
  try {
    const client = clientFor(server, { token: 'wrong-token' });
    await assert.rejects(
      () => client.initialize(),
      (error) =>
        error instanceof ClerkMcpError &&
        error.code === 'MCP_AUTH_REQUIRED' &&
        !error.message.includes('wrong-token'),
    );
  } finally {
    await server.close();
  }
});

test('redacts tokens from tool errors and output', async () => {
  const server = await startServer({ echoTokenError: true });
  try {
    const client = clientFor(server);
    await assert.rejects(
      () => client.callTool('clerk_sdk_snippet'),
      (error) =>
        error instanceof ClerkMcpError &&
        error.code === 'MCP_TOOL_ERROR' &&
        !error.message.includes(TOKEN) &&
        error.message.includes('[redacted]'),
    );
  } finally {
    await server.close();
  }
});

test('validates URLs and reads tokens from a file', async () => {
  assert.equal(
    normalizeMcpUrl('https://mcp.clerk.com/mcp'),
    'https://mcp.clerk.com/mcp',
  );
  assert.throws(
    () => normalizeMcpUrl('http://mcp.clerk.com/mcp'),
    { code: 'MCP_CONFIG_INVALID' },
  );
  assert.throws(
    () => normalizeMcpUrl('http://127.0.0.1:9999/mcp'),
    { code: 'MCP_CONFIG_INVALID' },
  );
  assert.equal(
    normalizeMcpUrl('http://127.0.0.1:9999/mcp', { allowInsecure: true }),
    'http://127.0.0.1:9999/mcp',
  );
  assert.throws(
    () => normalizeMcpUrl('ftp://mcp.clerk.com/mcp'),
    { code: 'MCP_CONFIG_INVALID' },
  );

  const root = await mkdtemp(path.join(tmpdir(), 'clerk-token-'));
  try {
    const tokenFile = path.join(root, 'token');
    await writeFile(tokenFile, `${TOKEN}\n`);
    const config = await resolveClerkMcpConfig({
      env: { CLERK_MCP_TOKEN_FILE: tokenFile },
    });
    assert.equal(config.token, TOKEN);
    assert.equal(config.tokenSource, 'file');
    assert.equal(config.configured, true);

    const missing = await resolveClerkMcpConfig({ env: {} });
    assert.equal(missing.configured, false);
    assert.equal(missing.tokenSource, 'none');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the allowlist is truthful and configurable without enabling writes', () => {
  assert.equal(isReadOnlyClerkTool('whoami'), true);
  assert.equal(isReadOnlyClerkTool('create_application'), false);
  assert.equal(isReadOnlyClerkTool('create_application', ['create_application']), false);
  assert.equal(isReadOnlyClerkTool('future_read_tool', ['future_read_tool']), true);
  assert.equal(describeClerkMcpTools().includes('clerk_sdk_snippet'), true);
});

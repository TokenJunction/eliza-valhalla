import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OPT_IN = process.env.SMOKE_PORT_TEST === '1';
const DEFAULT_TIMEOUT_MS = 90_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function collectLog(child) {
  let log = '';
  const append = (chunk) => {
    log += chunk.toString();
    if (log.length > 100_000) log = log.slice(-100_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return () => log;
}

async function stopProcessGroup(child, exited) {
  if (child.exitCode !== null) return;

  const signal = (name) => {
    try {
      // npm and Bun both create children. Kill the group so the actual
      // elizaos server cannot survive after the test process exits.
      process.kill(-child.pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        // The process already exited.
      }
    }
  };

  signal('SIGTERM');
  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(5_000).then(() => true),
  ]);

  if (timedOut) {
    signal('SIGKILL');
    await Promise.race([exited, delay(2_000)]);
  }
}

test(
  'starts with PORT when SERVER_PORT is unset and serves /health',
  { skip: !OPT_IN, timeout: DEFAULT_TIMEOUT_MS + 10_000 },
  async (t) => {
    const requestedTimeout = Number(process.env.SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : DEFAULT_TIMEOUT_MS;

    const port = await freePort();
    const env = {
      ...process.env,
      PORT: String(port),
      // This is a startup/port check, not a production-secret validation run.
      NODE_ENV: 'test',
    };
    delete env.SERVER_PORT;

    const child = spawn('npm', ['start'], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = collectLog(child);
    const exited = once(child, 'exit').then(() => undefined, () => undefined);
    let spawnError;
    child.once('error', (error) => {
      spawnError = error;
    });

    try {
      const deadline = Date.now() + timeoutMs;
      let lastError;

      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) {
          throw new Error(`app exited before the health check (code ${child.exitCode})`);
        }

        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(2_000),
          });
          if (response.ok) {
            const body = await response.json();
            assert.equal(typeof body.status, 'string', 'health response must include a status');
            assert.match(
              log(),
              /\[startup\] resolved port \d+ \(source: PORT\)/,
              'startup log must report the PORT source',
            );
            return;
          }
          lastError = new Error(`health returned HTTP ${response.status}`);
        } catch (error) {
          lastError = error;
        }

        await delay(500);
      }

      throw new Error(
        `health did not respond within ${timeoutMs}ms: ${lastError?.message || 'no response'}`,
      );
    } catch (error) {
      t.diagnostic(log());
      throw error;
    } finally {
      await stopProcessGroup(child, exited);
    }
  },
);

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_PORT = '3000';

export function resolvePort(env = process.env) {
  if (typeof env.SERVER_PORT === 'string' && env.SERVER_PORT !== '') {
    return { port: env.SERVER_PORT, source: 'SERVER_PORT' };
  }
  if (typeof env.PORT === 'string' && env.PORT !== '') {
    return { port: env.PORT, source: 'PORT' };
  }
  return { port: DEFAULT_PORT, source: 'default' };
}

export function start(env = process.env) {
  const { port, source } = resolvePort(env);
  console.log(`[startup] resolved port ${port} (source: ${source})`);

  const child = spawn('elizaos', ['start'], {
    env: { ...env, SERVER_PORT: port },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  child.once('error', (error) => {
    console.error(`[startup] failed to launch elizaos: ${error.message}`);
    process.exitCode = 1;
  });

  child.once('exit', (code, signal) => {
    if (signal) {
      console.error(`[startup] elizaos stopped by ${signal}`);
      process.exitCode = 0;
      return;
    }
    process.exitCode = code ?? 1;
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) start();

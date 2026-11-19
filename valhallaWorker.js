'use strict';

const { checkStructure, checkWorkerConfig } = require('./scripts/workerPreflight');
const { createValhallaQueueEngine } = require('./valhallaQueueEngine');

const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60000;

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let timer;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function main() {
  checkStructure();
  if (!checkWorkerConfig()) {
    console.log(JSON.stringify({ component: 'worker', status: 'disabled', ready: false }));
    return;
  }

  const controller = new AbortController();
  let engine;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    const timer = setTimeout(() => {
      console.error(JSON.stringify({ component: 'worker', error: 'shutdown_timeout' }));
      process.exit(1);
    }, 10000);
    try {
      if (engine) await engine.close();
    } finally {
      clearTimeout(timer);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void shutdown().catch(() => {
        console.error(JSON.stringify({ component: 'worker', error: 'shutdown_failed' }));
        process.exitCode = 1;
      });
    });
  }
  let attempt = 0;
  while (!stopping) {
    try {
      engine = await createValhallaQueueEngine({
        role: 'consumer',
        signal: controller.signal,
        preferBackup: attempt % 2 === 1,
        onState: (state) => console.log(JSON.stringify({ component: 'worker', ...state })),
      });
      const status = engine.getStatus();
      console.log(JSON.stringify({
        component: 'worker',
        event: 'queue_connected',
        backend: status.backend,
        endpoint: status.endpoint,
        attempt: attempt + 1,
      }));
      if (stopping) await engine.close();
      break;
    } catch (error) {
      if (stopping) break;
      const code = ['startup_timeout', 'redis_unavailable', 'startup_cancelled'].includes(error.message) ? error.message : 'startup_failed';
      const retryInMs = Math.min(RETRY_BASE_MS * 2 ** Math.min(attempt, 4), RETRY_MAX_MS);
      console.error(JSON.stringify({ component: 'worker', error: code, retryInMs, attempt: attempt + 1 }));
      attempt += 1;
      await wait(retryInMs, controller.signal);
    }
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error(JSON.stringify({ component: 'worker', error: 'invalid_configuration' }));
    process.exitCode = 1;
  });
}

module.exports = { main };

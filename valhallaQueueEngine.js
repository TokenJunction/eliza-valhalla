'use strict';

const { timingSafeEqual } = require('node:crypto');
const IORedis = require('ioredis');
const { Queue, Worker, UnrecoverableError } = require('bullmq');

const QUEUE_TASKS = Object.freeze({
  zeus: new Set(['health-check', 'policy-check']),
  gorgo: new Set(['sandbox-health', 'paper-simulation']),
  cerberus: new Set(['vault-check']),
});
const MAX_PAYLOAD_BYTES = 4096;

function validateDispatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('request_must_be_an_object');
  }

  const { targetEngine, taskName, payload = {} } = input;
  if (!Object.hasOwn(QUEUE_TASKS, targetEngine) || !QUEUE_TASKS[targetEngine].has(taskName)) {
    throw new TypeError('unsupported_queue_task');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('payload_must_be_an_object');
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
    throw new TypeError('payload_too_large');
  }

  const allowedPayloadKeys = {
    'zeus:health-check': [],
    'zeus:policy-check': ['mode'],
    'gorgo:sandbox-health': [],
    'gorgo:paper-simulation': ['scenario'],
    'cerberus:vault-check': [],
  }[`${targetEngine}:${taskName}`];
  if (Object.keys(payload).some((key) => !allowedPayloadKeys.includes(key))) {
    throw new TypeError('unsupported_payload_field');
  }
  if (taskName === 'policy-check' && payload.mode !== 'paper') {
    throw new TypeError('only_paper_mode_is_supported');
  }
  if (
    taskName === 'paper-simulation' &&
    !['baseline', 'risk-limit'].includes(payload.scenario)
  ) {
    throw new TypeError('unsupported_paper_scenario');
  }

  return { targetEngine, taskName, payload };
}

function executeSafeTask(targetEngine, taskName, payload) {
  switch (`${targetEngine}:${taskName}`) {
    case 'zeus:health-check':
      return { status: 'observed', mode: 'paper' };
    case 'zeus:policy-check':
      return { status: 'paper_only', mode: payload.mode };
    case 'gorgo:sandbox-health':
      return { status: 'ready_for_simulation', isolated: false };
    case 'gorgo:paper-simulation':
      return { status: 'simulated', mode: 'paper', scenario: payload.scenario };
    case 'cerberus:vault-check':
      return { status: 'blocked', vaultLocked: true };
    default:
      throw new Error('unsupported_queue_task');
  }
}

function isAuthorizedDispatch(authorization, expectedToken) {
  if (!expectedToken || typeof authorization !== 'string') return false;
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match) return false;

  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function queueEndpointLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || 6379}`;
  } catch {
    return 'invalid';
  }
}

function timeoutAfter(ms, code) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function selectQueueBackend({ candidates, RedisClient, startupTimeoutMs, signal }) {
  let failure = 'redis_unavailable';
  for (const candidate of candidates) {
    if (signal?.aborted) throw new Error('startup_cancelled');
    const { url, backend } = candidate;
    const connection = new RedisClient(url, {
      maxRetriesPerRequest: null,
      connectTimeout: Math.min(startupTimeoutMs, 5000),
      retryStrategy: (attempt) => Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 15000),
    });
    let onAbort;
    const aborted = signal ? new Promise((_, reject) => {
      onAbort = () => reject(new Error('startup_cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    }) : null;
    const timeout = timeoutAfter(Math.min(startupTimeoutMs, 5000), 'backend_timeout');
    try {
      const ping = connection.ping();
      await (aborted ? Promise.race([ping, timeout.promise, aborted]) : Promise.race([ping, timeout.promise]));
      return {
        connection,
        backend,
        endpoint: queueEndpointLabel(url),
      };
    } catch (error) {
      connection.disconnect();
      if (error.message === 'startup_cancelled') throw error;
      failure = error.message === 'backend_timeout' ? 'startup_timeout' : 'redis_unavailable';
    } finally {
      timeout.cancel();
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
  throw new Error(failure);
}

async function createValhallaQueueEngine({
  redisUrl = process.env.REDIS_URL,
  backupRedisUrl = process.env.REDIS_URL_BACKUP,
  preferBackup = false,
  RedisClient = IORedis,
  QueueClass = Queue,
  WorkerClass = Worker,
  role = 'combined',
  startupTimeoutMs = 10000,
  signal,
  onState = () => {},
} = {}) {
  validateQueueConfig({ redisUrl, role });
  if (backupRedisUrl) validateQueueConfig({ redisUrl: backupRedisUrl, role });
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 30000) {
    throw new Error('invalid_startup_timeout');
  }
  if (signal?.aborted) throw new Error('startup_cancelled');

  const candidates = [];
  for (const [url, backend] of [[redisUrl, 'primary'], [backupRedisUrl, 'backup']]) {
    if (url && !candidates.some((candidate) => candidate.url === url)) candidates.push({ url, backend });
  }
  if (preferBackup && candidates.length > 1) candidates.reverse();
  const selected = await selectQueueBackend({ candidates, RedisClient, startupTimeoutMs, signal });
  const connection = selected.connection;
  const backend = selected.backend;
  const endpoint = selected.endpoint;
  const queues = {};
  const workers = [];
  const blockingClients = [];
  let closed = false;
  let ready = null;
  let started = false;
  let stopped = false;
  let closePromise;
  const state = (value) => {
    if (ready === value) return;
    ready = value;
    onState({ ready: value, role, backend, endpoint, capabilities: ['paper-only', 'allowlisted-tasks'] });
  };
  const refresh = () => {
    if (started && !closed) {
      state(!stopped && connection.status === 'ready' &&
        blockingClients.every((client) => client.status === 'ready') &&
        workers.every((worker) => worker.isRunning()));
    }
  };
  connection.on('error', () => console.error(JSON.stringify({ component: 'queue', error: 'redis_error' })));
  connection.on('close', () => state(false));
  connection.on('ready', refresh);

  function close(force = false) {
    if (closePromise) return closePromise;
    closed = true;
    state(false);
    if (force) connection.disconnect();
    closePromise = (async () => {
      try {
        const workerResults = await Promise.allSettled(workers.map((worker) => worker.close(force)));
        const queueResults = await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
        if ([...workerResults, ...queueResults].some((result) => result.status === 'rejected')) {
          throw new Error('queue_cleanup_failed');
        }
      } finally {
        connection.disconnect();
      }
    })();
    return closePromise;
  }

  let timer;
  let abort;
  try {
    const startup = (async () => {
      await connection.ping();
      if (closed) return;
      if (role !== 'consumer') {
        for (const name of Object.keys(QUEUE_TASKS)) {
          queues[name] = new QueueClass(`valhalla-${name}`, { connection });
          queues[name].on('error', () => console.error(JSON.stringify({ component: 'queue', error: 'queue_error' })));
        }
      }
      if (role !== 'producer') {
        for (const targetEngine of Object.keys(QUEUE_TASKS)) {
          const worker = new WorkerClass(
            `valhalla-${targetEngine}`,
            async (job) => {
              let dispatch;
              try {
                if (!job.data || typeof job.data !== 'object' || Array.isArray(job.data) ||
                    Object.keys(job.data).some((key) => key !== 'payload') ||
                    !Object.hasOwn(job.data, 'payload')) {
                  throw new Error('invalid_job');
                }
                dispatch = validateDispatch({ targetEngine, taskName: job.name, payload: job.data.payload });
              } catch {
                throw new UnrecoverableError('invalid_job');
              }
              return executeSafeTask(targetEngine, dispatch.taskName, dispatch.payload);
            },
            { connection, concurrency: 1, autorun: false },
          );
          worker.on('error', () => {
            state(false);
            console.error(JSON.stringify({ component: 'queue', error: 'worker_error' }));
          });
          worker.on('ioredis:close', () => state(false));
          workers.push(worker);
        }
      }
      await Promise.all([
        ...Object.values(queues).map((queue) => queue.waitUntilReady()),
        ...workers.map((worker) => worker.waitUntilReady()),
      ]);
      if (closed) return;
      for (const worker of workers) {
        const client = await worker.getBackend().blockingConnection.client;
        if (closed) return;
        blockingClients.push(client);
        client.on('close', () => state(false));
        client.on('ready', refresh);
      }
      for (const worker of workers) {
        void worker.run().catch(() => {
          stopped = true;
          state(false);
          console.error(JSON.stringify({ component: 'queue', error: 'worker_stopped' }));
        });
      }
      started = true;
      refresh();
    })();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('startup_timeout')), startupTimeoutMs);
      if (signal) {
        abort = () => reject(new Error('startup_cancelled'));
        signal.addEventListener('abort', abort, { once: true });
      }
    });
    await Promise.race([startup, deadline]);
  } catch (error) {
    void close(true).catch(() => console.error(JSON.stringify({ component: 'queue', error: 'cleanup_failed' })));
    if (error.message === 'startup_timeout' || error.message === 'startup_cancelled') throw error;
    throw new Error('redis_unavailable');
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }

  return {
    getStatus: () => ({ ready: ready === true, role, backend, endpoint, capabilities: ['paper-only', 'allowlisted-tasks'] }),
    async enqueue(input) {
      if (closed || !ready || role === 'consumer') throw new Error('queue_unavailable');
      const { targetEngine, taskName, payload } = validateDispatch(input);
      return queues[targetEngine].add(taskName, { payload }, {
        removeOnComplete: 100,
        removeOnFail: 100,
      });
    },
    close,
  };
}

function validateQueueConfig({ redisUrl, role }) {
  if (!['producer', 'consumer', 'combined'].includes(role)) throw new Error('invalid_queue_role');
  if (!redisUrl) throw new Error('REDIS_URL is required when the queue runtime is enabled');
  let parsedUrl;
  try {
    parsedUrl = new URL(redisUrl);
  } catch {
    throw new Error('invalid_redis_url');
  }
  const renderInternal = parsedUrl.protocol === 'redis:' && /^red-[a-z0-9]+$/i.test(parsedUrl.hostname);
  if (
    !['redis:', 'rediss:'].includes(parsedUrl.protocol) ||
    !parsedUrl.hostname ||
    (process.env.NODE_ENV === 'production' && parsedUrl.protocol !== 'rediss:' && !renderInternal) ||
    parsedUrl.search || parsedUrl.hash
  ) {
    throw new Error('REDIS_URL must use rediss:// in production');
  }
}

module.exports = {
  createValhallaQueueEngine,
  executeSafeTask,
  isAuthorizedDispatch,
  validateQueueConfig,
  validateDispatch,
};

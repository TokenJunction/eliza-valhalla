'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createValhallaQueueEngine } = require('./valhallaQueueEngine');
const { checkWorkerConfig } = require('./scripts/workerPreflight');

const root = __dirname;
const config = {
  VALHALLA_QUEUE_ENABLED: 'true',
  VALHALLA_QUEUE_ROLE: 'consumer',
  VALHALLA_EXECUTION_MODE: 'paper',
  REDIS_URL: 'redis://127.0.0.1:6379',
};

function fixture({ hang = false, fail = false, failUrls = [], hangUrls = [] } = {}) {
  const connections = [];
  const queues = [];
  const workers = [];
  class Redis extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.status = 'ready';
      connections.push(this);
    }
    ping() {
      if (hang || hangUrls.includes(this.url)) return new Promise(() => {});
      if (fail || failUrls.includes(this.url)) return Promise.reject(new Error('sensitive backend details'));
      return Promise.resolve('PONG');
    }
    disconnect() { this.status = 'end'; this.emit('close'); }
  }
  class Queue extends EventEmitter {
    constructor(name) { super(); this.name = name; queues.push(this); }
    waitUntilReady() { return Promise.resolve(); }
    add(name, data) { return Promise.resolve({ name, data }); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  class Worker extends EventEmitter {
    constructor(name, processor, options) {
      super();
      this.name = name;
      this.processor = processor;
      this.options = options;
      this.client = new EventEmitter();
      this.client.status = 'ready';
      workers.push(this);
    }
    waitUntilReady() { return Promise.resolve(); }
    getBackend() { return { blockingConnection: { client: Promise.resolve(this.client) } }; }
    run() { this.running = true; return new Promise(() => {}); }
    isRunning() { return !!this.running; }
    close(force) { this.closed = true; this.force = force; this.running = false; return Promise.resolve(); }
  }
  return { Redis, Queue, Worker, connections, queues, workers };
}

function options(f, extra = {}) {
  return { redisUrl: config.REDIS_URL, RedisClient: f.Redis, QueueClass: f.Queue, WorkerClass: f.Worker, ...extra };
}

test('worker requires explicit activation, consumer role, paper mode and safe configuration', () => {
  assert.equal(checkWorkerConfig({ VALHALLA_QUEUE_ENABLED: 'false' }), false);
  assert.equal(checkWorkerConfig(config), true);
  for (const overrides of [
    { VALHALLA_QUEUE_ENABLED: '' },
    { VALHALLA_QUEUE_ROLE: 'combined' },
    { VALHALLA_EXECUTION_MODE: 'live' },
    { REDIS_URL: '' },
    { REDIS_URL: 'https://example.invalid' },
    { VALHALLA_TRADING_ENABLED: 'true' },
  ]) assert.throws(() => checkWorkerConfig({ ...config, ...overrides }));
});

test('preflight detects wrong directory and worker disabled mode exits without readiness', () => {
  const env = { PATH: process.env.PATH, VALHALLA_QUEUE_ENABLED: 'false' };
  const disabled = spawnSync(process.execPath, [path.join(root, 'valhallaWorker.js')], { cwd: root, env, encoding: 'utf8' });
  assert.equal(disabled.status, 0);
  assert.match(disabled.stdout, /"ready":false/);
  const wrong = spawnSync(process.execPath, [path.join(root, 'scripts/workerPreflight.js'), '--structure'], { cwd: path.dirname(root), env, encoding: 'utf8' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /wrong_working_directory/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-preflight-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/workerPreflight.js'), path.join(tmp, 'scripts/workerPreflight.js'));
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"valhalla-site"}');
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{}');
    const missing = spawnSync(process.execPath, [path.join(tmp, 'scripts/workerPreflight.js'), '--structure'], { cwd: tmp, env, encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /missing_worker_file/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('consumer revalidates untrusted jobs and never creates producer queues', async () => {
  const f = fixture();
  const engine = await createValhallaQueueEngine(options(f, { role: 'consumer' }));
  assert.equal(f.queues.length, 0);
  assert.equal(f.workers.length, 3);
  assert.ok(f.workers.every((worker) => worker.options.concurrency === 1 && worker.options.autorun === false));
  const gorgo = f.workers.find((worker) => worker.name === 'valhalla-gorgo');
  assert.deepEqual(await gorgo.processor({ name: 'paper-simulation', data: { payload: { scenario: 'baseline' } } }), {
    status: 'simulated', mode: 'paper', scenario: 'baseline',
  });
  for (const job of [
    { name: 'trade', data: { payload: {} } },
    { name: 'paper-simulation', data: { payload: { scenario: 'arbitrary-code' } } },
    { name: 'sandbox-health', data: null },
    { name: 'sandbox-health', data: {} },
    { name: 'sandbox-health', data: { payload: {}, tenant: 'unverified' } },
    { name: 'sandbox-health', data: { payload: { privateKey: 'not-allowed' } } },
  ]) await assert.rejects(gorgo.processor(job));
  await assert.rejects(engine.enqueue({}), /queue_unavailable/);
  await engine.close();
  assert.ok(f.workers.every((worker) => worker.closed));
  assert.equal(f.connections[0].status, 'end');
});

test('producer and legacy combined modes preserve roles and reconnect readiness', async () => {
  for (const role of ['producer', 'combined']) {
    const f = fixture();
    const states = [];
    const engine = await createValhallaQueueEngine(options(f, { role, onState: (state) => states.push(state.ready) }));
    assert.equal(f.queues.length, 3);
    assert.equal(f.workers.length, role === 'combined' ? 3 : 0);
    assert.equal(engine.getStatus().ready, true);
    await engine.enqueue({ targetEngine: 'zeus', taskName: 'health-check' });
    const connection = f.connections[0];
    connection.status = 'reconnecting';
    connection.emit('close');
    assert.equal(engine.getStatus().ready, false);
    await assert.rejects(engine.enqueue({ targetEngine: 'zeus', taskName: 'health-check' }), /queue_unavailable/);
    connection.status = 'ready';
    connection.emit('ready');
    assert.equal(engine.getStatus().ready, true);
    if (f.workers.length) {
      const blocking = f.workers[0].client;
      blocking.status = 'reconnecting';
      blocking.emit('close');
      assert.equal(engine.getStatus().ready, false);
      blocking.status = 'ready';
      blocking.emit('ready');
      assert.equal(engine.getStatus().ready, true);
    }
    assert.deepEqual(states.slice(0, 3), [true, false, true]);
    await engine.close();
    await engine.close();
    assert.ok(f.queues.every((queue) => queue.closed));
  }
});

test('fails over from an unavailable primary to the backup endpoint', async () => {
  const primary = 'redis://127.0.0.1:6390';
  const backup = 'rediss://red-backup.example.test:6379';
  const f = fixture({ failUrls: [primary] });
  const engine = await createValhallaQueueEngine({
    redisUrl: primary,
    backupRedisUrl: backup,
    role: 'consumer',
    RedisClient: f.Redis,
    QueueClass: f.Queue,
    WorkerClass: f.Worker,
  });
  assert.equal(engine.getStatus().backend, 'backup');
  assert.equal(engine.getStatus().endpoint, 'red-backup.example.test:6379');
  assert.equal(f.connections.length, 2);
  assert.equal(f.connections[0].status, 'end');
  assert.equal(f.connections[1].status, 'ready');
  await engine.close();
});

test('reports redis_unavailable only after both endpoints fail', async () => {
  const f = fixture({ fail: true });
  await assert.rejects(createValhallaQueueEngine({
    redisUrl: 'redis://127.0.0.1:6390',
    backupRedisUrl: 'rediss://red-backup.example.test:6379',
    RedisClient: f.Redis,
    QueueClass: f.Queue,
    WorkerClass: f.Worker,
  }), /^Error: redis_unavailable$/);
  assert.equal(f.connections.length, 2);
  assert.ok(f.connections.every((connection) => connection.status === 'end'));
});

test('unavailable Redis, startup deadline and cancellation clean up without leaking errors', async () => {
  const failed = fixture({ fail: true });
  await assert.rejects(createValhallaQueueEngine(options(failed)), /^Error: redis_unavailable$/);
  assert.equal(failed.connections[0].status, 'end');
  const hung = fixture({ hang: true });
  await assert.rejects(createValhallaQueueEngine(options(hung, { startupTimeoutMs: 20 })), /startup_timeout/);
  assert.equal(hung.connections[0].status, 'end');
  const cancelled = fixture({ hang: true });
  const controller = new AbortController();
  const startup = createValhallaQueueEngine(options(cancelled, { signal: controller.signal }));
  controller.abort();
  await assert.rejects(startup, /startup_cancelled/);
  assert.equal(cancelled.connections[0].status, 'end');
  assert.equal(cancelled.workers.length, 0);
  assert.equal(cancelled.connections[0].options.retryStrategy(1), 1000);
  assert.equal(cancelled.connections[0].options.retryStrategy(100), 15000);
});

test('cleanup failures are reported after disconnecting', async () => {
  const f = fixture();
  const engine = await createValhallaQueueEngine(options(f, { role: 'producer' }));
  f.queues[0].close = () => Promise.reject(new Error('backend detail'));
  await assert.rejects(engine.close(), /^Error: queue_cleanup_failed$/);
  assert.equal(f.connections[0].status, 'end');
});

for (const signalName of ['SIGTERM', 'SIGINT']) test(`${signalName} cancels a real pending connection without reporting ready`, async () => {
  const child = spawn(process.execPath, [path.join(root, 'valhallaWorker.js')], {
    cwd: root,
    env: { PATH: process.env.PATH, ...config, REDIS_URL: 'redis://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const started = await Promise.race([
      once(child.stderr, 'data').then(() => true),
      once(child, 'exit').then(() => false),
    ]);
    assert.equal(started, true);
    child.kill(signalName);
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.doesNotMatch(output, /"ready":true/);
  } finally {
    clearTimeout(timer);
  }
});

test('bounded fixture profile processes permitted synthetic jobs', async (t) => {
  const f = fixture();
  const engine = await createValhallaQueueEngine(options(f, { role: 'consumer' }));
  const processor = f.workers.find((worker) => worker.name === 'valhalla-gorgo').processor;
  const latencies = [];
  let errors = 0;
  const before = process.memoryUsage().rss;
  const start = performance.now();
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let i = 0; i < 20; i++) {
      const jobStart = performance.now();
      try {
        const result = await processor({ name: 'paper-simulation', data: { payload: { scenario: 'baseline' } } });
        assert.equal(result.status, 'simulated');
      } catch {
        errors++;
      }
      latencies.push(performance.now() - jobStart);
    }
  }));
  const elapsed = performance.now() - start;
  const after = process.memoryUsage().rss;
  await engine.close();
  assert.equal(latencies.length, 80);
  assert.equal(errors, 0);
  assert.ok(elapsed < 30000);
  assert.ok(f.workers.every((worker) => worker.closed));
  t.diagnostic(`fixture only: 80 jobs, 4 clients, ${errors} errors, elapsed ${elapsed.toFixed(2)}ms, max latency ${Math.max(...latencies).toFixed(2)}ms, RSS delta ${after - before} bytes; workers closed`);
});

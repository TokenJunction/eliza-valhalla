'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function checkStructure() {
  if (process.cwd() !== root) throw new Error('wrong_working_directory');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('unsupported_node_runtime');
  for (const file of ['package.json', 'package-lock.json', 'valhallaWorker.js', 'valhallaQueueEngine.js']) {
    if (!fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()) {
      throw new Error('missing_worker_file');
    }
  }
  if (require(path.join(root, 'package.json')).name !== 'valhalla-site') throw new Error('wrong_project');
}

function checkWorkerConfig(env = process.env) {
  if (env.VALHALLA_QUEUE_ENABLED === 'false') return false;
  if (env.VALHALLA_QUEUE_ENABLED !== 'true') throw new Error('queue_activation_required');
  if (env.VALHALLA_QUEUE_ROLE !== 'consumer') throw new Error('worker_role_must_be_consumer');
  if (env.VALHALLA_EXECUTION_MODE !== 'paper') throw new Error('paper_mode_required');
  for (const name of ['VALHALLA_TRADING_ENABLED', 'VALHALLA_SOCIAL_ENABLED', 'VALHALLA_KEY_STORAGE_ENABLED', 'ZEUS_IDLE_ENABLED']) {
    if (env[name] && env[name] !== 'false') throw new Error('unsupported_capability_enabled');
  }
  const { validateQueueConfig } = require('../valhallaQueueEngine');
  validateQueueConfig({ redisUrl: env.REDIS_URL, role: 'consumer' });
  if (env.REDIS_URL_BACKUP) validateQueueConfig({ redisUrl: env.REDIS_URL_BACKUP, role: 'consumer' });
  return true;
}

if (require.main === module) {
  try {
    checkStructure();
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--structure')) {
      throw new Error('invalid_preflight_option');
    }
    if (process.argv[2] !== '--structure' && !checkWorkerConfig()) throw new Error('queue_disabled');
    console.log(JSON.stringify({
      component: 'worker_preflight',
      status: 'passed',
      scope: process.argv[2] === '--structure' ? 'structure' : 'configuration',
      redundancy: process.env.REDIS_URL_BACKUP ? 'dual' : 'single',
    }));
  } catch (error) {
    console.error(JSON.stringify({ component: 'worker_preflight', error: error.message }));
    process.exitCode = 1;
  }
}

module.exports = { checkStructure, checkWorkerConfig };

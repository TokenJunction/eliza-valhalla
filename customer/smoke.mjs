#!/usr/bin/env node
'use strict';

// Runs one customer smoke. It does not write files, open a tunnel, or read a secret file.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runLocalQwen, runPreview } = require('./local-qwen-relay.js');

const major = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(major) || major < 22) {
  console.error('Node.js 22 or newer is required. This script does not install it.');
  process.exit(1);
}

const mode = process.argv[2];
if (mode !== 'local-qwen' && mode !== 'preview') {
  console.error('Usage: node customer/smoke.mjs <local-qwen|preview>');
  console.error('local-qwen measures the loopback qwen gateway. A missing token or a silent gateway fails.');
  console.error('preview measures VALHALLA_PREVIEW_HEALTH_URL. A missing URL is not healthy.');
  process.exit(1);
}

const result = mode === 'preview'
  ? await runPreview(process.env)
  : await runLocalQwen(process.env, { fetchImpl: globalThis.fetch });

console.log(JSON.stringify({
  ok: result.ok === true,
  package: result.package,
  measured: result.measured === true,
  healthy: result.healthy === true,
  assumed: false,
  liveExecution: false,
  reason: result.reason || null,
  message: result.message || null,
  route: result.route || null,
  status: result.status || null,
  httpStatus: result.httpStatus || null,
}));
process.exit(result.ok === true ? 0 : 1);

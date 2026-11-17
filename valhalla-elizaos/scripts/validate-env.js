import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRODUCTION_MODEL_KEYS = ['OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'];
const REQUIRED_PAIRS = [
  ['SUPABASE_URL', 'SUPABASE_ANON_KEY'],
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
];
const DISABLED_CAPABILITIES = [
  'VALHALLA_TRADING_ENABLED',
  'VALHALLA_SOCIAL_ENABLED',
  'VALHALLA_KEY_STORAGE_ENABLED',
  'ZEUS_IDLE_ENABLED',
];

function isSet(env, key) {
  return typeof env[key] === 'string' && env[key].trim() !== '';
}

function validateUrl(env, key, protocols, errors) {
  if (!isSet(env, key)) return;

  try {
    const url = new URL(env[key]);
    if (!protocols.includes(url.protocol)) throw new Error('unsupported protocol');
  } catch {
    errors.push(`${key} must be a valid URL using ${protocols.join(' or ')}.`);
  }
}

export function validateEnvironment(env = process.env) {
  const errors = [];

  if (
    env.NODE_ENV === 'production' &&
    !PRODUCTION_MODEL_KEYS.some((key) => isSet(env, key))
  ) {
    errors.push(
      `Production requires at least one model provider key: ${PRODUCTION_MODEL_KEYS.join(' or ')}.`,
    );
  }

  for (const [first, second] of REQUIRED_PAIRS) {
    if (isSet(env, first) !== isSet(env, second)) {
      errors.push(`${first} and ${second} must be configured together.`);
    }
  }

  validateUrl(
    env,
    'SUPABASE_URL',
    env.NODE_ENV === 'production' ? ['https:'] : ['https:', 'http:'],
    errors,
  );
  validateUrl(
    env,
    'REDIS_URL',
    env.NODE_ENV === 'production' ? ['rediss:'] : ['redis:', 'rediss:'],
    errors,
  );
  validateUrl(env, 'UPSTASH_REDIS_REST_URL', ['https:'], errors);
  validateUrl(env, 'CLERK_MCP_URL', ['https:'], errors);

  for (const key of DISABLED_CAPABILITIES) {
    if (/^(1|true|yes|on)$/i.test(String(env[key] || '').trim())) {
      errors.push(`${key} must remain false; this runtime does not support that capability.`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }

  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  validateEnvironment();
  console.info('Environment configuration validated.');
}

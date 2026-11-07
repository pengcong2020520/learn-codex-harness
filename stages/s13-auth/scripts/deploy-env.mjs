// stdout is piped directly into SSH; never print this output or enable shell tracing.
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
const env = parseEnv(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'));
const template = parseEnv(fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
const allowed = Object.keys(template);
const values = Object.fromEntries(allowed.filter(key => key in env).map(key => [key, env[key]]));
values.AGENT_DB_PASSWORD = randomBytes(24).toString('hex');
values.AGENT_GATEWAY_KEY = `sk-bf-${randomBytes(24).toString('hex')}`;
values.CONTAINER_APP_DIR = process.argv[2];
values.AGENT_PORT = '4327';
for (const [key, value] of Object.entries(values)) {
  if (/[\r\n"\\]/.test(value)) throw new Error(`环境变量 ${key} 含不支持的字符。`);
  process.stdout.write(`${key}="${value}"\n`);
}

import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
const env = parseEnv(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'));
const url = new URL('postgresql://agent@postgres:5432/agent'); url.password = env.AGENT_DB_PASSWORD;
const [script, ...args] = process.argv.slice(2);
if (!['accounts', 'data', 'upgrade-sessions'].includes(script)) throw new Error('Unsupported maintenance command');
const child = spawn(process.execPath, [`scripts/${script}.mjs`, ...args], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.href },
});
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });

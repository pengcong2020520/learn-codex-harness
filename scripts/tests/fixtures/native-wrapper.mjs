import fs from 'node:fs';
import { spawn } from 'node:child_process';
spawn(process.env.TEST_NATIVE, [process.env.TEST_PID_FILE], { stdio: 'ignore' });
process.on('SIGTERM', () => process.exit(0));
let initialized = false;
process.stdin.on('data', chunk => { initialized ||= chunk.toString().includes('initialize'); });
setInterval(() => {
  if (initialized && process.env.TEST_REPLY === 'yes' && fs.existsSync(process.env.TEST_PID_FILE)) {
    initialized = false;
    process.stdout.write('{"id":1,"result":{"userAgent":"test"}}\n');
  }
}, 10);

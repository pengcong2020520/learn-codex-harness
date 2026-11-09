// Runs as the home owner. Leave the outer directory for the service-owned parent to unlink.
import fs from 'node:fs';
import path from 'node:path';
import { assertRealPath } from '../runtimes/directories.mjs';
const root = process.argv[2];
assertRealPath(root);
if (!/\.before-move-[a-f0-9-]{36}$/.test(root) || fs.lstatSync(root).uid !== process.getuid()) throw new Error('无效旧副本目录。');
function clear(directory) {
  fs.chmodSync(directory, (fs.statSync(directory).mode & 0o7777) | 0o700);
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    if (fs.lstatSync(file).isDirectory()) { clear(file); fs.rmdirSync(file); }
    else fs.unlinkSync(file); // Unlink scratch symlinks without following them.
  }
}
clear(root);

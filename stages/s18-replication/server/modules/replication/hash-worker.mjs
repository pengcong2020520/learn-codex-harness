// Read content as the same identity used by transfer.exportTree. No runtime tmp/ or symlinks.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [root,kind,limit]=process.argv.slice(2), hash=createHash('sha256');
let size=0;
async function walk(relative='') {
  const file=path.join(root,relative), stat=fs.lstatSync(file);
  if(stat.isSymbolicLink() || (!stat.isDirectory()&&!stat.isFile()) || (stat.isFile()&&stat.nlink!==1)) throw new Error('目录哈希拒绝链接或特殊文件。');
  if (stat.isFile() && (size+=stat.size)>Number(limit)) throw new Error('TRANSFER_TOO_LARGE');
  hash.update(JSON.stringify([relative,stat.isDirectory()?'d':'f',stat.mode&0o777,stat.uid,stat.gid,stat.isFile()?stat.size:0]));
  if(stat.isDirectory()) {
    for(const name of fs.readdirSync(file).sort()) if(relative || kind!=='home' || name!=='tmp') await walk(path.join(relative,name));
  } else for await(const bytes of fs.createReadStream(file)) hash.update(bytes);
}
await walk();process.stdout.write(hash.digest('hex'));

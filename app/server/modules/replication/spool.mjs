import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { assertRealPath } from '../runtimes/directories.mjs';
import { exportTree, transferLimit } from '../sharding/transfer.mjs';

export class ReplicationSpool {
  constructor(root, { exporter = exportTree } = {}) {
    this.root = root; this.exporter = exporter;
    this.directory = path.join(root, '.runs/replication-spool');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    assertRealPath(this.directory);
    fs.chmodSync(this.directory, 0o700);
    // Runs before workers start. A killed process can leave only disposable snapshots here.
    for (const name of fs.readdirSync(this.directory)) fs.rmSync(path.join(this.directory, name), { recursive: true, force: true });
  }
  async capture(record, token, describe, unchanged = () => false) {
    if (!/^[a-f0-9-]{36}$/.test(record.user_id) || !/^[a-f0-9-]{36}$/.test(token)) throw new Error('无效复制暂存路径。');
    // Still inside quiesce, so the hash and the later tar describe the same boundary.
    const described = await describe();
    if (unchanged(described.hash)) return { ...described, unchanged: true, close: async () => {} };
    const parent = path.join(this.directory, record.user_id), directory = path.join(parent, token);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertRealPath(parent); fs.chmodSync(parent, 0o700);
    fs.mkdirSync(directory, { mode: 0o700 });
    const close = async () => { await fs.promises.rm(directory, { recursive: true, force: true }); };
    try {
      const archives = {};
      for (const kind of ['home', 'workspace']) {
        const archive = this.exporter(this.root, record, kind, { maxBytes: transferLimit() });
        try {
          archives[kind] = path.join(directory, kind + '.tar');
          await pipeline(archive.stream, fs.createWriteStream(archives[kind], { flags: 'wx', mode: 0o600 }));
          await archive.done;
        } catch (error) { throw archive.failure?.code === 'TRANSFER_TOO_LARGE' ? archive.failure : error; }
        finally { await archive.stop(); }
      }
      return { ...described, archives, close };
    } catch (error) { await close(); throw error; }
  }
}

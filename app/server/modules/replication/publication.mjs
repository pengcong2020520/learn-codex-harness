import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { removePreviousTree } from '../sharding/transfer.mjs';

// Durable local journal: retries/restarts resolve the batch against PG's committed token.
// No await between renames; an incomplete operation remains fenced by its PG transfer row.
export class ReplicaPublication {
  constructor(root, userId, record, log = console.warn) {
    this.record = record; this.log = log;
    this.file = path.join(root, '.data/replication', userId + '.json');
    this.batch = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), {recursive:true,mode:0o700});
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.batch), {mode:0o600});
    fs.renameSync(temp, this.file);
  }
  start(token) { this.batch = {token, entries:[], publishing:false}; this.save(); }
  add(entry) {
    if (this.batch.publishing || this.batch.entries.some(e => e.target === entry.target)) throw new Error('复制条目重复或已发布。');
    this.batch.entries.push({...entry,previous:entry.target+'.before-move-'+randomUUID(),hadTarget:fs.existsSync(entry.target)});
    this.save();
  }
  publish(files) {
    const entries = this.batch.entries;
    if (!['home','workspace'].every(kind => entries.some(e=>e.kind===kind)) ||
        !files.every(file=>entries.some(e=>e.kind===file.kind && e.file===file.file))) throw new Error('复制目录或内容暂存不完整。');
    if (this.batch.publishing) return;
    this.batch.publishing = true; this.save();
    try {
      // Move old destinations aside first; then publish the two trees consecutively.
      for (const e of entries) if (e.hadTarget) fs.renameSync(e.target,e.previous);
      for (const e of entries) fs.renameSync(e.stage,e.target);
    } catch (error) { this.rollback(); throw error; }
  }
  rollback() {
    if (!this.batch?.publishing) return;
    for (const e of [...this.batch.entries].reverse()) {
      if (fs.existsSync(e.previous)) {
        if (fs.existsSync(e.target)) fs.renameSync(e.target,e.stage);
        fs.renameSync(e.previous,e.target);
      } else if (!e.hadTarget && !fs.existsSync(e.stage) && fs.existsSync(e.target)) fs.renameSync(e.target,e.stage);
    }
    this.batch.publishing = false; this.save();
  }
  async settle(committed) {
    if (!this.batch) return;
    if (!committed) this.rollback();
    for (const e of this.batch.entries) {
      for (const candidate of [e.previous,e.stage]) if (fs.existsSync(candidate)) {
        try {
          if (['home','workspace'].includes(e.kind)) {
            const disposable = candidate === e.previous ? candidate : e.previous;
            if (candidate !== disposable) fs.renameSync(candidate,disposable);
            await removePreviousTree(disposable,this.record,e.kind);
          } else fs.rmSync(candidate,{force:true});
        } catch (error) { try { this.log(`旧复制目录清理失败 code=${error.code || 'CLEANUP_FAILED'}`); } catch {} }
      }
    }
    fs.rmSync(this.file,{force:true}); this.batch = null;
  }
}

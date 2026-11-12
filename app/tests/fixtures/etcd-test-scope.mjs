import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connectEtcd } from '../../server/modules/coordination/etcd.mjs';
import { openDatabase } from '../../server/modules/data/database.mjs';

// Shared roles live at PG-cluster scope, even when the databases are isolated.
export const nodeDatabasePassword = 'app-etcd-integration-test-password';

export async function bounded(action, ms, label) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label} (${ms} ms)`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export function etcdTestScope(t, name, timeout = 60000) {
  // Stay inside the existing node ACL; never delete the shared /codex/ prefix.
  const prefix = `/codex/tests/${name}-${randomUUID()}/`;
  const actions = [];
  let phase = 'setup', closing = false;
  const progress = value => { phase = value; console.error(`[${name}] ${value}`); };
  // node:test's timeout cancels the test, but cannot kill reconnecting gRPC handles
  // or an unbounded after hook. Keep a last-resort deadline through cleanup.
  const watchdog = setTimeout(() => {
    console.error(`[${name}] hard timeout after ${timeout} ms; stuck at: ${phase}`);
    process.exit(1);
  }, timeout);
  watchdog.unref();
  const defer = (label, action) => actions.push({ label, action });
  t.after(async () => {
    closing = true;
    const errors = [];
    for (const { label, action } of actions.reverse()) {
      progress(`cleanup: ${label}`);
      try { await bounded(action, 3000, label); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `${name}: cleanup failed`);
    clearTimeout(watchdog);
    progress('cleanup complete');
  });
  const step = async (label, action) => {
    t.signal.throwIfAborted();
    if (closing) throw new Error('test is closing');
    progress(label);
    return action();
  };
  const until = async (predicate, ms = 15000) => {
    const end = Date.now() + ms;
    while (!await predicate()) {
      t.signal.throwIfAborted();
      if (closing || Date.now() >= end) throw new Error(`condition not met within ${ms} ms at: ${phase}`);
      await delay(50, undefined, { signal: t.signal });
    }
  };
  // This separate client outlives nodes/cache and deletes only this run's keys.
  let cleaner;
  defer('test prefix and cleanup client', async () => {
    if (!cleaner) return;
    try { await bounded(() => cleaner.client.delete().prefix(prefix), 2000, 'delete test prefix'); }
    finally { cleaner.client.close(); }
  });
  const connect = async (nodeId, password) => {
    if (!cleaner) cleaner = await connectEtcd(process.env.ETCD_TEST_ENDPOINT, { username: nodeId, password }, { prefix });
    const adapter = await connectEtcd(process.env.ETCD_TEST_ENDPOINT, { username: nodeId, password }, { prefix });
    defer(`${nodeId} transport`, () => adapter.client.close());
    return adapter;
  };
  return { prefix, key: suffix => prefix + suffix, defer, step, until, connect };
}

// Never reset/truncate the caller's PG database or inherit its shard/term state.
// Register teardown before CREATE so partial setup failures also close the keeper.
export async function isolatedDatabase(url, defer) {
  const keeper = await openDatabase(url, { maintenance: true });
  const database = 'app_etcd_' + randomUUID().replaceAll('-', '');
  let created = false;
  defer('temporary PG database', async () => {
    try { if (created) await keeper.query(`DROP DATABASE ${database} WITH (FORCE)`); }
    finally { await keeper.end(); }
  });
  await keeper.query(`CREATE DATABASE ${database}`);
  created = true;
  const target = new URL(url); target.pathname = '/' + database;
  return target.href;
}

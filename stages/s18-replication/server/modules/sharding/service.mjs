import { logFailure } from '../data/diagnostics.mjs';
import { ActiveService } from '../coordination/service.mjs';
import { unavailable } from './routing.mjs';
// Retains s16 generation shutdown and Rejoin ordering, but membership admits every shard primary.
export class ShardedService extends ActiveService {
  constructor(coordination, start, runtime, log) {
    // ActiveService's controller callback is harmless: activate below is idempotent per membership generation.
    super(coordination, start, log); this.runtime = runtime;
  }
  resume() {
    const activationId = this.activationId;
    this.chain = this.chain.catch(() => {}).then(() => this.activate(null, activationId)).catch(error => {
      logFailure(error, this.generation || { nodeId: this.coordination.nodeId, routes: this.runtime.cache, log: this.log }, error, '', 'activation');
      this.coordination.isolate('activation-failed');
    });
    return this.chain;
  }
  async activate(_term, activationId) {
    const c = this.coordination;
    if (!this.runtime.prepared || this.app || activationId !== this.activationId || !c.checkLease()) return;
    const epoch = c.generation;
    const generation = { active: true, get term() { return c.ownTerm ?? c.observedControl?.term ?? null; }, routes: this.runtime.cache, nodeId: c.nodeId, log: this.log,
      assert: () => { if (!generation.active || epoch !== c.generation || !c.checkLease()) throw unavailable('节点成员租约已失效。'); },
      isolate: reason => { if (generation.active) c.isolate(reason); } };
    this.generation = generation;
    try {
      this.app = await this.start(generation);
      generation.assert(); this.ready = true;
    } catch (error) {
      generation.active = false; this.ready = false;
      if (error.cleanupFailed) this.stopError = error;
      await this.app?.close().catch(failure => { this.stopError = failure; }); this.app = null; throw error;
    }
  }
  isReady() { return this.ready && this.coordination.checkLease(); }
}

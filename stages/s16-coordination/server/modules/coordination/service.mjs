import { notController } from './index.mjs';

// Each service generation captures one term. A later election cannot revive old callbacks.
export class ActiveService {
  constructor(coordination, start, log = console.error) {
    Object.assign(this, { coordination, start, log });
    this.chain = Promise.resolve(); this.ready = false; this.activationId = 0;
    coordination.on('controller', term => {
      const activationId = this.activationId;
      this.chain = this.chain.then(() => this.activate(term, activationId)).catch(error => { this.log(error.message); coordination.isolate('activation-failed'); });
    });
    coordination.on('lost', () => { void this.stop().catch(error => this.log(error.message)); });
  }
  async activate(term, activationId) {
    const c = this.coordination;
    if (activationId !== this.activationId || !c.isController() || c.term() !== term) return;
    await c.confirm();
    if (activationId !== this.activationId || !c.isController() || c.term() !== term) return;
    const generation = { active: true, term, log: this.log,
      isolate: reason => { if (generation.active) c.isolate(reason); },
      assert: () => { if (!generation.active || !c.isController() || c.term() !== term) throw notController(); } };
    this.generation = generation;
    try {
      const app = await this.start(generation);
      this.app = app;
      generation.assert();
      await c.confirm();
      await c.writeInfo();
      generation.assert(); this.ready = true;
    } catch (error) {
      generation.active = false; this.ready = false;
      if (error.cleanupFailed) this.stopError = error;
      await this.app?.close().catch(failure => { this.stopError = failure; }); this.app = null;
      throw error;
    }
  }
  isReady() { return this.ready && this.coordination.isController(); }
  stop() {
    if (this.stopError) return Promise.reject(this.stopError);
    this.activationId++; this.ready = false;
    if (this.generation) this.generation.active = false;
    this.app?.stopDispatch();
    const app = this.app; this.app = null;
    this.chain = this.chain.catch(() => {}).then(() => { if (this.stopError) throw this.stopError; return app?.close(); }).catch(error => { this.stopError = error; throw error; });
    return this.chain;
  }
}

export async function clusterStatus(coordination, accounts, authorization) {
  const identity = await accounts.authenticate(authorization);
  if (identity.role !== 'admin') throw Object.assign(new Error('需要 admin。'), { status: 403, code: 'FORBIDDEN' });
  return coordination.status();
}

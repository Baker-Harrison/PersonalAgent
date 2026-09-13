import { assignWorkerNames } from './worker-names.ts';
import { join } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ClientError, type MessageStreamEvent } from 'eve/client';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { createPi, providerId } from '../agent/lib/pi.ts';
import { selectedModel, selectedReasoning } from '../agent/lib/settings.ts';
import { reasoningChoices, reasoningForModel } from '../agent/lib/reasoning.ts';
import { ProjectStore, type Project, type Selection } from './store.ts';
import { launchRuntime, stopRuntime, type Runtime } from './runtime.ts';
import { recordDelegations, finishDelegation, workerCalled, workerEvent, steeringContext, recordActivity } from './progress.ts';

export class PersonalAgentService {
  readonly store: ProjectStore;
  private runtimes = new Map<string, Promise<Runtime>>();
  private watchers = new Map<string, AbortController>();
  private sending = new Map<string, AbortController>();
  private lifetimes = new Map<string, AbortController>();
  private watcherTasks = new Set<Promise<void>>();
  private closing = new Set<string>();
  private stopped = false;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  constructor(readonly source: string, readonly node: string, readonly directory: string, readonly changed: () => void, readonly options: { launch?: typeof launchRuntime; pollMs?: number; requestMs?: number } = {}) {
    this.store = new ProjectStore(directory);
  }
  async initialize() {
    await this.store.load();
    for (const p of this.store.projects) if (!p.removed && p.sessionId && (p.status !== 'idle' || p.workers.some(w => ['working', 'disconnected', 'blocked', 'compacting'].includes(w.status)))) {
      void this.runtime(p).catch(e => this.error(p, e));
    }
  }
  async catalog() {
    const pi = createPi();
    const models = pi.getModels(providerId).map(model => ({ id: model.id, name: model.name,
      reasoning: Object.entries(reasoningChoices).filter(([, effort]) => getSupportedThinkingLevels(model).includes(effort)).map(([label]) => label) })).filter(m => m.reasoning.length);
    let defaults: Selection = { model: models[0]?.id ?? '', reasoning: 'Light' };
    try { defaults = { model: (await selectedModel()).id, reasoning: await selectedReasoning() }; } catch {}
    const signedIn = (await pi.checkAuth(providerId))?.type === 'oauth';
    return { models, defaults, signedIn };
  }
  state() { assignWorkerNames(this.store.projects); return { projects: this.store.projects.filter(p=>!p.removed), selectedId: this.store.selectedId }; }
  private changedState() {
    if (!this.notifyTimer) this.notifyTimer = setTimeout(() => { this.notifyTimer = undefined; this.changed(); }, 16);
    if (this.stopped) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.store.save().catch(console.error); }, 100);
  }
  validate(selection: Selection) {
    const model = createPi().getModel(providerId, selection.model);
    if (!model || !Object.hasOwn(reasoningChoices, selection.reasoning)) throw new Error('Choose a supported model and reasoning level.');
    reasoningForModel(model, selection.reasoning);
  }
  async add(folder: string, coordinator: Selection, worker: Selection) {
    this.validate(coordinator); this.validate(worker);
    const p = await this.store.add(folder, coordinator, worker); this.changed(); return p;
  }
  async select(id: string) {
    const project = this.store.get(id); this.store.selectedId = id; await this.store.save(); this.changed();
    if (project.sessionId) void this.runtime(project).catch(e => this.error(project, e));
  }
  async manageWorker(id:string, workerId:string, action:'rename'|'delete', name?:string) {
    const p=this.store.get(id),w=p.workers.find(w=>w.id===workerId);if(!w)throw new Error('Worker not found.');
    const r=await this.runtime(p);
    const result=await r.client.fetch('/agents/manage',{method:'POST',body:JSON.stringify({id:w.sessionId,action,name}),headers:{'content-type':'application/json'}});
    if(!result.ok)throw new Error('Could not update worker.');
    if(action==='rename')w.displayName=name!.trim();else p.workers=p.workers.filter(w=>w.id!==workerId);
    await this.store.save();this.changed();
  }
  async browserContinue(id:string, workerId:string, restoring=false) {
    const p=this.store.get(id),w=p.workers.find(w=>w.sessionId===workerId);if(!w)return;
    if(restoring&&['done','stopped'].includes(w.status))return;
    const r=await this.runtime(p);await r.client.sessions.attach(workerId).send('The browser is available again. Observe the current page and continue the assignment, checking the outcome of any uncertain submission before repeating it.');
    w.status='working';this.watch(p,r,workerId,w.id);this.changed();
  }
  async remove(id:string) {
    const p=this.store.get(id);await this.cancel(id);await this.closeProject(p);
    p.removed=true;p.status='idle';for(const w of p.workers)if(['working','disconnected','blocked'].includes(w.status))w.status='stopped';
    if(this.store.selectedId===id)this.store.selectedId=null;
    await this.store.save();this.changed();
  }
  private async runtime(p: Project): Promise<Runtime> {
    if (this.stopped || this.closing.has(p.id)) throw new Error('The project is closing.');
    let runtime = this.runtimes.get(p.id);
    if (!runtime) {
      const previousStatus = p.status;
      const lifetime = new AbortController(); this.lifetimes.set(p.id, lifetime);
      p.status = 'starting'; this.changedState();
      runtime = (this.options.launch ?? launchRuntime)(this.source, this.node, join(this.directory, 'projects', p.id), p, lifetime.signal);
      this.runtimes.set(p.id, runtime);
      try {
        const r = await runtime;
        lifetime.signal.throwIfAborted();
        p.status = previousStatus === 'starting' ? 'idle' : previousStatus;
        p.connection = 'connected'; this.changedState();
        r.process.once('exit', () => {
          if (this.runtimes.get(p.id) !== runtime || lifetime.signal.aborted) return;
          lifetime.abort(); this.runtimes.delete(p.id); this.lifetimes.delete(p.id);
          this.sending.get(p.id)?.abort();
          this.abortWatchers(p);
          p.connection = 'offline';
          for (const w of p.workers) if (w.status === 'working') w.status = 'disconnected';
          this.error(p, new Error('The agent server stopped. Send a message to reconnect.'));
        });
        if (r.process.exitCode !== null || r.process.signalCode !== null) throw new Error('The agent server stopped during startup.');
        if (p.sessionId) this.watch(p, r, p.sessionId);
        for (const w of p.workers) if (['working', 'disconnected', 'compacting'].includes(w.status)) this.watch(p, r, w.sessionId, w.id);
      } catch (error) {
        if (this.runtimes.get(p.id) === runtime) { this.runtimes.delete(p.id); this.lifetimes.delete(p.id); }
        p.status = 'idle'; p.connection = 'offline'; throw error;
      }
    }
    return runtime;
  }
  async send(id: string, message: string, attachments: import('./store.ts').Attachment[] = []) {
    const p = this.store.get(id); message = message.trim();
    if ((!message && !attachments.length) || message.length > 100_000) throw new Error('Enter a message under 100,000 characters.');
    if (this.stopped || this.closing.has(id)) throw new Error('The project is closing.');
    if (this.sending.has(id)) throw new Error('Your previous message is still being sent.');
    const controller = new AbortController(); this.sending.set(id, controller);
    const item = { attachments, id: randomUUID(), role: 'user' as const, text: message, at: Date.now(), delivery: 'sending' as import('./store.ts').ChatMessage['delivery'] };
    p.messages.push(item); this.changedState();
    let attempted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.store.save();
      const r = await this.runtime(p); controller.signal.throwIfAborted();
      const requestMessage=message+(attachments.length?'\nAttached original files: '+JSON.stringify(attachments.map(a=>a.path)):'');
      p.status = 'thinking'; p.lastActivityAt = Date.now(); this.changedState();
      timer = setTimeout(() => controller.abort(new Error('Message delivery was not confirmed in time.')), this.options.requestMs ?? 30_000);
      attempted = true;
      if (!p.sessionId) {
        const { session } = await r.client.sessions.create({ message:requestMessage, signal: controller.signal, headers: { 'x-request-id': item.id } });
        p.sessionId = session.state.sessionId; p.cursor = 0;
      } else {
        this.watch(p, r, p.sessionId);
        await r.client.sessions.attach(p.sessionId, { streamIndex: p.cursor }).send(requestMessage,
          { turnPolicy: 'steer', clientContext: steeringContext(p), signal: controller.signal, headers: { 'x-request-id': item.id } });
      }
      // The project watcher is the only stream consumer. A separate result()
      // stream discards UI events and can outlive its runtime indefinitely.
      if (item.delivery === 'sending') item.delivery = 'accepted';
      this.watch(p, r, p.sessionId!);
    } catch (e) {
      if (item.delivery !== 'received') {
        const uncertain = attempted && !(e instanceof ClientError && e.status >= 400 && e.status < 500);
        item.delivery = uncertain ? 'uncertain' : 'failed';
        this.error(p, new Error(uncertain
          ? p.sessionId ? 'Message delivery could not be confirmed. The agent may still receive it; progress will reconnect automatically. Do not resend it yet.' : 'Message delivery could not be confirmed, and no session ID was returned. The request may have started. Do not resend it yet.'
          : e instanceof Error ? e.message : 'The message could not be sent.'));
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (this.sending.get(id) === controller) this.sending.delete(id);
      this.changedState(); await this.store.save();
    }
  }
  private error(p: Project, error: unknown) {
    p.status = 'idle';
    const text = error instanceof Error ? error.message : 'The agent could not complete this request.';
    if (p.messages.at(-1)?.text !== text) p.messages.push({ id: randomUUID(), role: 'error', text, at: Date.now() });
    this.changedState();
  }
  private watch(p: Project, r: Runtime, sessionId: string, workerId?: string) {
    if (this.watchers.has(sessionId) || this.stopped || this.closing.has(p.id)) return;
    const controller = new AbortController(); this.watchers.set(sessionId, controller);
    const worker = workerId ? p.workers.find(w => w.id === workerId) : undefined;
    const task = (async () => {
      try {
        while (!controller.signal.aborted) {
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(), this.options.requestMs ?? 30_000);
          const signal = AbortSignal.any([controller.signal, timeout.signal]);
          const priorConnection = p.connection, priorWorkerStatus = worker?.status;
          try {
            const session = r.client.sessions.attach(sessionId, { streamIndex: worker ? worker.cursor : p.cursor });
            // Replay the durable prefix, then follow live model/tool deltas.
            // Renew idle connections without declaring the agent stalled.
            for await (const event of session.stream({ signal, streamReconnectPolicy: { reconnect: false } })) {
              if (controller.signal.aborted) break;
              if (!worker) this.connection(p, r, 'connected');
              this.applyEvent(p, r, sessionId, event, worker);
              if (worker) worker.cursor++; else p.cursor++;
              // Cursor and projection are saved together. The journal is diagnostic,
              // never the source of the cursor, so replay after a crash is safe.
              await appendFile(join(r.directory, `${sessionId}.events.jsonl`), JSON.stringify(event) + '\n', { mode: 0o600 }).catch(console.error);
              this.changedState();
            }
            controller.signal.throwIfAborted();
            if (worker?.status === 'disconnected') worker.status = 'working';
            if (!worker) this.connection(p, r, 'connected');
          } catch (e) {
            if (controller.signal.aborted) break;
            if (e instanceof ClientError && [400, 401, 403, 404, 410].includes(e.status)) {
              if (worker) { worker.status = 'failed'; worker.output = 'Worker session is unavailable.'; }
              else { p.connection = 'offline'; this.error(p, e); }
              break;
            }
            if (!timeout.signal.aborted) {
              if (worker && worker.status === 'working') worker.status = 'disconnected';
              if (!worker) this.connection(p, r, 'reconnecting');
            }
          } finally { clearTimeout(timer); }
          if (p.connection !== priorConnection || worker?.status !== priorWorkerStatus) this.changedState();
          if (worker && ['done', 'stopped', 'failed', 'blocked'].includes(worker.status)) break;
          await delay(this.options.pollMs ?? (timeout.signal.aborted ? 16 : 1000), undefined, { signal: controller.signal });
        }
      } catch (e) { if (!controller.signal.aborted) this.error(p, e); }
      finally {
        if (this.watchers.get(sessionId) === controller) this.watchers.delete(sessionId);
        await this.store.save();
        if (worker?.status === 'working' && !controller.signal.aborted) this.watch(p, r, sessionId, workerId);
      }
    })();
    this.watcherTasks.add(task);
    void task.catch(console.error).finally(() => this.watcherTasks.delete(task));
  }
  private applyEvent(p: Project, r: Runtime, sessionId: string, event: MessageStreamEvent, worker?: import('./store.ts').Worker) {
    const data = ('data' in event ? event.data : {}) as any;
    const at = Date.parse(event.meta.at);
    if (worker) { if((event.type as string)==='context.compacting'){worker.status='compacting';return;} if(['context.compacted','context.failed'].includes(event.type as string)){worker.status='working';return;} workerEvent(worker, event.type, data, event.meta.id, at); return; }
    p.lastActivityAt = at;
    const type:string=event.type;
    if(type==='context.compacting'){p.status='compacting';return;}
    if(type==='context.compacted'||type==='context.failed'){p.status='thinking';return;}
    if(type==='result.attached'){p.messages.push({id:event.meta.id,role:'assistant',text:'',at,attachments:data.files});return;}
    if(type==='agent.message'){const target=p.workers.find(w=>w.sessionId===data.to);if(target){target.status='working';this.watch(p,r,target.sessionId,target.id);}return;}
    if(type==='agent.updated'){const w=p.workers.find(w=>w.sessionId===data.agentId);if(w){if(data.deleted)p.workers=p.workers.filter(item=>item!==w);else if(data.name)w.displayName=data.name;}return;}

    if (event.type === 'turn.started') { p.turnId = data.turnId; p.status = 'thinking'; }
    const current = !data.turnId || !p.turnId || p.turnId === data.turnId;
    if (current && event.type === 'step.started') p.status = 'thinking';
    if (current && ['session.waiting', 'turn.completed', 'turn.cancelled', 'session.completed'].includes(event.type) && !(event.type === 'session.waiting' && p.status === 'blocked')) p.status = 'idle';
    if (event.type === 'input.resolved' || event.type === 'authorization.completed') p.status = 'thinking';
    if (event.type === 'message.received') {
      const item = p.messages.find(m => m.role === 'user' && m.delivery && m.delivery !== 'received' && (m.id === data.turnId || m.text === data.message));
      if (item) item.delivery = 'received';
    }
    if (event.type === 'message.appended' || event.type === 'message.completed') {
      const key = `${sessionId}:${data.turnId}:${data.stepIndex}:${data.sequence ?? 0}`;
      let item = p.messages.find(m => m.id === key);
      if (!item) { item = { id: key, role: 'assistant', text: '', at }; p.messages.push(item); }
      if (event.type === 'message.completed') item.text = data.message ?? '';
      else item.text += data.messageDelta ?? '';
    }
    recordActivity(p, event.type, data, at);
    if (event.type === 'actions.requested') recordDelegations(p, data.actions || []);
    if (event.type === 'action.result') finishDelegation(p, data);
    if (event.type === 'subagent.called' && data.childSessionId) {
      const w = workerCalled(p, data, at); this.watch(p, r, w.sessionId, w.id);
    }
    if (current && (event.type === 'turn.failed' || event.type === 'session.failed')) this.error(p, new Error(data.message || 'The agent request failed. You can try again.'));
    if (event.type === 'input.requested' || event.type === 'authorization.required') {
      this.error(p, new Error('The agent is waiting for input that this app cannot submit yet. Stop this task before continuing.')); p.status = 'blocked';
    }
  }
  private connection(p: Project, r: Runtime, state: NonNullable<Project['connection']>) {
    if (p.connection === state) return;
    p.connection = state;
    void appendFile(join(r.directory, 'server.log'), JSON.stringify({ at: new Date().toISOString(), event: 'desktop.connection', state, sessionId: p.sessionId, cursor: p.cursor }) + '\n', { mode: 0o600 }).catch(console.error);
  }
  private abortWatchers(p: Project) {
    for (const id of [p.sessionId, ...p.workers.map(w => w.sessionId)]) if (id) {
      this.watchers.get(id)?.abort(); this.watchers.delete(id);
    }
  }
  async cancel(id: string) {
    const p = this.store.get(id);
    const coordinatorWasIdle = p.status === 'idle';
    this.sending.get(id)?.abort(new Error('Message sending stopped.'));
    p.status = 'stopping'; p.lastActivityAt = Date.now(); this.changedState();
    try {
      if (!p.sessionId) { await this.closeProject(p); p.status = 'idle'; return; }
      const r = await this.runtime(p);
      this.watch(p, r, p.sessionId);
      await Promise.all([p.sessionId, ...p.workers.filter(w => ['working', 'disconnected', 'blocked', 'compacting'].includes(w.status)).map(w => w.sessionId)]
        .map(async sessionId => {
          const result = await r.client.sessions.attach(sessionId).cancel({ tasks: true, signal: AbortSignal.timeout(this.options.requestMs ?? 10_000) });
          if (result.status === 'no_active_turn') {
            if (sessionId === p.sessionId) p.status = 'idle';
            else { const w = p.workers.find(w => w.sessionId === sessionId); if (w) w.status = 'stopped'; }
          }
          return result;
        }));
      // Cancelling descendants can return accepted for an already-idle parent.
      if (coordinatorWasIdle && p.status === 'stopping') p.status = 'idle';
      // Accepted cancellation is settled by streamed events; never overwrite
      // an idle state after the cancellation boundary has already arrived.
    } catch (e) { this.error(p, new Error('Could not confirm that work stopped. You can retry Stop while progress reconnects.')); p.status = 'stop-failed'; throw e; }
    finally { this.changedState(); }
  }
  private async closeProject(p: Project) {
    this.closing.add(p.id);
    this.sending.get(p.id)?.abort();
    const pending = this.runtimes.get(p.id);
    this.lifetimes.get(p.id)?.abort(); this.lifetimes.delete(p.id);
    this.abortWatchers(p);
    this.runtimes.delete(p.id);
    try {
      const r = await pending?.catch(() => undefined);
      if (!r) return;
      if (p.sessionId) {
        try { await r.client.sessions.attach(p.sessionId).cancel({ tasks: true, signal: AbortSignal.timeout(3000) }); } catch {}
      }
      stopRuntime(r.process);
      if (r.process.exitCode === null && r.process.signalCode === null) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); r.process.removeListener('exit', done); resolve(); };
        const timer = setTimeout(done, 2000); r.process.once('exit', done);
      });
    } finally { this.closing.delete(p.id); }
  }
  async shutdown() {
    this.stopped = true; clearTimeout(this.saveTimer); clearTimeout(this.notifyTimer);
    await Promise.allSettled(this.store.projects.map(async p => {
      this.abortWatchers(p); this.sending.get(p.id)?.abort();
      const r = await this.runtimes.get(p.id)?.catch(() => undefined);
      if (r?.detach) { r.detach(); this.runtimes.delete(p.id); }
      else await this.closeProject(p);
    }));
    await Promise.allSettled([...this.watcherTasks]);
    await this.store.save();
  }
}

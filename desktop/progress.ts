import type { Project, Worker, Activity } from './store.ts';

export function addProgress(w: Worker, id: string, text: string, at: number, kind: 'progress' | 'steering' = 'progress') {
  w.updates ??= [];
  if (!text || w.updates.some(u => u.id === id)) return;
  w.updates.push({ id, text, at, kind });
  w.updatedAt = at;
}

export function recordDelegations(p: Project, actions: any[]) {
  p.delegations ??= {};
  for (const a of actions) if (['worker', 'create_agent', 'send_to_agent'].includes(a.toolName) && typeof (a.input?.message ?? a.input?.task) === 'string') {
    const w = p.workers.find(w => w.id === a.input.agentId);
    p.delegations[a.callId] = { message: a.input.message ?? a.input.task, name: a.input.name, anchorMessageId: p.messages.at(-1)?.id };
    if (w) addProgress(w, a.callId, a.input.message ?? a.input.task, Date.now(), 'steering');
  }
}

// Failed dispatches remain inspectable as activity, including model-recovered retries.
export function finishDelegation(p: Project, data: any) {
  const result = data.result;
  if (!result || (data.status !== 'failed' && !result.isError && !result.output?.error)) return;
  const pending = p.delegations?.[result.callId];
  if (!pending) return;
  recordActivity(p, 'action.result', data, Date.now());
  delete p.delegations![result.callId];
}

export function workerCalled(p: Project, data: any, at: number): Worker {
  const pending = p.delegations?.[data.callId];
  let w = p.workers.find(w => w.sessionId === data.childSessionId);
  if (!w) {
    w = { id: data.agentId || data.childSessionId, sessionId: data.childSessionId, status: 'working',
      displayName: data.name, name: pending?.name, task: pending?.message || data.task || 'Working on your project', output: '', cursor: 0,
      anchorMessageId: pending?.anchorMessageId || p.messages.at(-1)?.id, startedAt: at, updatedAt: at, updates: [] };
    addProgress(w, `brief:${data.callId || data.childSessionId}`, w.task, at, 'steering');
    p.workers.push(w);
  }
  if (['done', 'stopped', 'failed'].includes(w.status) && pending?.message) {
    if (!w.updates?.some(u => u.id === data.callId)) addProgress(w, `brief:${data.callId}`, pending.message, at, 'steering');
    w.task = pending.message; w.name = pending.name; w.startedAt = at;
  }
  w.status = 'working';
  if (pending && p.delegations) delete p.delegations[data.callId];
  return w;
}

export function workerEvent(w: Worker, type: string, data: any, id: string, at: number) {
  if (type === 'turn.started') { w.status = 'working'; w.turnId = data.turnId; }
  // A superseded turn must not mark the replacement task finished or stopped.
  if (data.turnId && w.turnId && data.turnId !== w.turnId) return;
  recordActivity(w, type, data, at);
  if (type === 'actions.requested') for (const a of data.actions || []) {
    const text = a.input?.command || (a.input?.operation ? `Bash: ${a.input.operation}` : a.toolName);
    if (text) { w.output = text; addProgress(w, a.callId, text, at); }
  }
  if (type === 'message.appended' || type === 'message.completed') {
    const key = `text:${data.turnId}:${data.stepIndex}:${data.sequence}`;
    let update = w.updates?.find(u => u.id === key);
    if (!update) { addProgress(w, key, data.messageDelta || data.message || '', at); update = w.updates?.find(u => u.id === key); }
    else update.text = type === 'message.completed' ? data.message || '' : update.text + (data.messageDelta || '');
    if (update) w.output = update.text;
  }
  if (type === 'session.completed') w.status = 'done';
  if (type === 'input.requested' || type === 'authorization.required') { w.status = 'blocked'; w.output = 'Worker is waiting for input.'; addProgress(w, id, w.output, at); }
  if (type === 'turn.completed') w.status = 'done';
  if (type === 'turn.cancelled') w.status = 'stopped';
  if (type === 'turn.failed' || type === 'session.failed') { w.status = 'failed'; w.output = data.message || 'Worker failed'; addProgress(w, id, w.output, at); }
  w.updatedAt = at;
}

export function steeringContext(p: Project) {
  return {
    purpose: 'App task context. Keep pursuing the existing objective while responding to this message unless the user explicitly changes or cancels it. Ordinary questions do not stop workers. Forward relevant corrections through worker with the existing agentId.',
    workers: p.workers.slice(-6).map(w => ({ agentId: w.id, status: w.status, originalTask: w.task,
      latestUpdate: w.output.slice(-1500), steering: (w.updates || []).filter(u => u.kind === 'steering' && !u.id.startsWith('brief:')).slice(-3).map(u => u.text) })),
  };
}

function printable(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) || '';
}

export function recordActivity(owner: { activity?: Activity[] }, type: string, data: any, at: number) {
  owner.activity ??= [];
  const call = (id: string, name = 'Tool') => {
    let item = owner.activity!.find(a => a.id === `tool:${id}`);
    if (!item) { item = { id: `tool:${id}`, name, status: 'preparing', at }; owner.activity!.push(item); }
    return item;
  };
  if (type === 'action.input.appended') {
    const item = call(data.callId, data.toolName);
    if (data.toolName) item.name = data.toolName;
    item.input = (item.input || '') + (data.inputTextDelta || '');
  }
  if (type === 'actions.requested') for (const a of data.actions || []) {
    Object.assign(call(a.callId, a.toolName), { name: a.toolName, input: printable(a.input), status: 'running' });
  }
  if (type === 'action.result' && data.result?.callId) {
    Object.assign(call(data.result.callId, data.result.toolName), {
      output: printable(data.result.output), status: data.status === 'failed' || data.result.isError || data.result.output?.error ? 'failed' : 'done',
    });
  }
  if (['turn.cancelled', 'turn.failed', 'turn.completed', 'session.failed'].includes(type)) {
    for (const item of owner.activity) if (['preparing', 'running'].includes(item.status)) item.status = type === 'turn.completed' ? 'done' : type === 'turn.cancelled' ? 'stopped' : 'failed';
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'eve/client';
import { PersonalAgentService } from '../desktop/service.ts';
import type { Runtime } from '../desktop/runtime.ts';

const selection = { model: 'gpt-5.6-luna', reasoning: 'Light' as const };
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) assert.fail('Timed out waiting for state'); await delay(10); }
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'personalagent-service-'));
  const events = new Map<string, any[]>([['parent', []]]);
  const starts: number[] = [];
  let serial = 0, posts = 0, streamFailure = false, launches = 0;
  const children: (EventEmitter & { exitCode: number | null; signalCode: null })[] = [];
  const emit = (type: string, data: any = {}, session = 'parent') => {
    const list = events.get(session) ?? []; events.set(session, list);
    list.push({ type, data, meta: { id: `evt_${++serial}`, at: new Date().toISOString() } });
  };
  let onSend = async (_body: any, _res: ServerResponse) => {};
  let onCancel = async (_session: string, res: ServerResponse) => { res.end(JSON.stringify({ ok: true, status: 'no_active_turn' })); };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://localhost');
      const session = url.pathname.split('/')[4] || 'parent';
      if (url.pathname.endsWith('/stream')) {
        if (streamFailure) { res.writeHead(503); res.end('unavailable'); return; }
        const list = events.get(session) ?? [];
        const start = Number(url.searchParams.get('startIndex') ?? 0); starts.push(start);
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'x-eve-stream-version': '25', 'x-eve-stream-tail-index': String(list.length - 1) });
        res.end(list.slice(start).map(e => JSON.stringify(e) + '\n').join('')); return;
      }
      if (url.pathname.endsWith('/cancel')) { await onCancel(session, res); return; }
      if (req.method === 'POST') {
        posts++; let body = ''; for await (const part of req) body += part;
        await onSend(JSON.parse(body), res);
        if (!res.writableEnded && !res.destroyed) { res.writeHead(202); res.end(JSON.stringify({ sessionId: 'parent', deliveryId: `delivery-${posts}` })); }
        return;
      }
      res.writeHead(404); res.end();
    } catch (e) { res.destroy(e as Error); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ host: `http://127.0.0.1:${(server.address() as any).port}` });
  const service = new PersonalAgentService('.', process.execPath, dir, () => {}, {
    pollMs: 10, requestMs: 500,
    launch: async (_source, _node, directory) => {
      launches++; await mkdir(directory, { recursive: true });
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null }); children.push(child);
      return { client, directory, signature: '', process: child as ChildProcess };
    },
  });
  await service.initialize(); const p = await service.store.add(dir, selection, selection);
  return { service, p, events, emit, starts, children,
    get posts() { return posts; }, get launches() { return launches; },
    send(fn: typeof onSend) { onSend = fn; }, cancel(fn: typeof onCancel) { onCancel = fn; },
    failStream(value: boolean) { streamFailure = value; },
    async close() { for (const child of children) child.exitCode = 0; await service.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); },
  };
}

test('an idle stream keeps receiving later turns, and restart resumes the saved cursor without duplicate text', async () => {
  const f = await fixture();
  try {
    await f.service.send(f.p.id, 'hello');
    f.emit('message.received', { message: 'hello', turnId: 'one' });
    f.emit('message.completed', { message: 'Hi', turnId: 'one', stepIndex: 0, sequence: 0 });
    f.emit('session.waiting');
    await until(() => f.p.status === 'idle' && f.p.cursor === 3);
    await delay(180); // Many consecutive empty streams, beyond Eve's empty retry count.
    await f.service.send(f.p.id, 'review');
    f.emit('turn.started', { turnId: 'two' });
    f.emit('message.received', { message: 'review', turnId: 'two' });
    f.emit('message.appended', { messageDelta: 'Reviewed', turnId: 'two', stepIndex: 0, sequence: 1 });
    f.emit('session.waiting');
    await until(() => f.p.cursor === 7);
    assert.equal(f.p.status, 'idle'); assert.equal(f.p.messages.at(-1)?.text, 'Reviewed');
    assert.equal(f.p.messages.find(m => m.text === 'review')?.delivery, 'received');
    f.children[0].exitCode = 1; f.children[0].emit('exit', 1);
    assert.equal(f.p.connection, 'offline');
    await f.service.select(f.p.id);
    await until(() => f.launches === 2 && f.p.connection === 'connected');
    await delay(50);
    assert.equal(f.p.messages.filter(m => m.text === 'Reviewed').length, 1);
    assert.ok(f.starts.includes(7));
  } finally { await f.close(); }
});

test('stream failure recovers automatically from the exact saved cursor', async () => {
  const f = await fixture();
  try {
    await f.service.send(f.p.id, 'hello'); f.emit('turn.started', { turnId: 'one' });
    await until(() => f.p.cursor === 1);
    f.failStream(true); await until(() => f.p.connection === 'reconnecting');
    f.emit('message.completed', { message: 'Recovered', turnId: 'one', sequence: 0, stepIndex: 0 }); f.emit('session.waiting');
    f.failStream(false); await until(() => f.p.cursor === 3 && f.p.connection === 'connected');
    assert.equal(f.p.messages.at(-1)?.text, 'Recovered'); assert.equal(f.posts, 1);
  } finally { await f.close(); }
});

test('a hung send returns with uncertain delivery and does not resend, while late events still appear', async () => {
  const f = await fixture();
  try {
    f.service.options.requestMs = 100;
    f.p.sessionId = 'parent'; f.send(async () => { await delay(220); });
    await assert.rejects(f.service.send(f.p.id, 'slow'));
    assert.equal(f.p.messages[0].delivery, 'uncertain'); assert.equal(f.posts, 1);
    f.emit('turn.started', { turnId: 'late' }); f.emit('message.received', { message: 'slow', turnId: 'late' });
    f.emit('message.completed', { message: 'Arrived', turnId: 'late', sequence: 0, stepIndex: 0 }); f.emit('session.waiting');
    await until(() => f.p.status === 'idle' && f.p.messages[0].delivery === 'received');
    assert.equal(f.posts, 1); assert.equal(f.p.messages.at(-1)?.text, 'Arrived');
  } finally { await f.close(); }
});

test('Stop does not overwrite an already observed cancellation with stopping', async () => {
  const f = await fixture();
  try {
    await f.service.send(f.p.id, 'hello'); f.emit('turn.started', { turnId: 'one' }); await until(() => f.p.cursor === 1);
    f.cancel(async (_session, res) => {
      f.emit('turn.cancelled', { turnId: 'one' }); f.emit('session.waiting');
      await delay(40); res.end(JSON.stringify({ ok: true, status: 'accepted', sessionId: 'parent' }));
    });
    await f.service.cancel(f.p.id); assert.equal(f.p.status, 'idle');
  } finally { await f.close(); }
});

test('Stop settles idle sessions even when no new event is emitted', async () => {
  const f = await fixture();
  try { await f.service.send(f.p.id, 'hello'); await f.service.cancel(f.p.id); assert.equal(f.p.status, 'idle'); }
  finally { await f.close(); }
});

test('worker catch-up completes after parent reply and a follow-up restarts the same worker stream', async () => {
  const f = await fixture();
  try {
    await f.service.send(f.p.id, 'review');
    f.emit('actions.requested', { actions: [{ callId: 'call1', toolName: 'worker', input: { message: 'Read files' } }] });
    f.emit('subagent.called', { callId: 'call1', agentId: 'worker1', childSessionId: 'child' }); f.emit('session.waiting');
    f.emit('turn.started', { turnId: 'child1' }, 'child');
    f.emit('message.completed', { message: 'Done', turnId: 'child1' }, 'child'); f.emit('turn.completed', { turnId: 'child1' }, 'child');
    await until(() => f.p.workers[0]?.status === 'done');
    await delay(40);
    f.emit('subagent.called', { callId: 'call2', agentId: 'worker1', childSessionId: 'child' });
    f.emit('turn.started', { turnId: 'child2' }, 'child');
    f.emit('message.completed', { message: 'Done again', turnId: 'child2' }, 'child'); f.emit('turn.completed', { turnId: 'child2' }, 'child');
    await until(() => f.p.workers[0]?.output === 'Done again' && f.p.workers[0]?.status === 'done');
    assert.equal(f.p.workers.length, 1); assert.equal(f.p.workers[0].cursor, 6);
  } finally { await f.close(); }
});

test('a refused send is marked failed, and a failed Stop remains available to retry', async () => {
  const f = await fixture();
  try {
    f.p.sessionId = 'parent';
    f.send(async (_body, res) => { res.writeHead(400); res.end('Invalid message'); });
    await assert.rejects(f.service.send(f.p.id, 'refused'));
    assert.equal(f.p.messages[0].delivery, 'failed');
    f.cancel(async (_id, res) => { res.writeHead(503); res.end('Unavailable'); });
    await assert.rejects(f.service.cancel(f.p.id)); assert.equal(f.p.status, 'stop-failed');
    f.cancel(async (_id, res) => { res.end(JSON.stringify({ ok: true, status: 'no_active_turn' })); });
    await f.service.cancel(f.p.id); assert.equal(f.p.status, 'idle');
  } finally { await f.close(); }
});

test('a new service restores the transcript and catches up after an application restart', async () => {
  const f = await fixture(); let restored: PersonalAgentService | undefined;
  try {
    await f.service.send(f.p.id, 'hello');
    f.emit('message.completed', { message: 'Before restart', turnId: 'one', stepIndex: 0, sequence: 0 }); f.emit('session.waiting');
    await until(() => f.p.cursor === 2); f.children[0].exitCode = 0;
    await f.service.shutdown();
    restored = new PersonalAgentService('.', process.execPath, f.service.directory, () => {}, f.service.options);
    await restored.initialize(); await restored.select(f.p.id);
    f.emit('message.completed', { message: 'After restart', turnId: 'two', stepIndex: 0, sequence: 1 }); f.emit('session.waiting');
    const p = restored.store.get(f.p.id); await until(() => p.cursor === 4);
    assert.deepEqual(p.messages.filter(m => m.role === 'assistant').map(m => m.text), ['Before restart', 'After restart']);
  } finally {
    for (const child of f.children) child.exitCode = 0;
    await restored?.shutdown(); await f.close();
  }
});

test('Stop settles an idle coordinator when only its background worker was active', async () => {
  const f = await fixture();
  try {
    await f.service.send(f.p.id, 'work');
    f.emit('subagent.called', { callId: 'call', agentId: 'worker', childSessionId: 'child' });
    f.emit('session.waiting'); f.emit('turn.started', { turnId: 'run' }, 'child');
    await until(() => f.p.status === 'idle' && f.p.workers[0]?.status === 'working');
    f.cancel(async (id, res) => {
      if (id === 'child') f.emit('turn.cancelled', { turnId: 'run' }, 'child');
      res.end(JSON.stringify({ ok: true, status: 'accepted', sessionId: id }));
    });
    await f.service.cancel(f.p.id);
    await until(() => f.p.workers[0]?.status === 'stopped');
    assert.equal(f.p.status, 'idle');
  } finally { await f.close(); }
});

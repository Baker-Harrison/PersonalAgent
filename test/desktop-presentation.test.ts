import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore, type Project } from '../desktop/store.ts';
import { recordActivity, recordDelegations, workerCalled, workerEvent } from '../desktop/progress.ts';
import { linkTarget } from '../desktop/links.ts';
const choice = { model: 'gpt-5.6-luna', reasoning: 'Light' as const };
const project = (): Project => ({ id: 'p', name: 'Project', folder: '/tmp', coordinator: choice, worker: choice, messages: [], workers: [], cursor: 0, status: 'idle', createdAt: 0 });

test('legacy tool and worker messages migrate without losing conversation or duplicating activity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-migrate-'));
  try {
    const p = project(); p.messages = [{ id: 'u', role: 'user', text: 'Review', at: 1 }, { id: 'tool:a', role: 'tool', text: 'create_agent', toolStatus: 'done', at: 2 }, { id: 'card', role: 'worker', text: '', at: 3 }, { id: 'reply', role: 'assistant', text: 'Reviewed', at: 4 }];
    await writeFile(join(dir, 'projects.json'), JSON.stringify({ projects: [p], selectedId: 'p' }));
    const store = new ProjectStore(dir); await store.load(); await store.save(); await store.load();
    assert.deepEqual(store.projects[0].messages.map(m => m.id), ['u', 'reply']);
    assert.equal(store.projects[0].activity?.length, 1);
    assert.equal(store.projects[0].activity?.[0].status, 'done');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('activity retains streamed inputs, full results, task names and cancellation outside chat', () => {
  const p = project();
  recordActivity(p, 'action.input.appended', { callId: 'a', toolName: 'create_agent', inputTextDelta: '{' }, 1);
  recordActivity(p, 'actions.requested', { actions: [{ callId: 'a', toolName: 'create_agent', input: { task: 'Review files', name: 'Review navigation' } }] }, 2);
  recordDelegations(p, [{ callId: 'a', toolName: 'create_agent', input: { task: 'Review files', name: 'Review navigation' } }]);
  const w = workerCalled(p, { callId: 'a', childSessionId: 'child' }, 3);
  assert.equal(w.name, 'Review navigation'); assert.equal(p.messages.length, 0);
  workerEvent(w, 'turn.started', { turnId: 'run' }, 'start', 4);
  workerEvent(w, 'actions.requested', { turnId: 'run', actions: [{ callId: 'b', toolName: 'bash', input: { command: 'cat README.md' } }] }, 'request', 5);
  const output = 'result\n'.repeat(1000);
  workerEvent(w, 'action.result', { turnId: 'run', result: { callId: 'b', output }, status: 'completed' }, 'result', 6);
  assert.equal(w.activity?.[0].output, output); assert.equal(w.activity?.[0].status, 'done');
  recordActivity(p, 'turn.cancelled', {}, 7); assert.equal(p.activity?.[0].status, 'stopped');
});

test('collapsed activity prioritizes blocked, disconnected and failed states over routine work', async () => {
  const { activitySummary } = await import('../desktop/ui/presentation.js' as string);
  const p = project(); p.status = 'thinking'; assert.equal(activitySummary(p), 'Working on your reply');
  p.status = 'blocked'; assert.match(activitySummary(p), /attention/);
  p.connection = 'offline'; assert.match(activitySummary(p), /Disconnected/);
  p.status = 'stop-failed'; assert.match(activitySummary(p), /Stop not confirmed/);
  p.status = 'idle'; p.connection = 'connected'; p.activity = [{ id: 'a', name: 'bash', at: 1, status: 'failed' }]; assert.match(activitySummary(p), /attention/);
});

test('streaming markdown preserves unfinished code and separates paragraphs', async () => {
  const { blocks } = await import('../desktop/ui/presentation.js' as string);
  assert.deepEqual(blocks('Hello\n\n```js\nconst x = 1;'), [{ type: 'text', text: 'Hello' }, { type: 'code', text: 'const x = 1;', language: 'js' }]);
  assert.equal(blocks('Hello\n\n```js\nconst x = 1;\n```\n\nDone').length, 3);
});

test('a compacting worker keeps visible progress while the coordinator is idle',async()=>{
  const {isBusy,progressState}=await import('../desktop/ui/presentation.js' as string);
  const p=project();p.workers=[{id:'w',sessionId:'s',displayName:'Maple',status:'compacting',task:'Build',output:'',cursor:0}];
  assert.equal(isBusy(p),true);assert.equal(progressState(p).spinning,true);assert.match(progressState(p).text,/Organizing conversation/);
});

test('links permit web and project files but cannot launch custom protocols or commands', () => {
  assert.deepEqual(linkTarget('https://example.com/a', '/tmp'), { url: 'https://example.com/a' });
  assert.deepEqual(linkTarget('docs/README.md:12', '/project'), { path: '/project/docs/README.md' });
  assert.deepEqual(linkTarget('file:///tmp/My%20Result.html', '/project'), {path:'/tmp/My Result.html'});
  for (const link of ['javascript:alert(1)', 'file://remote-host/result.html', 'vscode:command', '//evil.example', 'https://user:secret@example.com']) assert.throws(() => linkTarget(link, '/tmp'));
});

test('worker names are unique across projects, survive saving, and handle pool exhaustion', async () => {
  const { assignWorkerNames, workerNames } = await import('../desktop/worker-names.ts');
  const dir = await mkdtemp(join(tmpdir(), 'worker-names-'));
  try {
    const store = new ProjectStore(dir), a = project(), b = { ...project(), id: 'b', workers: [] as Project['workers'] };
    for (let i = 0; i < workerNames.length + 5; i++) (i % 2 ? a : b).workers.push({ id: `w${i}`, sessionId: `s${i}`, status: 'working', task: 'Check files', output: '', cursor: 0 });
    store.projects = [a, b]; assignWorkerNames(store.projects);
    const names = store.projects.flatMap(p => p.workers.map(w => w.displayName));
    assert.equal(new Set(names).size, names.length);
    await store.save(); await store.load();
    assert.deepEqual(store.projects.flatMap(p => p.workers.map(w => w.displayName)), names);
    const w = store.projects[0].workers[0];
    workerCalled(store.projects[0], { childSessionId: w.sessionId }, 5);
    assert.equal(w.displayName, names[0]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

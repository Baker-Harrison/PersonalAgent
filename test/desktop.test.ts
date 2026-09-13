import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProjectStore } from '../desktop/store.ts';
import { prepareRuntime, launchRuntime } from '../desktop/runtime.ts';
const selection = { model: 'gpt-5.6-luna', reasoning: 'Light' as const };
test('a runtime killed by a signal reports startup failure promptly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'personalagent-crash-'));
  try {
    const store = new ProjectStore(join(dir, 'state')); await store.load();
    const project = await store.add(dir, selection, selection);
    const binary = join(dir, 'crash'); await writeFile(binary, '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 });
    const start = Date.now();
    await assert.rejects(launchRuntime(resolve('.'), binary, join(dir, 'runtime'), project), /could not start/);
    assert.ok(Date.now() - start < 5000, 'Signal exits must not wait for the startup timeout');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('projects keep folder names, deduplicate paths, and persist independent model choices and chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'personalagent-store-'));
  try {
    const folder = join(dir, 'My project'); await mkdir(folder);
    const store = new ProjectStore(join(dir, 'state')); await store.load();
    const p = await store.add(folder, selection, { ...selection, reasoning: 'High' });
    p.messages.push({ id: 'm1', role: 'user', text: 'Remember this project', at: 1 });
    p.removed=true;await store.save(); await store.add(join(folder, '.'), selection, selection);assert.equal(p.removed,false);
    const restored = new ProjectStore(store.directory); await restored.load();
    assert.equal(restored.projects.length, 1); assert.equal(restored.projects[0].name, 'My project');
    assert.equal(restored.projects[0].worker.reasoning, 'High');
    assert.equal(restored.projects[0].messages[0].text, 'Remember this project');
    assert.equal(restored.selectedId, p.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('desktop workers use the exact existing Bash tool and adapter, with separate model selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'personalagent-runtime-'));
  try {
    const store = new ProjectStore(join(dir, 'state')); await store.load();
    const p = await store.add(dir, selection, { ...selection, reasoning: 'High' });
    const runtime = join(dir, 'runtime'); await prepareRuntime(resolve('.'), runtime, p);
    const config = JSON.parse(await readFile(join(runtime, 'engine-config.json'), 'utf8'));
    assert.ok(config.workerInstructions.startsWith(await readFile('agent/instructions.md', 'utf8')));
    assert.equal(config.project.worker.reasoning, 'High');
    await mkdir(join(runtime, '.eve'), { recursive: true });
    await prepareRuntime(resolve('.'), runtime, p);
    assert.equal((await import('node:fs')).existsSync(join(runtime, '.eve')), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker progress retains delegation and steering across restoration, ignoring stale completion', async () => {
  const { recordDelegations, workerCalled, workerEvent, steeringContext } = await import('../desktop/progress.ts');
  const dir = await mkdtemp(join(tmpdir(), 'personalagent-progress-'));
  try {
    const store = new ProjectStore(join(dir, 'state')); await store.load();
    const p = await store.add(dir, selection, selection);
    p.messages.push({ id: 'request', role: 'user', text: 'Build the feature', at: 1 });
    recordDelegations(p, [{ toolName: 'worker', callId: 'launch', input: { message: 'Build and test the feature' } }]);
    p.messages.push({ id: 'later', role: 'user', text: 'A question sent while the worker starts', at: 2 });
    await store.save();
    const restored = new ProjectStore(store.directory); await restored.load();
    const project = restored.get(p.id);
    const w = workerCalled(project, { callId: 'launch', agentId: 'agent1', childSessionId: 'child1' }, 2);
    assert.equal(w.task, 'Build and test the feature'); assert.equal(w.anchorMessageId, 'request');
    assert.deepEqual(project.messages.map(m => m.id), ['request', 'later']);
    assert.ok(project.messages.every(m => m.role !== 'worker'));
    workerEvent(w, 'turn.started', { turnId: 'old' }, 'e1', 3);
    recordDelegations(project, [{ toolName: 'worker', callId: 'steer', input: { agentId: 'agent1', message: 'Keep the feature, use green instead of blue' } }]);
    assert.equal(workerCalled(project, { callId: 'steer', agentId: 'agent1', childSessionId: 'child1' }, 4), w);
    workerEvent(w, 'turn.started', { turnId: 'new' }, 'e2', 5);
    workerEvent(w, 'turn.completed', { turnId: 'old' }, 'e3', 6);
    assert.equal(w.status, 'working');
    workerEvent(w, 'actions.requested', { turnId: 'new', actions: [{ callId: 'bash1', toolName: 'bash', input: { command: 'npm test' } }] }, 'e4', 7);
    workerEvent(w, 'actions.requested', { turnId: 'new', actions: [{ callId: 'bash1', toolName: 'bash', input: { command: 'npm test' } }] }, 'e4', 7);
    assert.equal(w.updates?.filter(u => u.id === 'bash1').length, 1);
    assert.equal(steeringContext(project).workers[0].originalTask, 'Build and test the feature');
    assert.deepEqual(steeringContext(project).workers[0].steering, ['Keep the feature, use green instead of blue']);
    workerEvent(w, 'turn.completed', { turnId: 'new' }, 'e5', 8);
    assert.equal(w.status, 'done'); assert.equal(project.workers.length, 1);
    assert.deepEqual(project.messages.map(m => m.id), ['request', 'later']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('startup can be cancelled even when the health endpoint never responds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'personalagent-health-hang-'));
  try {
    const store = new ProjectStore(join(dir, 'state')); await store.load();
    const p = await store.add(dir, selection, selection);
    const binary = join(dir, 'hang');
    await writeFile(binary, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const start = Date.now();
    await assert.rejects(launchRuntime(resolve('.'), binary, join(dir, 'runtime'), p, AbortSignal.timeout(500)));
    assert.ok(Date.now() - start < 2000, 'A hung health check must not trap shutdown');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed dispatch is visible while successful delegation stays outside chat', async () => {
  const { recordDelegations, finishDelegation, workerCalled } = await import('../desktop/progress.ts');
  const p = { messages: [], workers: [], delegations: {} } as unknown as import('../desktop/store.ts').Project;
  recordDelegations(p, [{ callId: 'good', toolName: 'worker', input: { message: 'Review' } }]);
  finishDelegation(p, { status: 'completed', result: { callId: 'good', output: { status: 'working' } } });
  assert.ok(p.delegations?.good);
  workerCalled(p, { callId: 'good', childSessionId: 'child', agentId: 'worker' }, 1);
  assert.equal(p.workers[0].id, 'worker');
  assert.equal(p.messages.length, 0);
  recordDelegations(p, [{ callId: 'bad', toolName: 'worker', input: { message: 'Review' } }]);
  finishDelegation(p, { status: 'completed', result: { callId: 'bad', isError: true, output: 'AGENT_BUSY' } });
  assert.equal(p.messages.length, 0); assert.equal(p.activity?.at(-1)?.status, 'failed'); assert.equal(p.delegations?.bad, undefined);
});

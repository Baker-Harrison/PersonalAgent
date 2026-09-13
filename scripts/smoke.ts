import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, type ClientSessionState, type MessageStreamEvent } from 'eve/client';

// Opt-in live checks. These use the selected ChatGPT subscription and consume its allowance.
const client = new Client({ host: process.env.EVE_PI_URL ?? 'http://127.0.0.1:2000' });
const mode = process.argv[2] ?? 'tools';
const statePath = '.eve/smoke-session.json';
const evidencePath = '.eve/smoke-evidence.json';
const signal = AbortSignal.timeout(120_000);
await client.health();
await mkdir('.eve', { recursive: true });

function verify(events: MessageStreamEvent[]) {
  const failure = events.find(e => ['turn.failed', 'session.failed', 'step.failed'].includes(e.type));
  assert.equal(failure, undefined, failure ? JSON.stringify(failure) : undefined);
}

if (mode === 'tools') {
  const marker = `marigold-${randomUUID().slice(0, 8)}`;
  const filePath = resolve('.eve', `smoke-${randomUUID()}.txt`);
  const { session, response } = await client.sessions.create({ message: `Remember this test marker: ${marker}. Use Bash to create ${filePath} with exactly alpha, read it, replace alpha with beta, then print only the final file contents. Use shell commands for the whole file round trip.`, signal });
  const result = await response.result();
  verify(result.events);
  const toolEvents = result.events.filter(e => e.type === 'action.result' && e.data.result.kind === 'tool-result');
  for (const name of ['bash']) {
    assert.ok(toolEvents.some(e => e.type === 'action.result' && e.data.result.kind === 'tool-result' && e.data.result.toolName === name && e.data.status === 'completed'), `Missing successful ${name}`);
  }
  const shell = [...toolEvents].reverse().find(e => e.type === 'action.result' && e.data.result.kind === 'tool-result' && e.data.result.toolName === 'bash');
  assert.ok(shell && shell.type === 'action.result' && shell.data.result.kind === 'tool-result');
  const output = shell.data.result.output as { stdout: string; exitCode: number };
  assert.equal(output.exitCode, 0);
  assert.equal(output.stdout.trim(), 'beta');
  assert.equal(await readFile(filePath, 'utf8'), 'beta', 'Expected the edited file on the host filesystem');
  assert.ok(result.events.some(e => e.type === 'message.appended'), 'Expected streamed text');
  await writeFile(statePath, JSON.stringify({ ...session.state, marker }));
  await writeFile(evidencePath, JSON.stringify({ sessionId: result.sessionId, tools: { passed: true, filePath, answer: result.message, events: result.events } }, null, 2));
  console.log('PASS: Bash file round trip', result.message);
} else {
  const saved = JSON.parse(await readFile(statePath, 'utf8')) as ClientSessionState & { marker: string };
  let session = client.sessions.attach(saved.sessionId, { streamIndex: saved.streamIndex });
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  if (mode === 'resume') {
    const result = await (await session.send('What test marker did I ask you to remember? Reply with just the marker.', { signal })).result();
    verify(result.events);
    assert.ok(result.message?.includes(saved.marker), 'Session did not remember marker after restart');
    evidence.resume = { passed: true, answer: result.message };
    console.log('PASS: resumed session remembers marker');
  } else if (mode === 'compact') {
    // A prior failed check may have left a waiting event after the saved cursor.
    const snapshot = await session.snapshot({ signal });
    session = client.sessions.attach(saved.sessionId, { streamIndex: snapshot.session.streamIndex });
    const outcome = await session.compact();
    assert.equal(outcome.status, 'accepted');
    const events: MessageStreamEvent[] = [];
    for await (const event of session.stream({ signal })) {
      events.push(event);
      if (['session.waiting', 'session.failed'].includes(event.type)) break;
    }
    verify(events);
    assert.ok(events.some(e => e.type === 'compaction.completed'), 'Compaction did not finish');
    const result = await (await session.send('What is the test marker? Reply with just the marker.', { signal })).result();
    verify(result.events);
    assert.ok(result.message?.includes(saved.marker), 'Compaction lost the marker');
    evidence.compaction = { passed: true, answer: result.message };
    console.log('PASS: subscription compaction and follow-up recall');
  } else throw new Error('Use tools, resume, or compact');
  await writeFile(statePath, JSON.stringify({ ...session.state, marker: saved.marker }));
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
}

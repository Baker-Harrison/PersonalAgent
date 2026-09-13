import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bash from '../agent/tools/bash.ts';

let commandLogs: string;
const originalWorkdir = process.env.EVE_PI_WORKDIR;
before(async () => { commandLogs = await mkdtemp(join(tmpdir(), 'eve-host-logs-')); process.env.EVE_PI_WORKDIR = commandLogs; });
after(async () => { if (originalWorkdir === undefined) delete process.env.EVE_PI_WORKDIR; else process.env.EVE_PI_WORKDIR = originalWorkdir; await rm(commandLogs, { recursive: true, force: true }); });

const ctx = { session: { id: 'host-tool-tests' } } as Parameters<typeof bash.execute>[1];
test('Bash runs on the host, respects cwd, and reports nonzero status', async () => {
  const result = await bash.execute({ command: 'pwd; uname -s; exit 7', workingDirectory: '/private/tmp', maxRuntimeMs: 10000, waitMs: 1000 }, ctx) as { stdout: string; exitCode: number };
  assert.match(result.stdout, /\/private\/tmp/);
  assert.match(result.stdout, /Darwin/);
  assert.equal(result.exitCode, 7);
});
test('Bash terminates long commands on timeout', async () => {
  const result = await bash.execute({ command: 'sleep 20', maxRuntimeMs: 100, waitMs: 1000 }, ctx) as { timedOut: boolean; exitCode: number | null };
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});
test('Bash propagates cancellation', async () => {
  const controller = new AbortController();
  const pending = bash.execute({ command: 'sleep 20', maxRuntimeMs: 10000, waitMs: 1000 }, { session: { id: 'host-tool-tests' }, abortSignal: controller.signal } as Parameters<typeof bash.execute>[1]);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(async () => pending, { name: 'AbortError' });
});

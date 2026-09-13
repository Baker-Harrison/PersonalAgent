import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { localPath } from './local-files.ts';

const LOG_LIMIT = 16 * 1024 * 1024;
const TAIL_LIMIT = 4096;
type Entry = {
  id: string; owner: string; child: ChildProcess; cwd: string; directory: string;
  stdout: Buffer; stderr: Buffer; bytes: [number, number]; retained: [number, number];
  fds: [number, number]; closed: boolean; exitCode: number | null; signal: string | null;
  exited: boolean; error?: string; reason?: 'timeout' | 'cancelled' | 'stopped';
  timer?: ReturnType<typeof setTimeout>; stopPromise?: Promise<void>; ended: boolean;
  detachAbort?: () => void;
};
const key = Symbol.for('eve-pi.managed-processes.v1');
const globals = globalThis as unknown as Record<symbol, Map<string, Entry> | undefined>;
const entries = globals[key] ??= new Map<string, Entry>();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function groupAlive(e: Entry): boolean {
  if (e.ended || !e.child.pid) return false;
  try { process.kill(-e.child.pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
  // A reaped leader may leave children. Ignore zombies, which cannot run or hold ports.
  return execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' }).split('\n').some(line => {
    const [pgid, state] = line.trim().split(/\s+/);
    return Number(pgid) === e.child.pid && state && !state.startsWith('Z');
  });
}
function finish(e: Entry) {
  e.ended = true;
  clearTimeout(e.timer);
  e.detachAbort?.();
}
function save(e: Entry) {
  try { writeFileSync(join(e.directory, 'status.json'), JSON.stringify({ processId: e.id, pid: e.child.pid,
    workingDirectory: e.cwd, exitCode: e.exitCode, signal: e.signal, reason: e.reason,
    state: e.ended ? 'exited' : 'running', bytes: e.bytes, retainedBytes: e.retained,
    error: e.error }, null, 2), { mode: 0o600 }); } catch (error) { e.error = `Cannot persist process status: ${String(error)}`; }
}
function result(e: Entry) {
  if (e.exited && !groupAlive(e)) finish(e);
  save(e);
  return { processId: e.id, state: e.ended ? 'exited' : 'running', exitCode: e.exited ? e.exitCode : null,
    signal: e.signal, timedOut: e.reason === 'timeout', cancelled: e.reason === 'cancelled',
    stopRequested: e.reason !== undefined, error: e.error,
    stdout: e.stdout.toString('utf8'), stderr: e.stderr.toString('utf8'), workingDirectory: e.cwd,
    stdoutPath: join(e.directory, 'stdout.log'), stderrPath: join(e.directory, 'stderr.log'),
    outputBytes: { stdout: e.bytes[0], stderr: e.bytes[1] },
    truncated: e.bytes[0] > TAIL_LIMIT || e.bytes[1] > TAIL_LIMIT,
    logTruncated: e.bytes.some((n, i) => n > e.retained[i]), logLimitBytesPerStream: LOG_LIMIT };
}
function owned(id: string, owner: string) {
  const e = entries.get(id);
  if (!e || e.owner !== owner) throw new Error('Process not found in this session. After a harness restart, old process IDs cannot be controlled; inspect retained logs and start a new command.');
  return e;
}
async function terminate(e: Entry, reason: NonNullable<Entry['reason']>) {
  if (e.stopPromise) return e.stopPromise;
  e.reason ??= reason;
  e.stopPromise = (async () => {
    if (e.exited && !groupAlive(e)) { finish(e); return; }
    const signal = (name: NodeJS.Signals) => {
      if (!e.child.pid || e.ended) return;
      try { process.kill(-e.child.pid, name); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    signal('SIGTERM');
    for (let i = 0; i < 20 && groupAlive(e); i++) await delay(25);
    if (groupAlive(e)) signal('SIGKILL');
    for (let i = 0; i < 40 && groupAlive(e); i++) await delay(25);
    if (groupAlive(e)) throw new Error('Process group is still alive after termination. Cleanup is unverified.');
    // Let Node collect the actual exit status and flush pipe data.
    for (let i = 0; i < 40 && !e.closed; i++) await delay(10);
    finish(e); save(e);
  })();
  return e.stopPromise;
}
export async function runManaged(input: { command: string; workingDirectory?: string; timeoutMs: number; waitMs: number }, owner: string, abortSignal?: AbortSignal) {
  abortSignal?.throwIfAborted();
  const id = randomUUID();
  const directory = localPath(join('.eve', 'command-logs', createHash('sha256').update(owner).digest('hex').slice(0, 24), id));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const first = openSync(join(directory, 'stdout.log'), 'wx', 0o600);
  let second: number;
  try { second = openSync(join(directory, 'stderr.log'), 'wx', 0o600); } catch (error) { closeSync(first); throw error; }
  const fds: [number, number] = [first, second];
  const cwd = localPath(input.workingDirectory);
  const child = spawn('/bin/bash', ['-lc', input.command], { cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const e: Entry = { id, owner, child, cwd, directory, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), bytes: [0, 0], retained: [0, 0], fds, closed: false, exitCode: null, signal: null, exited: false, ended: false };
  entries.set(id, e);
  const consume = (i: 0 | 1, chunk: Buffer) => {
    e.bytes[i] += chunk.length;
    const keep = chunk.subarray(0, Math.max(0, LOG_LIMIT - e.retained[i]));
    try {
      let offset = 0;
      while (offset < keep.length) { const written = writeSync(fds[i], keep, offset, keep.length - offset); if (!written) throw new Error('Log write made no progress.'); offset += written; e.retained[i] += written; }
    } catch (error) { e.error = `Cannot persist command output: ${String(error)}`; void terminate(e, 'stopped').catch(failure => { e.error += `; ${String(failure)}`; }); }
    const name = i === 0 ? 'stdout' : 'stderr';
    e[name] = Buffer.concat([e[name], chunk]).subarray(-TAIL_LIMIT);
  };
  child.stdout!.on('data', (chunk: Buffer) => consume(0, chunk));
  child.stderr!.on('data', (chunk: Buffer) => consume(1, chunk));
  child.on('error', error => { e.error = error.message; e.exited = true; finish(e); });
  child.on('exit', (code, signal) => { e.exited = true; e.exitCode = code; e.signal = signal; });
  child.on('close', () => { e.closed = true; for (const fd of fds) closeSync(fd); if (!groupAlive(e)) finish(e); save(e); });
  const abort = () => { void terminate(e, 'cancelled').catch(error => { e.error = String(error); save(e); }); };
  abortSignal?.addEventListener('abort', abort, { once: true });
  e.detachAbort = () => abortSignal?.removeEventListener('abort', abort);
  e.timer = setTimeout(() => { void terminate(e, 'timeout').catch(error => { e.error = String(error); save(e); }); }, input.timeoutMs);
  e.timer.unref();
  if (abortSignal?.aborted) abort();
  const until = Date.now() + input.waitMs;
  while (!e.closed && Date.now() < until && !e.reason) await delay(25);
  if (e.reason) await e.stopPromise;
  abortSignal?.throwIfAborted();
  return result(e);
}
export async function inspectManaged(id: string, owner: string, waitMs = 0) {
  const e = owned(id, owner);
  const until = Date.now() + waitMs;
  while (!e.ended && !e.closed && Date.now() < until) await delay(25);
  return result(e);
}
export async function stopManaged(id: string, owner: string) {
  const e = owned(id, owner);
  await terminate(e, 'stopped');
  return result(e);
}
// Best-effort cleanup of owned groups on a normal Node exit; never touch arbitrary PIDs.
if (!(globalThis as any)[Symbol.for('eve-pi.process-exit-hook')]) {
  (globalThis as any)[Symbol.for('eve-pi.process-exit-hook')] = true;
  process.once('exit', () => { for (const e of entries.values()) if (!e.ended && e.child.pid) { try { process.kill(-e.child.pid, 'SIGKILL'); } catch {} } });
}

import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { runManaged, inspectManaged, stopManaged } from '../lib/managed-processes.ts';

function compact(result: Awaited<ReturnType<typeof runManaged>>, details = false) {
  const out: Record<string, unknown> = { state: result.state, exitCode: result.exitCode };
  if (result.state === 'running' || details) out.processId = result.processId;
  for (const stream of ['stdout', 'stderr'] as const) {
    const text = result[stream];
    if (text && result.outputBytes[stream] <= 1000) out[stream] = text;
    if (details || result.outputBytes[stream] > 1000) out[`${stream}Path`] = result[`${stream}Path`];
  }
  if (result.outputBytes.stdout > 1000 || result.outputBytes.stderr > 1000) out.truncated = true;
  if (result.logTruncated) out.logTruncated = true;
  if (result.error) out.error = result.error;
  if (result.signal) out.signal = result.signal;
  if (result.timedOut) out.timedOut = true;
  if (result.cancelled) out.cancelled = true;
  return out;
}
export default defineTool({
  description: 'Run Bash on this Mac. Default operation=run; commands still active after waitMs return a processId. Use operation=status, stop, or logs with that ID. Start servers in foreground; stop kills their process group. Output over 1000 bytes is returned as a saved log path; search that file. Logs retain 16 MiB/stream. waitMs only controls the return delay (default 1000); maxRuntimeMs kills the command at its lifetime limit (default 120000). Handles belong to this session and expire on harness restart.',
  inputSchema: z.object({
    command: z.string().min(1).optional(),
    operation: z.enum(['run', 'status', 'stop', 'logs']).optional(),
    processId: z.string().uuid().optional(),
    workingDirectory: z.string().optional(),
    maxRuntimeMs: z.number().int().min(1).max(600000).optional(),
    waitMs: z.number().int().min(0).max(10000).optional(),
  }),
  async execute(input, ctx) {
    const operation = input.operation ?? 'run';
    if (operation === 'run') {
      if (!input.command || input.processId) throw new Error('run requires command and no processId.');
      return compact(await runManaged({ command: input.command, workingDirectory: input.workingDirectory, timeoutMs: input.maxRuntimeMs ?? 120000, waitMs: input.waitMs ?? 1000 }, ctx.session.id, ctx.abortSignal));
    }
    if (!input.processId || input.command) throw new Error('status, stop, and logs require processId, without command.');
    return compact(operation === 'stop' ? await stopManaged(input.processId, ctx.session.id) : await inspectManaged(input.processId, ctx.session.id, input.waitMs ?? 0), operation === 'logs');
  },
});

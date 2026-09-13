import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, type MessageStreamEvent } from 'eve/client';

// Opt-in integration check: exercises the actual model and host runtime, using subscription allowance.
const client = new Client({ host: process.env.EVE_PI_URL ?? 'http://127.0.0.1:2000' });
const signal = AbortSignal.timeout(600_000);
const marker = randomUUID();
const path = resolve('.eve', `runtime-${marker}`);
const command = `set -eu
mkdir -p ${path}
cd ${path}
node --version
npm --version
npx --version
git --version
npm init -y >/dev/null
npm install --save-exact is-number@7.0.0 --no-audit --no-fund
node -e 'if (!require("is-number")(42)) process.exit(1)'
printf '${marker}' > marker.txt
git init -q
git add package.json package-lock.json marker.txt
git -c user.name='Host Test' -c user.email='host@example.invalid' commit -qm 'Verify host commands'
git rev-parse --verify HEAD
node -e 'console.log("HOST_RUNTIME_OK")'`;
async function check(events: MessageStreamEvent[], expected: string) {
  assert.ok(!events.some(e => ['turn.failed', 'session.failed', 'step.failed'].includes(e.type)), 'Agent failed');
  const outputs = events.flatMap(e => e.type === 'action.result' && e.data.result.kind === 'tool-result' && e.data.result.toolName === 'bash'
    ? [e.data.result.output as { stdout?: string; stderr?: string; stdoutPath?: string; exitCode: number }] : []);
  const text = await Promise.all(outputs.map(async o => o.stdout ?? (o.stdoutPath ? await readFile(o.stdoutPath, 'utf8') : '')));
  assert.ok(outputs.some((o, i) => o.exitCode === 0 && text[i].includes(expected)), `No successful Bash output containing ${expected}`);
  return outputs;
}
const { session, response } = await client.sessions.create({
  message: `Use bash to run this exact command on this Mac. Report its actual result.\n\n${command}`, signal,
});
const first = await response.result();
const commands = await check(first.events, 'HOST_RUNTIME_OK');
const second = await (await session.send(`Use bash to run: cat ${path}/marker.txt && cd ${path} && git status --porcelain --untracked-files=no`, { signal })).result();
const persistence = await check(second.events, marker);
await mkdir('.eve', { recursive: true });
await writeFile('.eve/host-smoke-evidence.json', JSON.stringify({ sessionId: first.sessionId, path, commands, persistence, events: [...first.events, ...second.events] }, null, 2));
console.log('PASS: Node, npm install, npx, Git commit, and filesystem persistence across turns');

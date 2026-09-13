import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchRuntime, stopRuntime } from '../desktop/runtime.ts';
import { ProjectStore } from '../desktop/store.ts';

// Boot the shipped server with the shipped Node and dependencies. No model request.
const source = resolve(process.argv[2]);
const directory = await mkdtemp(join(tmpdir(), 'personalagent-package-check-'));
let runtime: Awaited<ReturnType<typeof launchRuntime>> | undefined;
try {
  const store = new ProjectStore(join(directory, 'state'));
  await store.load();
  const choice = { model: 'gpt-5.6-luna', reasoning: 'Light' as const };
  const project = await store.add(directory, choice, choice);
  runtime = await launchRuntime(source, resolve(source, '../runtime/node'), join(directory, 'runtime'), project);
  console.log('Packaged agent server booted successfully.');
} catch (error) {
  console.error(await readFile(join(directory, 'runtime/server.log'), 'utf8').catch(() => 'No server log.'));
  throw error;
} finally {
  if (runtime) {
    stopRuntime(runtime.process);
    await new Promise<void>(resolve => { runtime!.process.once('exit', () => resolve()); setTimeout(resolve, 2500); });
  }
  await rm(directory, { recursive: true, force: true });
}

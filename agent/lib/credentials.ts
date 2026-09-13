import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import type { Credential, CredentialStore, AuthOperationOptions } from '@earendil-works/pi-ai';

export const appDirectory = process.env.EVE_PI_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'Eve Pi');

export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function ensureDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export class FileCredentialStore implements CredentialStore {
  private readonly path: string;
  constructor(private readonly directory = appDirectory) {
    this.path = join(directory, 'credentials.json');
  }

  private async load(): Promise<Record<string, Credential>> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid credential file. Run npm run login.');
      return data as Record<string, Credential>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      // Do not include parse errors, which can contain credential text.
      throw new Error('Could not read the Eve Pi credential store. Check file permissions or run npm run login.');
    }
  }

  private async locked<T>(fn: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    options?.signal?.throwIfAborted();
    await ensureDirectory(this.directory);
    const deadline = Date.now() + 120_000;
    let release: (() => Promise<void>) | undefined;
    let compromised = false;
    while (!release) {
      options?.signal?.throwIfAborted();
      try {
        release = await lockfile.lock(this.directory, {
          lockfilePath: join(this.directory, 'credentials.lock'),
          stale: 30_000,
          update: 5_000,
          onCompromised: () => { compromised = true; },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) throw new Error('Credential store is busy. Try again after the other login or refresh finishes.');
        await delay(50, undefined, { signal: options?.signal });
      }
    }
    try {
      options?.signal?.throwIfAborted();
      const result = await fn();
      if (compromised) throw new Error('Credential lock was interrupted. Run npm run auth:status before retrying.');
      return result;
    } finally {
      await release();
    }
  }

  async read(providerId: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return (await this.load())[providerId];
  }

  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return Object.entries(await this.load()).map(([providerId, value]) => ({ providerId, type: value.type }));
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    return this.locked(async () => {
      const data = await this.load();
      const next = await fn(data[providerId]);
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        data[providerId] = next;
        await atomicJson(this.path, data);
      }
      return data[providerId];
    }, options);
  }

  async delete(providerId: string, options?: AuthOperationOptions) {
    await this.locked(async () => {
      const data = await this.load();
      delete data[providerId];
      await atomicJson(this.path, data);
    }, options);
  }
}

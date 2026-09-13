import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels, type Provider, type OAuthCredential } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { FileCredentialStore } from '../agent/lib/credentials.ts';

const expired: OAuthCredential = { type: 'oauth', access: 'fixture-old', refresh: 'fixture-refresh', expires: 0 };

test('credentials persist privately and logout leaves no stored token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eve-pi-test-'));
  try {
    const store = new FileCredentialStore(directory);
    await store.modify('openai-codex', async () => expired);
    assert.deepEqual(await new FileCredentialStore(directory).read('openai-codex'), expired);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'credentials.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await store.list(), [{ providerId: 'openai-codex', type: 'oauth' }]);
    await store.delete('openai-codex');
    assert.equal(await store.read('openai-codex'), undefined);
    assert.doesNotMatch(await readFile(join(directory, 'credentials.json'), 'utf8'), /fixture/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('two independent Pi instances refresh a rotated credential only once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eve-pi-test-'));
  try {
    let refreshes = 0;
    const original = openaiCodexProvider();
    const provider: Provider = { ...original, auth: { oauth: {
      name: 'Mock OAuth', login: async () => expired,
      refresh: async current => {
        refreshes++;
        assert.equal(current.refresh, 'fixture-refresh');
        await delay(75);
        return { ...current, access: 'fixture-new', refresh: 'fixture-rotated', expires: Date.now() + 3_600_000 };
      },
      toAuth: async current => ({ apiKey: current.access }),
    } } };
    const instances = [1, 2].map(() => {
      const models = createModels({ credentials: new FileCredentialStore(directory) });
      models.setProvider(provider);
      return models;
    });
    await new FileCredentialStore(directory).modify('openai-codex', async () => expired);
    const auth = await Promise.all(instances.map(m => m.getAuth('openai-codex')));
    assert.equal(refreshes, 1);
    assert.ok(auth.every(a => a?.auth.apiKey === 'fixture-new'));
    assert.equal((await new FileCredentialStore(directory).read('openai-codex') as OAuthCredential).refresh, 'fixture-rotated');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed refresh preserves credentials and never falls back to another auth source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eve-pi-test-'));
  try {
    const store = new FileCredentialStore(directory);
    await store.modify('openai-codex', async () => expired);
    const models = createModels({ credentials: store });
    models.setProvider({ ...openaiCodexProvider(), auth: { oauth: {
      name: 'Mock OAuth', login: async () => expired,
      refresh: async () => { throw new Error('expired fixture'); },
      toAuth: async c => ({ apiKey: c.access }),
    } } });
    await assert.rejects(models.getAuth('openai-codex'));
    assert.deepEqual(await store.read('openai-codex'), expired);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

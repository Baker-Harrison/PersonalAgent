import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Onboarding } from '../desktop/onboarding.ts';

test('browser login saves completion before focusing app, deduplicates requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onboarding-'));
  let finish = 0, opened = '', calls = 0, release!: () => void;
  const pi = { login: async (_id: string, _type: string, interaction: any) => {
    calls++; assert.equal(await interaction.prompt({ type: 'select' }), 'browser');
    interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=test' });
    await new Promise<void>(r => release = r);
  } };
  const onboarding = new Onboarding(dir, async url => { opened = url; }, () => finish++, pi as any);
  try {
    assert.equal(await onboarding.complete(), false);
    const first = onboarding.start(); assert.equal(onboarding.start(), first);
    await new Promise(r => setImmediate(r));
    assert.match(opened, /^https:\/\/auth.openai.com/); assert.equal(finish, 0);
    release(); await first;
    assert.equal(calls, 1); assert.equal(finish, 1); assert.equal(await onboarding.complete(), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('cancel and provider errors never mark onboarding complete or leak credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onboarding-'));
  const pi = { login: async (_id: string, _type: string, i: any) => {
    await i.prompt({ type: 'manual_code' });
  } };
  const onboarding = new Onboarding(dir, async () => {}, () => assert.fail('must not finish'), pi as any);
  try {
    const pending = onboarding.start(); onboarding.cancel();
    await assert.rejects(pending, /cancelled/); assert.equal(await onboarding.complete(), false);
    pi.login = async () => { throw Error('secret-token'); };
    await assert.rejects(onboarding.start(), error => !String(error).includes('secret-token'));
    assert.equal(await onboarding.complete(), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

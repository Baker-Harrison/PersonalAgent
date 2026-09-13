import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableUpdate, checkForUpdate } from '../desktop/updates.ts';
const release = (version: string) => ({ tag_name: `v${version}`, assets: [{ name: `PersonalAgent-${version}-darwin-arm64.zip`, state: 'uploaded', size: 10 }] });
test('updates compare numeric versions and require usable published artifacts', () => {
  assert.equal(availableUpdate('0.9.0', release('0.10.0'))?.version, '0.10.0');
  for (const value of [release('0.1.0'), release('0.0.9'), { ...release('0.2.0'), draft: true }, { ...release('0.2.0'), prerelease: true }, { ...release('0.2.0'), assets: [] }, { tag_name: 'garbage' }]) assert.equal(availableUpdate('0.1.0', value), null);
  assert.equal(availableUpdate('0.1.0', { ...release('0.2.0'), html_url: 'https://evil.example' })?.url, 'https://github.com/Baker-Harrison/PersonalAgent/releases/tag/v0.2.0');
});
test('update checks handle missing releases and failures', async () => {
  assert.equal(await checkForUpdate('0.1.0', (async () => new Response('', { status: 404 })) as typeof fetch), null);
  await assert.rejects(checkForUpdate('0.1.0', (async () => new Response('', { status: 503 })) as typeof fetch));
  assert.equal((await checkForUpdate('0.1.0', (async () => Response.json(release('0.2.0'))) as typeof fetch))?.version, '0.2.0');
});

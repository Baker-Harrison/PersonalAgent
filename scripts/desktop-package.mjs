import { packager } from '@electron/packager';
import { mkdir, copyFile, chmod, writeFile, rename, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('desktop-dist/runtime', { recursive: true });
// Homebrew's node binary links to Homebrew dylibs and cannot be copied by itself.
const version = 'v24.21.0';
const archive = `node-${version}-darwin-arm64.tar.gz`;
const url = `https://nodejs.org/dist/${version}`;
const cache = 'desktop-dist/node-download';
await mkdir(cache, { recursive: true });
const binary = `${cache}/node-${version}-darwin-arm64/bin/node`;
if (!existsSync(binary)) {
  const fetchChecked = async path => { const response = await fetch(path); if (!response.ok) throw Error(`Download failed: ${response.status}`); return response; };
  const checksums = await (await fetchChecked(`${url}/SHASUMS256.txt`)).text();
  const expected = checksums.split('\n').find(line => line.endsWith(`  ${archive}`))?.split(/\s+/)[0];
  const bytes = Buffer.from(await (await fetchChecked(`${url}/${archive}`)).arrayBuffer());
  if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('Node runtime checksum did not match.');
  await writeFile(`${cache}/${archive}`, bytes);
  execFileSync('/usr/bin/tar', ['-xzf', `${cache}/${archive}`, '-C', cache]);
}
// Replace the inode: macOS may cache a prior executable signature while it runs.
await copyFile(binary, 'desktop-dist/runtime/node.next');
await rename('desktop-dist/runtime/node.next', 'desktop-dist/runtime/node');
await chmod('desktop-dist/runtime/node', 0o755);
execFileSync('desktop-dist/runtime/node', ['--version']);
const paths = await packager({ dir: '.', out: process.env.PERSONALAGENT_PACKAGE_OUT || 'dist', name: 'PersonalAgent', executableName: 'PersonalAgent', platform: 'darwin', arch: 'arm64', overwrite: true, asar: false,
  appBundleId: 'local.personalagent.desktop', appVersion: metadata.version, appCopyright: 'PersonalAgent',
  extraResource: ['desktop-dist/runtime'],
  ignore: [/^\/\.env/, /^\/(auth\.json|.*\.log)$/, /^\/desktop-dist\/runtime\.json$/, /^\/(research|examples|test-projects|test|scripts|docs|coverage|\.output|\.next|\.github|\.eve|\.git|\.agents|release|dist)(\/|$)/, /^\/desktop-dist\/(runtime|node-download)(\/|$)/, /^\/node_modules\/(electron|@electron\/packager)(\/|$)/],
  prune: true,
});
console.log(paths.join('\n'));
for (const path of paths) {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', `${path}/PersonalAgent.app`], { stdio: 'inherit' });
  const resources = `${path}/PersonalAgent.app/Contents/Resources`;
  execFileSync(`${resources}/runtime/node`, [`${resources}/app/desktop-dist/check.mjs`, `${resources}/app`], { stdio: 'inherit', timeout: 60000 });
}

import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
await mkdir('desktop-dist', { recursive: true });
await build({ entryPoints: ['desktop/main.ts'], outfile: 'desktop-dist/main.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24', sourcemap: true });
await build({ entryPoints: ['scripts/desktop-check.ts'], outfile: 'desktop-dist/check.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24' });
await build({ entryPoints: ['desktop/engine/server.ts'], outfile: 'desktop-dist/engine.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24', sourcemap: true });
await copyFile('desktop/preload.cjs', 'desktop-dist/preload.cjs');
await writeFile('desktop-dist/runtime.json', JSON.stringify({ node: process.execPath }));
console.log('PersonalAgent desktop built.');

await copyFile('desktop/browser-preload.cjs', 'desktop-dist/browser-preload.cjs');

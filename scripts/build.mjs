import { build } from 'vite';
import { build as bundle } from 'esbuild';
import { readFile } from 'node:fs/promises';

await build();
await bundle({ entryPoints: ['src/content.ts'], bundle: true, format: 'iife', outfile: 'dist/content.js', target: 'chrome116', minify: true });
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts.flatMap(s => s.js)]) {
  await readFile(`dist/${file}`);
}
console.log('Extension built and manifest entry points verified. Load the dist folder in Chrome.');

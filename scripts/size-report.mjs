import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const packages = ['core', 'nodes'];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) files.push(...walk(path));
    else if (entry.endsWith('.js')) files.push(path);
  }
  return files;
}

let totalRaw = 0;
let totalGzip = 0;

console.log('package        files      raw       gzip');
console.log('------------------------------------------');

for (const name of packages) {
  const directory = join(root, 'packages', name, 'dist');
  const files = walk(directory);
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const buffer = readFileSync(file);
    raw += buffer.length;
    gzip += gzipSync(buffer, { level: 9 }).length;
  }
  totalRaw += raw;
  totalGzip += gzip;
  console.log(
    `${name.padEnd(14)} ${String(files.length).padStart(5)} ${format(raw).padStart(9)} ${format(gzip).padStart(9)}`,
  );
}

console.log('------------------------------------------');
console.log(
  `${'total'.padEnd(14)} ${''.padStart(5)} ${format(totalRaw).padStart(9)} ${format(totalGzip).padStart(9)}`,
);
console.log('');
console.log('gzip is the sum of per-file gzip streams (a conservative estimate).');

const elementBundle = await build({
  entryPoints: [join(root, 'packages/element/dist/define.js')],
  bundle: true,
  write: false,
  minify: true,
  format: 'esm',
  target: 'es2022',
  external: ['@draflow/core'],
});
const demoFiles = walk(join(root, 'apps/demo/dist/assets'));
if (demoFiles.length === 0) throw new Error('Build the demo before measuring its bundle');
const demoGzip = demoFiles.reduce((sum, path) => sum + gzipSync(readFileSync(path)).length, 0);
for (const [name, bytes, budget] of [
  ['element (external core)', gzipSync(elementBundle.outputFiles[0].contents).length, 120],
  ['demo (shipped JS)', demoGzip, 250],
]) {
  console.log(`${name}: ${format(bytes)} gzip (budget ${budget} KB)`);
  if (bytes > budget * 1024) process.exitCode = 1;
}

function format(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

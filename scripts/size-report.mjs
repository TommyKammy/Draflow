import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = new URL('..', import.meta.url).pathname;
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

function format(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

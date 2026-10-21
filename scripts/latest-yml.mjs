// Rewrites electron-updater's latest.yml for an installer that was signed after it was
// built: signing changes the file, so its size and SHA-512 must be recomputed or the
// auto-updater rejects the download.
// Usage: node scripts/latest-yml.mjs <installer.exe> <version> > latest.yml

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const [, , file, version] = process.argv;
if (!file || !version) {
  console.error('usage: node scripts/latest-yml.mjs <installer.exe> <version>');
  process.exit(1);
}
const sha512 = createHash('sha512').update(readFileSync(file)).digest('base64');
const size = statSync(file).size;
const name = basename(file);
process.stdout.write(
  `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\n` +
  `path: ${name}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`,
);

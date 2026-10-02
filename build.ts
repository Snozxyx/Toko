/**
 * Toko Extension Build Script
 *
 * Bundles src/index.ts → dist/bundle.js (CJS, all deps inlined except Node
 * built-ins). Packaging into a .kai archive is handled exclusively by sign.ts
 * so every distributed build is signed.
 *
 * Run:
 *   npm run build   — bundle only (dist/bundle.js)
 *   npm run sign    — build + sign → dist/toko-signed.kai
 */

import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url))
);
const DIST = path.join(ROOT, 'dist');

async function main(): Promise<void> {
  fs.mkdirSync(DIST, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(DIST, 'bundle.js'),
    external: [
      'node:*',
      // puppeteer-real-browser carries native bindings and dynamic requires
      // that do not survive bundling; it is loaded lazily at runtime and
      // degrades gracefully to plain fetch inside the worker sandbox.
      'puppeteer-real-browser',
      'fs',
      'path',
      'os',
      'crypto',
      'url',
      'util',
      'stream',
      'events',
      'http',
      'https',
      'net',
      'tls',
      'zlib',
      'buffer',
      'child_process',
      'worker_threads',
    ],
    minify: false,
    sourcemap: false,
  });

  console.log('[toko/build] Bundled src/index.ts → dist/bundle.js');
}

main().catch((err) => {
  console.error('[toko/build] Build failed:', err);
  process.exit(1);
});

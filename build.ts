/**
 * Toko Extension Build Script
 *
 * Bundles src/index.ts → dist/bundle.js (CJS, all deps inlined except Node
 * built-ins), then packages manifest.json, bundle.js, README.md, and icon.png
 * into dist/toko.kai (sideload build).
 *
 * Run:
 *   npm run build
 */

import * as esbuild from 'esbuild';
import JSZip from 'jszip';
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
  // ── Step 1: Bundle ─────────────────────────────────────────────────────────
  fs.mkdirSync(DIST, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(DIST, 'bundle.js'),
    external: [
      'node:*',
      'puppeteer-real-browser',
      'fs', 'path', 'os', 'crypto', 'url', 'util', 'stream',
      'events', 'http', 'https', 'net', 'tls', 'zlib', 'buffer',
      'child_process', 'worker_threads',
    ],
    minify: false,
    sourcemap: false,
  });

  console.log('[toko/build] Bundled src/index.ts → dist/bundle.js');

  // ── Step 2: Package .kai ───────────────────────────────────────────────────
  const requiredFiles: Array<{ name: string; src: string }> = [
    { name: 'manifest.json', src: path.join(ROOT, 'manifest.json') },
    { name: 'bundle.js',     src: path.join(DIST, 'bundle.js') },
    { name: 'README.md',     src: path.join(ROOT, 'README.md') },
    { name: 'icon.png',      src: path.join(ROOT, 'icon.png') },
  ];

  const zip = new JSZip();
  const missing: string[] = [];

  for (const { name, src } of requiredFiles) {
    if (!fs.existsSync(src)) { missing.push(name); continue; }
    zip.file(name, fs.readFileSync(src));
  }

  if (missing.length > 0) {
    console.error(`[toko/build] Missing required files: ${missing.join(', ')}`);
    process.exit(1);
  }

  const kaiPath = path.join(DIST, 'toko.kai');
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(kaiPath, buffer);

  console.log(`[toko/build] Built toko.kai (${buffer.byteLength} bytes) → ${kaiPath}`);
}

main().catch((err) => {
  console.error('[toko/build] Build failed:', err);
  process.exit(1);
});

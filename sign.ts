/**
 * sign.ts — Ed25519 signer for the Toko .kai bundle.
 *
 * The Tatakai loader (`desktop/runtime/extension/kai-format.cjs`,
 * `desktop/ipc/ipc-runtime.cjs`) treats `manifest.signature` as a base64
 * Ed25519 signature over the raw bytes of `bundle.js`, verified with
 * `crypto.verify(null, bundleBytes, { key: <PEM>, format:'pem', type:'spki' }, sig)`
 * against the public key in the `TATAKAI_EXT_PUBLIC_KEY` env var.
 *
 * IMPORTANT: a stock Tatakai build ships a PLACEHOLDER (all-zero) public key,
 * so a signed `.kai` only verifies in a build launched with
 * `TATAKAI_EXT_PUBLIC_KEY` set to the public key printed below. For the public
 * app, install the signature-free `dist/toko.kai` (sideload) instead.
 *
 * Key resolution order:
 *   1. $TATAKAI_EXT_PRIVATE_KEY  — PKCS#8 PEM string, or a path to one
 *   2. keys/private.pem          — reused across releases if present
 *   3. freshly generated Ed25519 keypair, written to keys/ (gitignored)
 *
 * Run `npm run build` first (this reads dist/bundle.js), or use `npm run sign`
 * which chains both. Emits dist/toko-signed.kai + dist/public-key.pem.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import JSZip from 'jszip';

const ROOT = import.meta.dirname;
const DIST = path.join(ROOT, 'dist');
const KEYS = path.join(ROOT, 'keys');

// ── Guard: bundle must exist ───────────────────────────────────────────────
const bundlePath = path.join(DIST, 'bundle.js');
if (!fs.existsSync(bundlePath)) {
  console.error('[toko/sign] dist/bundle.js not found — run `npm run build` first.');
  process.exit(1);
}

// ── Key resolution ─────────────────────────────────────────────────────────
function loadPrivateKey(): crypto.KeyObject {
  // 1. Env var: PEM string or path to PEM file
  const env = process.env.TATAKAI_EXT_PRIVATE_KEY;
  if (env) {
    const pem = fs.existsSync(env) ? fs.readFileSync(env, 'utf8') : env;
    return crypto.createPrivateKey(pem);
  }

  // 2. Persisted key from a previous run
  const stored = path.join(KEYS, 'private.pem');
  if (fs.existsSync(stored)) {
    console.log('[toko/sign] using existing keypair from keys/private.pem');
    return crypto.createPrivateKey(fs.readFileSync(stored, 'utf8'));
  }

  // 3. Generate a fresh Ed25519 keypair and persist it
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(KEYS, { recursive: true });
  fs.writeFileSync(
    path.join(KEYS, 'private.pem'),
    privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(KEYS, 'public.pem'),
    publicKey.export({ type: 'spki', format: 'pem' }) as string,
  );
  console.log('[toko/sign] generated a new Ed25519 keypair → keys/ (private.pem is gitignored — keep it safe)');
  return privateKey;
}

// ── Sign ───────────────────────────────────────────────────────────────────
const privateKey = loadPrivateKey();
const publicPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) as string;

const bundleBytes = fs.readFileSync(bundlePath);
const signature = crypto.sign(null, bundleBytes, privateKey).toString('base64');

// ── Build signed manifest ──────────────────────────────────────────────────
// Drop `sideloaded` — presence of a valid signature takes the curated/verified
// trust path in the Tatakai loader. Keep everything else intact.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
delete manifest.sideloaded;
manifest.signature = signature;

// ── Package signed .kai ────────────────────────────────────────────────────
const zip = new JSZip();
zip.file('manifest.json', JSON.stringify(manifest, null, 2));
zip.file('bundle.js',     bundleBytes);
zip.file('README.md',     fs.readFileSync(path.join(ROOT, 'README.md')));
zip.file('icon.png',      fs.readFileSync(path.join(ROOT, 'icon.png')));

const outKai = path.join(DIST, 'toko-signed.kai');
fs.writeFileSync(
  outKai,
  await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
);
fs.writeFileSync(path.join(DIST, 'public-key.pem'), publicPem);

console.log(`[toko/sign] signed ${outKai}`);
console.log('[toko/sign] signature (base64):', signature);
console.log('\nTo trust this build, launch Tatakai with:\n');
console.log('TATAKAI_EXT_PUBLIC_KEY=' + JSON.stringify(publicPem.trim()));

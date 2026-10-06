import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expressPackage = path.join(apiDir, 'node_modules', 'express', 'package.json');

if (!existsSync(expressPackage)) {
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: apiDir,
    stdio: 'inherit',
  });
}

await import('./server.js');
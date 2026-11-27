#!/usr/bin/env node
// Publishes one build under both package names, so `npx harness-audit` and
// `npx @wondelai/harness-audit` are always the same code at the same version.
//
//   node scripts/publish.mjs            publish (skips a name whose version is already on npm)
//   node scripts/publish.mjs --dry-run  pack and show what would be published, upload nothing
//   node scripts/publish.mjs --check    wait until both names serve this version through npx
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAMES = ['@wondelai/harness-audit', 'harness-audit'];
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--dry-run') ? 'dry-run' : 'publish';

const capture = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const onRegistry = (name) => capture('npm', ['view', `${name}@${pkg.version}`, 'version']) === pkg.version;

if (mode === 'check') {
  // The registry needs a moment after a publish; npx is what a user runs, so npx is what is asked.
  for (const name of NAMES) {
    let served = '';
    for (let attempt = 0; attempt < 12 && served !== pkg.version; attempt++) {
      served = capture('npx', ['-y', `${name}@${pkg.version}`, '--version']);
      if (served !== pkg.version) await new Promise((r) => setTimeout(r, 10_000));
    }
    if (served !== pkg.version) {
      console.error(`${name}@${pkg.version}: npx printed "${served}" instead of ${pkg.version}`);
      process.exit(1);
    }
    console.log(`npx ${name}@${pkg.version} --version → ${served}`);
  }
  process.exit(0);
}

for (const name of NAMES) {
  if (mode === 'publish' && onRegistry(name)) {
    console.log(`${name}@${pkg.version} is already on npm — skipping`);
    continue;
  }
  const stage = mkdtempSync(join(tmpdir(), 'harness-audit-publish-'));
  try {
    for (const entry of pkg.files) cpSync(join(root, entry), join(stage, entry), { recursive: true });
    // The staged manifest carries no scripts: nothing runs on publish but the upload.
    const { scripts: _scripts, devDependencies: _dev, ...manifest } = pkg;
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ ...manifest, name }, null, 2)}\n`);
    execFileSync('npm', ['publish', '--access', 'public', ...(mode === 'dry-run' ? ['--dry-run'] : [])], {
      cwd: stage,
      stdio: 'inherit',
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

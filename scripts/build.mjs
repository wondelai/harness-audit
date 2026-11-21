import { chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/cli.js',
  sourcemap: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  sourcemap: false,
});

chmodSync('dist/cli.js', 0o755);

// Emit .d.ts declarations via tsc (without .d.ts.map bloat)
execFileSync('npx', ['tsc', '--emitDeclarationOnly', '--declarationMap', 'false', '--outDir', 'dist'], {
  stdio: 'inherit',
});

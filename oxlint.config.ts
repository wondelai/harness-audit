import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  ignorePatterns: cloudflare.ignorePatterns,
  overrides: [
    {
      // Release tooling run from a terminal or CI: console is how it reports progress.
      // src/ keeps the rule, the CLI there writes through its own output helpers.
      files: ['scripts/**'],
      rules: { 'no-console': 'off' },
    },
  ],
});

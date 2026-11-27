# harness-audit

CLI and library that audits a repository's AI-coding-agent harness: 30 deterministic checks across six
stations, a 0–100 score and an Autonomy Level 0–5. TypeScript, Node >= 20, zero runtime dependencies.
Published as `@wondelai/harness-audit`; `packages/harness-audit-alias` is the unscoped `harness-audit`
wrapper that depends on it.

## Commands

```bash
npm ci
npm run verify       # typecheck + build + tests: the gate, run it before you finish
npm run typecheck    # tsc --noEmit
npm run build        # esbuild bundles into dist/, then tsc emits the .d.ts files
npm test             # vitest; the CLI tests run the built dist/cli.js, so build first
```

Try a change on a real repository: `node dist/cli.js /path/to/repo` (add `--verbose`, `--format json`,
`--prompt`, or `init /path --dry-run`).

## Invariants

- **The audit only reads.** `init` and `--out` are the two things that write, and `init` never overwrites
  a file without `--force`.
- **The scan is what git shows a teammate.** `RepoContext` lists tracked files plus untracked files that
  `.gitignore` does not exclude. A finding never comes from an ignored file; `readUnscannedText` exists
  only to resolve references such as a tsconfig preset in `node_modules`.
- **Never print a secret.** Evidence for a credential is `file:line provider`, nothing more.
- **Evidence names what was read; the fix names only what was found.** No fix text that lists problems
  the check did not see in this repository.
- **Every stack by its own conventions.** No check may assume `package.json`. A new stack goes into
  `src/capabilities.ts` (verify commands) and the stack-aware branches of the loop and harness checks.
- **Every user-facing string exists in `en` and `pl`.**
- **Zero runtime dependencies.** Parsing YAML, TOML or JSONC stays hand-rolled and line-based.

## Read before you touch

- `src/fs-scanner.ts`: file listing (git or walk), stack detection, the `RepoContext` every check reads.
- `src/capabilities.ts`: the one place that knows what a command proves (test, lint, typecheck, build).
  `src/ci.ts` uses it to read what a pull request is gated on.
- `src/checks/<station>.ts`: one file per station. A check returns status, evidence, why and fix.
- `src/scoring.ts`: level thresholds, gating caps, impact points, priority order. The "Autonomy Ladder"
  table in `README.md` restates the caps, so change both together.
- `src/i18n.ts`: `TOOL_VERSION` must equal `version` in `package.json` (a test checks it).
- `tests/accuracy.test.ts`: one test per false finding that was fixed. Tests build real temporary
  repositories with `tests/fixtures.ts`; the scanner is never mocked.

## Release

Publishing to npm is the owner's call: never run `npm publish`. A release bumps `package.json`,
`TOOL_VERSION` and `packages/harness-audit-alias/package.json` (version and dependency range) together.

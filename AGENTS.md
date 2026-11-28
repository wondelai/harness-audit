# harness-audit

CLI and library that audits a repository's AI-coding-agent harness: 30 deterministic checks across six
stations, a 0–100 score and an Autonomy Level 0–5. TypeScript, Node >= 20, zero runtime dependencies.
Published under two names from one build, `@wondelai/harness-audit` and `harness-audit`, always at the
same version.

## Commands

The package runs on Node >= 20, but developing it needs Node 22.18+ (or 24+): `oxlint.config.ts` loads only there.

```bash
npm ci
npm run verify       # lint + typecheck + build + tests: the gate, run it before you finish
npm run lint         # oxlint with @cloudflare/oxlint-config (oxlint.config.ts); --fix applies the safe fixes only
npm run typecheck    # tsc --noEmit for src/, tsc -p tests for the tests
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
- **No lint rule is switched off** (`oxlint.config.ts`, `@cloudflare/oxlint-config`); fix the code. `no-console` is off only in `scripts/`. Two single-line `oxlint-disable-next-line` casts exist, each with its reason: `parseJsonc` in `src/fs-scanner.ts` and `parseJsonAs` in `tests/fixtures.ts`. Untyped input is read through `src/json.ts` (`parseJson`, `isJsonObject`) and `lookup()` in `src/lookup.ts`, not cast.

## Read before you touch

- `src/fs-scanner.ts`: file listing (git or walk), stack detection, the `RepoContext` every check reads.
- `src/capabilities.ts`: the one place that knows what a command proves (test, lint, typecheck, build).
  `src/ci.ts` uses it to read what a pull request is gated on.
- `src/checks/<station>.ts`: one file per station. A check returns status, evidence, why and fix.
- `src/scoring.ts`: level thresholds, gating caps, impact points, priority order. The "Autonomy Ladder"
  table in `README.md` restates the caps, so change both together.
- `src/brief.ts`: what the root AGENTS.md / CLAUDE.md say (routed docs, boundary rules, module map),
  read once for every check that asks.
- `src/i18n.ts`: every user-facing string. `TOOL_VERSION` is read from `package.json`, the one place
  the version lives.
- `tests/accuracy.test.ts`: one test per false finding that was fixed. Tests build real temporary
  repositories with `tests/fixtures.ts`; the scanner is never mocked.

## Release

The version lives in `package.json` only. A release is a tag:

```bash
npm version minor            # or patch: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags       # .github/workflows/release.yml does the rest
```

The workflow runs the gate, publishes the build under both names with `scripts/publish.mjs` (npm
trusted publishing, no token), waits until `npx harness-audit@X --version` and
`npx @wondelai/harness-audit@X --version` both print `X`, and creates the GitHub release.
`npm run release:dry-run` shows what would be uploaded without uploading.

Tagging and publishing are the owner's call: an agent never pushes a `v*` tag and never runs
`npm publish` or `npm run release:publish`.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scriptRunner } from './capabilities.js';
import { RepoContext } from './fs-scanner.js';
import type { InitAction, InitOptions, InitResult, SupportedTool } from './types.js';

const DEFAULT_TOOLS: SupportedTool[] = ['claude-code', 'cursor', 'codex'];

const INSTALL_COMMAND: Record<string, string> = {
  bun: 'bun install --frozen-lockfile',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --frozen-lockfile',
  npm: 'npm ci',
  uv: 'uv sync',
  poetry: 'poetry install',
  pip: 'pip install -r requirements.txt',
  go: 'go mod download',
  cargo: 'cargo fetch',
  swiftpm: 'swift package resolve',
  pub: 'dart pub get',
  bundler: 'bundle install',
  composer: 'composer install',
  mix: 'mix deps.get',
};

/**
 * The fewest detected commands that together cover typecheck, lint, test and build. Only commands
 * the repository really has: a brief that quotes a script which does not exist teaches agents to
 * distrust the brief.
 */
function verifyCommandsFor(ctx: RepoContext): string[] {
  const { commands, unified } = ctx.verify;
  const chosen = unified ? [unified] : [];
  for (const kind of ['typecheck', 'lint', 'test', 'build'] as const) {
    if (chosen.some((c) => c.kinds.includes(kind))) continue;
    const next = commands.find((c) => c.kinds.includes(kind));
    if (next) chosen.push(next);
  }
  return chosen.map((c) => c.command);
}

function buildAgentsMd(ctx: RepoContext): string {
  const stack = ctx.stack;
  const install = stack.packageManagers.map((pm) => INSTALL_COMMAND[pm]).find(Boolean);
  const verify = verifyCommandsFor(ctx);
  const stackLine =
    [...stack.languages, ...stack.frameworks].join(' · ') || 'TODO: name the stack';
  const commandLines = [
    ...(install ? [install] : []),
    ...(verify.length > 0 ? verify : ['# TODO: the command that runs your static checks and tests']),
  ];

  return `# ${ctx.repoName}

${stackLine}.

## Verification Commands

Run these before concluding any change${verify.length > 0 ? ' (detected from this repository; correct any that are wrong)' : ''}:

\`\`\`bash
${commandLines.join('\n')}
\`\`\`

## Working Rules

1. **Plan before multi-file edits.** State files to touch, acceptance criteria, and the exact verification commands that prove completion.
2. **Protect the test oracle.** Never add \`.skip()\`, \`.only()\`, \`@ts-ignore\`, or tautological assertions (\`expect(true).toBe(true)\`) to make checks green.
3. **Production is off-limits locally.** Never run production deploys, remote database migrations, or live external webhooks from a local agent session.
4. **Verify every claim.** Report the exact command run and its observed exit code; do not claim tests pass without running them.

## Architecture & Key Paths

- TODO: Document the 3–5 non-obvious invariants or directory boundaries an agent would otherwise get wrong.
- Keep this file under 150 lines; place directory-specific instructions in \`.claude/rules/*.md\` (with \`paths:\`) or \`.cursor/rules/*.mdc\` (with \`globs:\`).

## External Tools (MCP)

Do not copy stale server lists from blog posts. Discover verified official servers from the official MCP Registry (https://registry.modelcontextprotocol.io/) and pass credentials via \`\${VAR}\` / \`\${env:VAR}\` interpolation only.
`;
}

/**
 * A starter permission policy: the detected verify commands run without a prompt, and the commands
 * that reach production or rewrite history are denied.
 */
function buildClaudeSettings(ctx: RepoContext): string {
  const allow = verifyCommandsFor(ctx).map((cmd) => `Bash(${cmd}:*)`);
  const deny: string[] = [];
  const scripts = Object.keys(ctx.packageJson?.scripts ?? {});
  const run = scriptRunner(ctx);
  for (const name of scripts.filter((k) => /^(deploy|publish|release)([:._-].*)?$/.test(k)).slice(0, 4)) {
    deny.push(`Bash(${run(name)}:*)`);
  }
  if (ctx.hasAnyFile(['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'])) {
    deny.push('Bash(wrangler deploy:*)', 'Bash(npx wrangler deploy:*)', 'Bash(bunx wrangler deploy:*)');
  }
  deny.push('Bash(git push --force:*)', 'Bash(git push -f:*)', 'Read(./.env)', 'Read(./.env.*)');

  return `${JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      permissions: { allow, deny },
    },
    null,
    2,
  )}\n`;
}

function buildClaudeMd(): string {
  return `@AGENTS.md
`;
}

function buildClaudeTestingRule(): string {
  return `---
paths:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "tests/**"
  - "__tests__/**"
---

# Testing Rules

- Pin observable behavior against hand-computed expected values — never write tautological assertions (\`expect(true).toBe(true)\` or re-deriving expected output with the same expression under test).
- Never commit \`.only()\` or leave newly added \`.skip()\` tests without a linked tracking issue.
- Prefer real temporary fixtures or isolated test state over mocking the module under test.
`;
}

function buildCursorTestingRule(): string {
  return `---
description: Testing discipline and oracle hygiene for automated test suites
globs: "**/*.test.*,**/*.spec.*,tests/**,__tests__/**"
alwaysApply: false
---

# Testing Rules

- Pin observable behavior against hand-computed expected values — never write tautological assertions.
- Never commit \`.only()\` or leave unlinked \`.skip()\` tests.
- Prefer real temporary fixtures or isolated test state over mocking the module under test.
`;
}

function buildPrTemplate(): string {
  return `## Summary

- What changed and why:

## Verification Evidence

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | \`...\` | PASS / N/A |
| Lint | \`...\` | PASS / N/A |
| Tests | \`...\` | PASS |
| Build | \`...\` | PASS / N/A |

## Risk & Escalation Check

- [ ] Does NOT weaken or skip existing tests/assertions
- [ ] Touches auth, payments, schema migrations, secrets, or CI workflows? (If yes, request code-owner line-by-line review)
- [ ] Rollback plan noted if stateful/migration change:
`;
}

/**
 * The files `init` would write for this repository, without writing them. An existing file is
 * always `skip` unless `force` is set.
 */
export function planInit(ctx: RepoContext, options: InitOptions = {}): InitAction[] {
  const force = Boolean(options.force);
  const tools = options.tools && options.tools.length > 0 ? options.tools : DEFAULT_TOOLS;

  const candidates: Array<{ path: string; content: string }> = [{ path: 'AGENTS.md', content: buildAgentsMd(ctx) }];

  if (tools.includes('claude-code')) {
    candidates.push({ path: 'CLAUDE.md', content: buildClaudeMd() });
    candidates.push({ path: '.claude/rules/testing.md', content: buildClaudeTestingRule() });
    candidates.push({ path: '.claude/settings.json', content: buildClaudeSettings(ctx) });
  }

  if (tools.includes('cursor')) {
    candidates.push({ path: '.cursor/rules/testing.mdc', content: buildCursorTestingRule() });
  }

  if (
    !ctx.hasAnyFile([
      '.github/pull_request_template.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'docs/pull_request_template.md',
    ])
  ) {
    candidates.push({ path: '.github/pull_request_template.md', content: buildPrTemplate() });
  }

  return candidates.map((item) => {
    // On disk, not just in the scan: a gitignored local file must not be overwritten either.
    const alreadyExists = existsSync(join(ctx.root, item.path));
    if (alreadyExists && !force) {
      return { path: item.path, action: 'skip', reason: 'already exists (pass --force to overwrite)', content: item.content };
    }
    const action: InitAction['action'] = alreadyExists ? 'overwrite' : 'create';
    return { path: item.path, action, reason: `would ${action}`, content: item.content };
  });
}

export function initHarness(repoPath: string, options: InitOptions = {}): InitResult {
  const ctx = new RepoContext(repoPath);
  const dryRun = Boolean(options.dryRun);
  const tools = options.tools && options.tools.length > 0 ? options.tools : DEFAULT_TOOLS;

  const actions = planInit(ctx, options).map((item): InitAction => {
    if (item.action === 'skip' || dryRun) return item;
    const fullPath = join(ctx.root, item.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, item.content, 'utf8');
    return { ...item, reason: item.action === 'overwrite' ? 'overwritten (--force)' : 'created' };
  });

  return {
    repoPath: ctx.root,
    dryRun,
    tools,
    actions,
  };
}

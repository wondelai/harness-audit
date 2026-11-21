import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RepoContext } from './fs-scanner.js';
import type { InitAction, InitOptions, InitResult, StackInfo, SupportedTool } from './types.js';

const DEFAULT_TOOLS: SupportedTool[] = ['claude-code', 'cursor', 'codex'];

function detectCommands(stack: StackInfo): {
  install: string;
  test: string;
  lint: string;
  typecheck: string;
  build: string;
} {
  const pm = stack.packageManagers[0];
  if (pm === 'vp') {
    return {
      install: 'vp install --frozen-lockfile',
      test: 'vp test',
      lint: 'vp lint',
      typecheck: 'vp run typecheck',
      build: 'vp run build',
    };
  }
  if (pm === 'bun') {
    return {
      install: 'bun install --frozen-lockfile',
      test: 'bun test',
      lint: 'bun run lint',
      typecheck: 'bun run typecheck',
      build: 'bun run build',
    };
  }
  if (pm === 'pnpm') {
    return {
      install: 'pnpm install --frozen-lockfile',
      test: 'pnpm test',
      lint: 'pnpm run lint',
      typecheck: 'pnpm run typecheck',
      build: 'pnpm run build',
    };
  }
  if (pm === 'yarn') {
    return {
      install: 'yarn install --frozen-lockfile',
      test: 'yarn test',
      lint: 'yarn lint',
      typecheck: 'yarn typecheck',
      build: 'yarn build',
    };
  }
  if (pm === 'uv') {
    return {
      install: 'uv sync',
      test: 'uv run pytest',
      lint: 'uv run ruff check .',
      typecheck: 'uv run pyright',
      build: 'uv build',
    };
  }
  if (pm === 'poetry') {
    return {
      install: 'poetry install',
      test: 'poetry run pytest',
      lint: 'poetry run ruff check .',
      typecheck: 'poetry run mypy .',
      build: 'poetry build',
    };
  }
  if (pm === 'go') {
    return {
      install: 'go mod download',
      test: 'go test ./...',
      lint: 'golangci-lint run',
      typecheck: 'go vet ./...',
      build: 'go build ./...',
    };
  }
  if (pm === 'cargo') {
    return {
      install: 'cargo fetch',
      test: 'cargo test',
      lint: 'cargo clippy --all-targets -- -D warnings',
      typecheck: 'cargo check',
      build: 'cargo build',
    };
  }
  return {
    install: 'npm ci',
    test: 'npm test',
    lint: 'npm run lint',
    typecheck: 'npm run typecheck',
    build: 'npm run build',
  };
}

function buildAgentsMd(repoName: string, stack: StackInfo): string {
  const cmds = detectCommands(stack);
  const stackLine =
    [...stack.languages, ...stack.frameworks].join(' · ') || 'Verify stack in project manifest';

  return `# ${repoName}

${stackLine}.

## Verification Commands

Run these before concluding any change (verify each command matches your scripts):

\`\`\`bash
${cmds.install}
${cmds.typecheck}
${cmds.lint}
${cmds.test}
${cmds.build}
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

export function initHarness(repoPath: string, options: InitOptions = {}): InitResult {
  const ctx = new RepoContext(repoPath);
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const tools = options.tools && options.tools.length > 0 ? options.tools : DEFAULT_TOOLS;

  const candidates: Array<{ path: string; content: string }> = [
    { path: 'AGENTS.md', content: buildAgentsMd(ctx.repoName, ctx.stack) },
  ];

  if (tools.includes('claude-code')) {
    candidates.push({ path: 'CLAUDE.md', content: buildClaudeMd() });
    candidates.push({ path: '.claude/rules/testing.md', content: buildClaudeTestingRule() });
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

  const actions: InitAction[] = [];

  for (const item of candidates) {
    const fullPath = join(ctx.root, item.path);
    const alreadyExists = existsSync(fullPath);

    if (alreadyExists && !force) {
      actions.push({
        path: item.path,
        action: 'skip',
        reason: 'already exists (pass --force to overwrite)',
        content: item.content,
      });
      continue;
    }

    const actionType: InitAction['action'] = alreadyExists ? 'overwrite' : 'create';
    if (!dryRun) {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, item.content, 'utf8');
    }

    actions.push({
      path: item.path,
      action: actionType,
      reason: dryRun
        ? `would ${actionType}`
        : actionType === 'overwrite'
          ? 'overwritten (--force)'
          : 'created',
      content: item.content,
    });
  }

  return {
    repoPath: ctx.root,
    dryRun,
    tools,
    actions,
  };
}

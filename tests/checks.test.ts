import { afterEach, describe, expect, it } from 'vitest';
import { auditRepo } from '../src/index.js';
import { createAntiPatternRepo, createLevel0BareRepo, createTempRepo, createWellHarnessedRepo } from './fixtures.js';
import type { TempRepo } from './fixtures.js';

const repos: Array<TempRepo> = [];
const track = (r: TempRepo): TempRepo => {
  repos.push(r);
  return r;
};

afterEach(() => {
  while (repos.length > 0) {
    repos.pop()!.cleanup();
  }
});

describe('deterministic station checks', () => {
  it('runs all 30 checks across all 6 stations on a bare Level 0 repo', () => {
    const repo = track(createLevel0BareRepo());
    const report = auditRepo(repo.dir);

    expect(report.stations).toHaveLength(6);
    expect(report.checks).toHaveLength(30);
    expect(report.level).toBe(0);
    expect(report.overallScore).toBeLessThan(25);

    const byId = new Map(report.checks.map((c) => [c.id, c]));
    expect(byId.get('intent.instructions-file')?.status).toBe('fail');
    expect(byId.get('loop.single-command-verify')?.status).toBe('fail');
    expect(byId.get('verification.unit-tests')?.status).toBe('fail');
    expect(byId.get('release.ci-pipeline')?.status).toBe('fail');
    // No false positive on MCP when no MCP config exists
    expect(byId.get('harness.mcp-hygiene')?.status).toBe('info');
  });

  it('catches bloated duplicated instructions, retired Codex untrusted policy, broken MCP servers, unguarded Stop hook, and tautological tests', () => {
    const repo = track(createAntiPatternRepo());
    const report = auditRepo(repo.dir);
    const byId = new Map(report.checks.map((c) => [c.id, c]));

    // Station 1: Intent
    expect(byId.get('intent.single-source')?.status).toBe('fail');
    expect(byId.get('intent.single-source')?.evidence.join(' ')).toContain('Policy by duplication');
    expect(byId.get('intent.instruction-budget')?.status).toBe('fail');
    expect(byId.get('intent.instruction-budget')?.evidence.join(' ')).toContain('381 lines');

    // Station 2: Harness
    expect(byId.get('harness.permissions-policy')?.status).toBe('fail');
    expect(byId.get('harness.permissions-policy')?.evidence.join(' ')).toContain('untrusted');
    expect(byId.get('harness.hooks')?.status).toBe('fail');
    expect(byId.get('harness.hooks')?.evidence.join(' ')).toContain('stop_hook_active');
    expect(byId.get('harness.mcp-hygiene')?.status).toBe('fail');
    const mcpEv = byId.get('harness.mcp-hygiene')?.evidence.join(' ') ?? '';
    expect(mcpEv).toContain('@modelcontextprotocol/server-postgres');
    expect(mcpEv).toContain('Bearer');
    expect(mcpEv).toContain('/sse');

    // Station 5: Verification
    expect(byId.get('verification.test-quality-scan')?.status).toBe('fail');
    const tqEv = byId.get('verification.test-quality-scan')?.evidence.join(' ') ?? '';
    expect(tqEv).toContain('.only()');
    expect(tqEv).toContain('tautology');
    expect(tqEv).toContain('Empty test blocks');

    // Anti-pattern repo lands at Level <= 2 (and if we also inject a critical harness blocker into a strong repo, Cap 3 fires)
    expect(report.level).toBeLessThanOrEqual(2);
  });

  it('caps a high-scoring repository to Level 2 when retired Codex approval_policy="untrusted" is present', () => {
    const repo = track(createWellHarnessedRepo());
    repo.write('.codex/config.toml', 'approval_policy = "untrusted"\nsandbox_mode = "workspace-write"\n');
    const report = auditRepo(repo.dir);

    expect(report.rawLevel).toBeGreaterThanOrEqual(4);
    expect(report.level).toBe(2);
    expect(report.levelCaps.some((cap) => cap.cappedTo === 2 && cap.triggeredBy.includes('harness.permissions-policy'))).toBe(true);
  });

  it('flags backticked `@AGENTS.md` in CLAUDE.md as a failed import and passes bare @AGENTS.md', () => {
    const bad = track(createTempRepo('ha-backtick-'));
    bad.write('AGENTS.md', '# Brief\nRun `npm test`.\n');
    bad.write('CLAUDE.md', 'See `@AGENTS.md` for instructions.\n');

    const badReport = auditRepo(bad.dir);
    const badCheck = badReport.checks.find((c) => c.id === 'intent.single-source')!;
    expect(badCheck.status).toBe('fail');
    expect(badCheck.evidence.join(' ')).toContain('backticks');

    const good = track(createTempRepo('ha-bare-'));
    good.write('AGENTS.md', '# Brief\nRun `npm test`.\n');
    good.write('CLAUDE.md', '@AGENTS.md\n');

    const goodReport = auditRepo(good.dir);
    const goodCheck = goodReport.checks.find((c) => c.id === 'intent.single-source')!;
    expect(goodCheck.status).toBe('pass');
  });

  it('flags misplaced .claude/mcp.json and hardcoded secret keys in config', () => {
    const repo = track(createTempRepo('ha-mcp-secret-'));
    repo.write('.claude/mcp.json', JSON.stringify({ mcpServers: { s: { type: 'http', url: 'https://x.test/mcp' } } }));
    repo.write('.env.example', 'ANTHROPIC_API_KEY=sk-ant-api03-realLookingSecretValue1234567890abcd\n');
    repo.write('.gitignore', '.env\n.env.local\n*.pem\n');

    const report = auditRepo(repo.dir);
    const mcpCheck = report.checks.find((c) => c.id === 'harness.mcp-hygiene')!;
    const secretCheck = report.checks.find((c) => c.id === 'harness.secret-hygiene')!;

    expect(mcpCheck.status).toBe('warn');
    expect(mcpCheck.evidence.join(' ')).toContain('.claude/mcp.json');
    expect(secretCheck.status).toBe('fail');
    expect(secretCheck.meta?.['hasHardcodedSecrets']).toBe(true);
  });

  it('scores a well-harnessed repository at Level 5 with zero level caps', () => {
    const repo = track(createWellHarnessedRepo());
    const report = auditRepo(repo.dir);

    expect(report.overallScore).toBeGreaterThanOrEqual(90);
    expect(report.level).toBe(5);
    expect(report.levelCaps).toHaveLength(0);
    expect(report.checks.filter((c) => c.status === 'fail')).toHaveLength(0);
  });

  it('handles Python and Go repositories without Node/TypeScript false positives', () => {
    const pyRepo = track(createTempRepo('ha-py-'));
    pyRepo.write(
      'pyproject.toml',
      `[project]
name = "py-svc"
dependencies = ["fastapi"]
[tool.ruff]
line-length = 100
[tool.pyright]
typeCheckingMode = "strict"
[tool.uv]
managed = true
`,
    );
    pyRepo.write('uv.lock', 'version = 1\n');
    pyRepo.write('.python-version', '3.12\n');
    pyRepo.write('src/main.py', 'def add(a: int, b: int) -> int:\n    return a + b\n');
    pyRepo.write('tests/test_main.py', 'def test_add():\n    assert 2 + 2 == 4\n');

    const report = auditRepo(pyRepo.dir);
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    expect(report.stack.languages).toContain('Python');
    expect(report.stack.packageManagers).toContain('uv');
    expect(byId.get('loop.static-types')?.status).toBe('pass');
    expect(byId.get('loop.formatter-linter')?.status).toBe('pass');
    expect(byId.get('loop.lockfile-reproducibility')?.status).toBe('pass');
  });
});

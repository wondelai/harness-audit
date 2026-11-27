import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runDeepReview } from '../src/deep.js';
import { RepoContext } from '../src/fs-scanner.js';
import { auditRepo, generateFixPrompt, initHarness, INTERVIEW_QUESTIONS, scoreInterview } from '../src/index.js';
import { createAntiPatternRepo, createLevel0BareRepo, createWellHarnessedRepo, type TempRepo } from './fixtures.js';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'cli.js');

const repos: TempRepo[] = [];
const track = (r: TempRepo): TempRepo => {
  repos.push(r);
  return r;
};

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    execFileSync('npm', ['run', 'build'], { cwd: PACKAGE_ROOT, stdio: 'pipe' });
  }
});

afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
});

describe('CLI modes, --prompt, init, interview, and --deep', () => {
  it('exits with code 1 when --ci --min-score is not met and 0 when met', () => {
    const bare = track(createLevel0BareRepo());
    const failRun = spawnSync('node', [CLI_PATH, bare.dir, '--ci', '--min-score', '50', '--format', 'json'], {
      encoding: 'utf8',
    });
    expect(failRun.status).toBe(1);
    const parsedFail = JSON.parse(failRun.stdout) as { overallScore: number };
    expect(parsedFail.overallScore).toBeLessThan(50);

    const strong = track(createWellHarnessedRepo());
    const passRun = spawnSync('node', [CLI_PATH, strong.dir, '--ci', '--min-score', '85', '--format', 'json'], {
      encoding: 'utf8',
    });
    expect(passRun.status).toBe(0);
    const parsedPass = JSON.parse(passRun.stdout) as { overallScore: number; level: number };
    expect(parsedPass.overallScore).toBeGreaterThanOrEqual(85);
    expect(parsedPass.level).toBe(5);
  });

  it('generates tailored HARNESS-FIX-PROMPT.md with safety rules, repo evidence, and claims ledger', () => {
    const repo = track(createAntiPatternRepo());
    const report = auditRepo(repo.dir);
    const promptEn = generateFixPrompt(report, 'en');

    expect(promptEn).toContain('HARNESS-FIX-PROMPT.md');
    expect(promptEn).toContain('Never overwrite existing instructions blindly');
    expect(promptEn).toContain('~/.claude');
    expect(promptEn).toContain('harness.permissions-policy');
    expect(promptEn).toContain('harness.mcp-hygiene');
    expect(promptEn).toContain('| Claim / Check Fixed | Command Executed | Exit Code & Observed Output |');

    const promptPl = generateFixPrompt(report, 'pl');
    expect(promptPl).toContain('Nigdy nie nadpisuj ślepo istniejących instrukcji');
    expect(promptPl).toContain('| Twierdzenie / naprawiony check | Uruchomiona komenda | Kod wyjścia i skrót wyniku |');
  });

  it('init supports --dry-run, never overwrites without --force, and overwrites with --force', () => {
    const repo = track(createLevel0BareRepo());
    repo.write('AGENTS.md', '# Custom existing brief — do not clobber\n');

    // Dry run writes nothing
    const dry = initHarness(repo.dir, { dryRun: true, tools: ['claude-code', 'cursor'] });
    expect(dry.actions.find((a) => a.path === 'AGENTS.md')?.action).toBe('skip');
    expect(dry.actions.find((a) => a.path === 'CLAUDE.md')?.action).toBe('create');
    expect(existsSync(join(repo.dir, 'CLAUDE.md'))).toBe(false);

    // Real init skips existing AGENTS.md and creates missing files
    const real = initHarness(repo.dir, { tools: ['claude-code', 'cursor'] });
    expect(real.actions.find((a) => a.path === 'AGENTS.md')?.action).toBe('skip');
    expect(readFileSync(join(repo.dir, 'AGENTS.md'), 'utf8')).toBe('# Custom existing brief — do not clobber\n');
    expect(readFileSync(join(repo.dir, 'CLAUDE.md'), 'utf8').trim()).toBe('@AGENTS.md');
    expect(existsSync(join(repo.dir, '.claude/rules/testing.md'))).toBe(true);
    expect(existsSync(join(repo.dir, '.cursor/rules/testing.mdc'))).toBe(true);
    expect(existsSync(join(repo.dir, '.github/pull_request_template.md'))).toBe(true);

    // Force overwrites AGENTS.md and links official MCP registry instead of rotting lists
    const forced = initHarness(repo.dir, { force: true, tools: ['claude-code'] });
    expect(forced.actions.find((a) => a.path === 'AGENTS.md')?.action).toBe('overwrite');
    const newAgents = readFileSync(join(repo.dir, 'AGENTS.md'), 'utf8');
    expect(newAgents).toContain('registry.modelcontextprotocol.io');
    expect(newAgents).not.toContain('@modelcontextprotocol/server-postgres');
  });

  it('prints the version package.json declares', () => {
    const declared = (JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    const printed = spawnSync('node', [CLI_PATH, '--version'], { encoding: 'utf8' }).stdout.trim();
    expect(printed).toBe(declared);
  });

  it('scores the 7-question Org & Workflow interview deterministically', () => {
    expect(INTERVIEW_QUESTIONS).toHaveLength(7);
    const allZero = scoreInterview('cto', {});
    expect(allZero.score).toBe(0);
    expect(allZero.gaps).toHaveLength(7);

    const allTop = scoreInterview(
      'lead',
      Object.fromEntries(INTERVIEW_QUESTIONS.map((q) => [q.id, 2 as const])),
    );
    expect(allTop.score).toBe(100);
    expect(allTop.gaps).toHaveLength(0);
  });

  it('handles --deep gracefully when no local CLI or API key is available', async () => {
    const repo = track(createLevel0BareRepo());
    const ctx = new RepoContext(repo.dir);
    const report = auditRepo(repo.dir);
    const deep = await runDeepReview(ctx, report.checks, 'en', {
      HARNESS_AUDIT_NO_LOCAL_CLI: '1',
    });

    expect(deep.provider).toBe('unavailable');
    expect(deep.error).toContain('ANTHROPIC_API_KEY');
    expect(deep.findings).toHaveLength(0);
  });

  it('runs init and --prompt via compiled dist/cli.js cleanly', () => {
    const repo = track(createLevel0BareRepo());
    const initRun = spawnSync('node', [CLI_PATH, 'init', repo.dir, '--dry-run', '--tools', 'claude-code,codex'], {
      encoding: 'utf8',
    });
    expect(initRun.status).toBe(0);
    expect(initRun.stdout).toContain('[dry-run]');
    expect(initRun.stdout).toContain('[CREATE] AGENTS.md');
    expect(initRun.stdout).toContain('[CREATE] CLAUDE.md');

    const promptOut = join(repo.dir, 'FIX.md');
    const promptRun = spawnSync('node', [CLI_PATH, repo.dir, '--prompt', '--out', promptOut, '--lang', 'pl'], {
      encoding: 'utf8',
    });
    expect(promptRun.status).toBe(0);
    expect(readFileSync(promptOut, 'utf8')).toContain('# HARNESS-FIX-PROMPT.md');
  });
});

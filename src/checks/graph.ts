import type { RepoContext } from '../fs-scanner.js';
import type { CheckResult } from '../types.js';

export function runGraphChecks(ctx: RepoContext): CheckResult[] {
  const results: CheckResult[] = [];
  const brief = `${ctx.readText('AGENTS.md') ?? ''}\n${ctx.readText('CLAUDE.md') ?? ''}`;

  // 1. graph.worktree-isolation
  {
    const wtScripts = ctx.findFiles(
      (f) => /^(bin|scripts)\/(wt|worktree)([.-].*)?$/.test(f) || f === '.worktreeinclude',
    );
    const pkgScripts = Object.keys(ctx.packageJson?.scripts ?? {}).filter((k) =>
      /worktree|\bwt\b/i.test(k),
    );
    const briefMentionsWorktree = /\bworktree\b/i.test(brief);

    const evidence: string[] = [];
    if (wtScripts.length > 0) evidence.push(`Worktree tooling: ${wtScripts.join(', ')}`);
    if (pkgScripts.length > 0) evidence.push(`Package scripts: ${pkgScripts.join(', ')}`);
    if (briefMentionsWorktree) evidence.push('Worktree workflow documented in root instructions');

    let status: CheckResult['status'] = 'warn';
    if (wtScripts.length > 0 || pkgScripts.length > 0) {
      status = 'pass';
    } else if (briefMentionsWorktree) {
      status = 'warn';
    } else {
      status = 'fail';
      evidence.push('No git worktree scripts, .worktreeinclude, or parallel checkout workflow documented');
    }

    results.push({
      id: 'graph.worktree-isolation',
      station: 'graph',
      weight: 35,
      status,
      severity: status === 'fail' ? 'medium' : 'low',
      title: {
        en: 'Git worktree isolation for parallel agents',
        pl: 'Izolacja git worktree dla równoległych agentów',
      },
      evidence,
      why: {
        en: 'Running two agents in the same working tree causes overwritten edits, dirty git states, and broken test runs.',
        pl: 'Uruchamianie wielu agentów w tym samym katalogu roboczym prowadzi do nadpisywania zmian, brudnego stanu gita i zafałszowanych testów.',
      },
      fix: {
        en: 'Add a lightweight worktree helper script (or document `git worktree` / `--worktree` conventions plus `.worktreeinclude` for local untracked config) in `AGENTS.md`.',
        pl: 'Dodaj prosty skrypt pomocniczy do worktree (lub opisz konwencję `git worktree` / `--worktree` wraz z `.worktreeinclude`) w `AGENTS.md`.',
      },
      docsPath: 'ladder/level-5-run-the-factory/',
    });
  }

  // 2. graph.port-and-state-isolation
  {
    const evidence: string[] = [];
    const envFiles = ['.env.example', '.env.test.example', '.dev.vars.example', '.wt-env'];
    let hasPortEnv = false;
    for (const ef of envFiles) {
      const content = ctx.readText(ef);
      if (content && /\b(PORT|APP_PORT|DEV_PORT|API_PORT|WEB_PORT)\s*=/m.test(content)) {
        hasPortEnv = true;
        evidence.push(`${ef} exposes configurable port variable(s)`);
      }
    }
    if (ctx.hasFile('.wt-env')) {
      evidence.push('.wt-env allocates per-worktree ports');
    }

    const hasEphemeralLocalState =
      ctx.hasFile('wrangler.toml') ||
      ctx.hasFile('docker-compose.yml') ||
      ctx.hasFile('docker-compose.yaml') ||
      ctx.hasDependency('testcontainers') ||
      ctx.hasDependency('@testcontainers/postgresql') ||
      ctx.hasDependency('better-sqlite3') ||
      ctx.hasDependency('@cloudflare/vitest-pool-workers') ||
      /sqlite|:memory:|testcontainers|miniflare|tmp_path|tmpdir/i.test(
        ctx.readText('vitest.config.ts') ??
          ctx.readText('vite.config.ts') ??
          ctx.readText('playwright.config.ts') ??
          ctx.readText('pyproject.toml') ??
          '',
      );

    if (hasEphemeralLocalState) {
      evidence.push('Local ephemeral / isolated runtime state detected (Miniflare, Docker, SQLite, Testcontainers, or tmpdir)');
    }

    const isPureLibrary =
      !ctx.hasDependency('next') &&
      !ctx.hasDependency('astro') &&
      !ctx.hasDependency('express') &&
      !ctx.hasDependency('fastify') &&
      !ctx.hasDependency('hono') &&
      !ctx.hasDependency('vite') &&
      !ctx.hasFile('wrangler.toml') &&
      !ctx.hasFile('docker-compose.yml');

    let status: CheckResult['status'] = 'warn';
    if (hasPortEnv && hasEphemeralLocalState) {
      status = 'pass';
    } else if (hasPortEnv || hasEphemeralLocalState || isPureLibrary) {
      status = isPureLibrary && !hasPortEnv && !hasEphemeralLocalState ? 'info' : 'pass';
      if (isPureLibrary && evidence.length === 0) {
        evidence.push('Library/CLI repository without long-running dev server ports');
      }
    } else {
      status = 'warn';
      evidence.push('No configurable PORT env vars or isolated local state setup detected for parallel checkouts');
    }

    results.push({
      id: 'graph.port-and-state-isolation',
      station: 'graph',
      weight: 35,
      status,
      severity: 'medium',
      title: {
        en: 'Port & local state isolation per checkout',
        pl: 'Izolacja portów i lokalnego stanu per checkout',
      },
      evidence,
      why: {
        en: 'Parallel worktrees collide immediately if every agent binds port 3000 or shares a single mutable local database.',
        pl: 'Równoległe worktree natychmiast ze sobą kolidują, jeśli każdy agent zajmuje port 3000 lub współdzieli jedną lokalną bazę danych.',
      },
      fix: {
        en: 'Parameterize dev/test server ports via env vars (`.env.example` / `.wt-env`) and give each checkout or test run ephemeral local state (Miniflare, SQLite, Testcontainers, or tmpdir).',
        pl: 'Sparametryzuj porty serwerów dev/test przez zmienne środowiskowe (`.env.example` / `.wt-env`) i zapewnij każdemu checkoutowi izolowany lokalny stan (Miniflare, SQLite, Testcontainers lub tmpdir).',
      },
      docsPath: 'workflows/harness/ephemeral-environments/',
    });
  }

  // 3. graph.subagent-definitions
  {
    const agentFiles = ctx.findFiles((f) =>
      /^(\.claude|\.cursor|\.codex)\/agents\/.+\.md$/i.test(f) ||
      /^\.factory\//.test(f) ||
      f === 'loops.yaml' ||
      f === 'loops.yml',
    );
    const orchestrationDocs = ctx.findFiles((f) =>
      /^(docs\/agents\/|scripts\/workflows\/)/i.test(f),
    );

    const evidence: string[] = [];
    if (agentFiles.length > 0) evidence.push(`Agent/loop definitions: ${agentFiles.slice(0, 6).join(', ')}`);
    if (orchestrationDocs.length > 0) evidence.push(`Agent docs/workflows: ${orchestrationDocs.slice(0, 5).join(', ')}`);

    const status: CheckResult['status'] =
      agentFiles.length > 0 ? 'pass' : orchestrationDocs.length > 0 ? 'warn' : 'info';
    if (evidence.length === 0) {
      evidence.push('No versioned subagent definitions (.claude/agents/, .cursor/agents/, .factory/, loops.yaml) yet');
    }

    results.push({
      id: 'graph.subagent-definitions',
      station: 'graph',
      weight: 20,
      status,
      severity: 'low',
      title: {
        en: 'Subagent & loop topology definitions',
        pl: 'Definicje podagentów i topologii pętli',
      },
      evidence,
      why: {
        en: 'Separating planner, builder, and reviewer roles into committed agent specs (or a `loops.yaml` register) prevents context pollution and unreviewed self-approval.',
        pl: 'Rozdzielenie ról planisty, wykonawcy i recenzenta na wersjonowane definicje agentów (lub rejestr `loops.yaml`) zapobiega zaśmiecaniu kontekstu i samozatwierdzaniu.',
      },
      fix: {
        en: 'When scaling to multi-agent runs, commit focused agent specs under `.claude/agents/` (e.g., read-only reviewer, test verifier) and track unattended loops in `loops.yaml`.',
        pl: 'Przy przechodzeniu na pracę wieloagentową dodaj wyspecjalizowane definicje w `.claude/agents/` (np. recenzent read-only, weryfikator testów) i opisz pętle w `loops.yaml`.',
      },
      docsPath: 'workflows/automate/orchestration-patterns/',
    });
  }

  // 4. graph.workspace-boundaries
  {
    const boundaryArtifacts: string[] = [];
    for (const f of ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'go.work', 'ARCHITECTURE.md']) {
      if (ctx.hasFile(f)) boundaryArtifacts.push(f);
    }
    if (ctx.packageJson?.workspaces) boundaryArtifacts.push('package.json workspaces');
    if (/\[workspace\]/.test(ctx.readText('Cargo.toml') ?? '')) boundaryArtifacts.push('Cargo.toml [workspace]');
    if (/^##\s+(Architecture|Directory|Structure|Read before you touch|Modules)/im.test(brief)) {
      boundaryArtifacts.push('Module/ownership map in root brief');
    }

    const status: CheckResult['status'] =
      boundaryArtifacts.length > 0 ? 'pass' : ctx.stack.monorepo ? 'fail' : 'warn';

    results.push({
      id: 'graph.workspace-boundaries',
      station: 'graph',
      weight: 10,
      status,
      severity: status === 'fail' ? 'medium' : 'low',
      title: {
        en: 'Explicit module & workspace boundaries',
        pl: 'Jawne granice modułów i workspace’ów',
      },
      evidence:
        boundaryArtifacts.length > 0
          ? boundaryArtifacts
          : ['No explicit workspace config, ARCHITECTURE.md, or module ownership map in AGENTS.md'],
      why: {
        en: 'Clear module boundaries let you assign disjoint ownership slices to parallel agents without merge conflicts.',
        pl: 'Jasne granice modułów pozwalają przydzielać równoległym agentom rozłączne obszary odpowiedzialności bez konfliktów przy scalaniu.',
      },
      fix: {
        en: 'Add a short "Read before you touch" or module boundary table in `AGENTS.md` (or `ARCHITECTURE.md`) mapping directories to invariants and owners.',
        pl: 'Dodaj krótką tabelę granic modułów („Read before you touch”) w `AGENTS.md` (lub `ARCHITECTURE.md`), wiążącą katalogi z ich niezmiennikami i właścicielami.',
      },
      docsPath: 'workflows/build/',
    });
  }

  return results;
}

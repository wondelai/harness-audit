import type { RepoContext } from '../fs-scanner.js';
import type { CheckResult } from '../types.js';

const ARCHIVED_OR_BROKEN_MCP_PACKAGES: Array<{ pkg: string; note: string }> = [
  { pkg: '@modelcontextprotocol/server-postgres', note: 'archived / unmaintained reference server' },
  { pkg: '@modelcontextprotocol/server-sqlite', note: 'does not exist on npm (Python-only reference, archived)' },
  { pkg: '@modelcontextprotocol/server-mysql', note: 'does not exist on npm' },
  { pkg: '@modelcontextprotocol/server-slack', note: 'archived reference server' },
  { pkg: '@modelcontextprotocol/server-git', note: 'not an npm package (Python uvx mcp-server-git only)' },
  { pkg: '@modelcontextprotocol/server-jira', note: 'does not exist on npm' },
  { pkg: '@modelcontextprotocol/server-puppeteer', note: 'archived — use Playwright MCP instead' },
  { pkg: '@modelcontextprotocol/server-github', note: 'archived — use official GitHub remote/Go MCP server' },
];

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'OpenAI API key', regex: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'GitHub PAT', regex: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { name: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/ },
  { name: 'Private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'Polar OAT token', regex: /\bpolar_oat_[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Polar webhook secret', regex: /\bpolar_whs_[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Resend API key', regex: /\bre_[A-Za-z0-9]{24,}\b/ },
];

function isPlaceholderToken(match: string): boolean {
  const lower = match.toLowerCase();
  return (
    lower.includes('example') ||
    lower.includes('placeholder') ||
    lower.includes('dummy') ||
    lower.includes('xxxxx') ||
    lower.includes('your_') ||
    lower.includes('test_key') ||
    /\$\{[^}]+\}/.test(match)
  );
}

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
    defaultMode?: string;
  };
  hooks?: Record<string, unknown>;
  sandbox?: Record<string, unknown>;
}

export function runHarnessChecks(ctx: RepoContext): CheckResult[] {
  const results: CheckResult[] = [];

  const claudeSettings = ctx.readJson<ClaudeSettings>('.claude/settings.json');
  const codexToml = ctx.readText('.codex/config.toml');
  const cursorCliConfig = ctx.readJson<Record<string, unknown>>('.cursor/cli.json');

  // 1. harness.permissions-policy
  {
    const evidence: string[] = [];
    const criticalErrors: string[] = [];
    let hasPolicy = false;

    if (claudeSettings) {
      const allow = claudeSettings.permissions?.allow ?? [];
      const deny = claudeSettings.permissions?.deny ?? [];
      const defaultMode = claudeSettings.permissions?.defaultMode;
      if (allow.length > 0 || deny.length > 0 || claudeSettings.sandbox) {
        hasPolicy = true;
        evidence.push(
          `.claude/settings.json: ${allow.length} allow rules, ${deny.length} deny rules${claudeSettings.sandbox ? ', sandbox configured' : ''}`,
        );
      }
      if (defaultMode === 'bypassPermissions') {
        criticalErrors.push('.claude/settings.json sets permissions.defaultMode = "bypassPermissions"');
      }
    }

    if (codexToml !== null) {
      if (/^\s*approval_policy\s*=\s*["']untrusted["']/m.test(codexToml)) {
        criticalErrors.push(
          '.codex/config.toml uses retired `approval_policy = "untrusted"` (removed in Codex 0.149.0 — fails at startup)',
        );
      }
      const approvalMatch = codexToml.match(/^\s*approval_policy\s*=\s*["']([^"']+)["']/m);
      const sandboxMatch = codexToml.match(/^\s*sandbox_mode\s*=\s*["']([^"']+)["']/m);
      const profileMatch = codexToml.match(/^\s*default_permissions\s*=\s*["']([^"']+)["']/m);
      if (approvalMatch || sandboxMatch || profileMatch) {
        hasPolicy = true;
        const parts = [
          approvalMatch ? `approval_policy=${approvalMatch[1]}` : '',
          sandboxMatch ? `sandbox_mode=${sandboxMatch[1]}` : '',
          profileMatch ? `default_permissions=${profileMatch[1]}` : '',
        ].filter(Boolean);
        evidence.push(`.codex/config.toml: ${parts.join(', ')}`);
      }
      if (/dangerously-bypass-approvals-and-sandbox/.test(codexToml)) {
        criticalErrors.push('.codex/config.toml references dangerously-bypass-approvals-and-sandbox');
      }
    }

    if (cursorCliConfig) {
      hasPolicy = true;
      evidence.push('.cursor/cli.json present');
    }

    // Check scripts/workflows for dangerous bypass flags outside disposable containers/warnings
    const claudeSettingsRaw = ctx.readText('.claude/settings.json') ?? '';
    if (/--dangerously-skip-permissions/.test(claudeSettingsRaw)) {
      criticalErrors.push('.claude/settings.json contains --dangerously-skip-permissions');
    }

    let status: CheckResult['status'] = 'warn';
    if (criticalErrors.length > 0) {
      status = 'fail';
      evidence.push(...criticalErrors);
    } else if (hasPolicy) {
      const hasDeny = (claudeSettings?.permissions?.deny?.length ?? 0) > 0;
      const hasCodexPolicy = Boolean(
        codexToml && /^\s*(approval_policy|sandbox_mode|default_permissions)\s*=/m.test(codexToml),
      );
      status = hasDeny || hasCodexPolicy || Boolean(claudeSettings?.sandbox) ? 'pass' : 'warn';
      if (status === 'warn') {
        evidence.push('Allow rules exist, but no explicit deny rules or sandbox policy configured');
      }
    } else {
      status = 'fail';
      evidence.push('No versioned agent permission policy found (.claude/settings.json, .codex/config.toml, or .cursor/cli.json)');
    }

    results.push({
      id: 'harness.permissions-policy',
      station: 'harness',
      weight: 25,
      status,
      severity: criticalErrors.length > 0 ? 'critical' : status === 'fail' ? 'high' : 'medium',
      title: {
        en: 'Versioned permission & approval policy',
        pl: 'Wersjonowana polityka uprawnień i zatwierdzania',
      },
      evidence,
      why: {
        en: 'An explicit allow/deny policy lets agents run routine verify commands without constant prompts while blocking destructive or production commands.',
        pl: 'Jawna polityka allow/deny pozwala agentom uruchamiać rutynowe komendy weryfikacji bez ciągłych pytań, blokując jednocześnie komendy produkcyjne lub destrukcyjne.',
      },
      fix: {
        en: criticalErrors.length > 0
          ? 'Replace retired Codex `approval_policy = "untrusted"` with `"on-request"` (or `"never"` only in isolated CI) and remove any `bypassPermissions` defaults from repo settings.'
          : 'Commit `.claude/settings.json` with explicit `permissions.allow` (test/lint/typecheck) and `permissions.deny` (deploy/prod scripts), and/or `.codex/config.toml` with `approval_policy = "on-request"` and `sandbox_mode = "workspace-write"`.',
        pl: criticalErrors.length > 0
          ? 'Zastąp wycofane w Codex `approval_policy = "untrusted"` wartością `"on-request"` (lub `"never"` tylko w izolowanym CI) i usuń domyślne `bypassPermissions` z konfiguracji repozytorium.'
          : 'Dodaj `.claude/settings.json` z jawną listą `permissions.allow` (test/lint/typecheck) oraz `permissions.deny` (deploy/produkcja) i/lub `.codex/config.toml` z `approval_policy = "on-request"` oraz `sandbox_mode = "workspace-write"`.',
      },
      docsPath: 'workflows/harness/permissions-and-sandboxing/',
      meta: {
        hasCriticalPermissionError: criticalErrors.length > 0,
      },
    });
  }

  // 2. harness.hooks
  {
    const evidence: string[] = [];
    const hookIssues: string[] = [];
    let hasAgentHooks = false;
    let hasGitHooks = false;

    if (claudeSettings?.hooks && Object.keys(claudeSettings.hooks).length > 0) {
      hasAgentHooks = true;
      const events = Object.keys(claudeSettings.hooks);
      evidence.push(`.claude/settings.json hooks: ${events.join(', ')}`);

      // Inspect Stop hook for stop_hook_active infinite loop guard
      const stopHookSection = claudeSettings.hooks['Stop'];
      if (stopHookSection) {
        const serialized = JSON.stringify(stopHookSection);
        // Check inline command OR referenced script file
        let guardsLoop = /stop_hook_active/.test(serialized);
        if (!guardsLoop) {
          // Try reading local script paths referenced in the Stop hook command
          const scriptMatches = serialized.match(/(?:\.claude\/hooks\/|scripts\/)[A-Za-z0-9._/-]+/g) ?? [];
          for (const sp of scriptMatches) {
            const scriptBody = ctx.readText(sp);
            if (scriptBody && /stop_hook_active/.test(scriptBody)) {
              guardsLoop = true;
              break;
            }
          }
        }
        if (!guardsLoop) {
          hookIssues.push(
            'Claude Code Stop hook does not appear to check `stop_hook_active` — risks blocking in an infinite loop on red runs',
          );
        } else {
          evidence.push('Stop hook guards `stop_hook_active` against infinite blocking loops');
        }
      }
    }

    if (ctx.hasFile('.cursor/hooks.json')) {
      hasAgentHooks = true;
      evidence.push('.cursor/hooks.json present');
    }

    const huskyFiles = ctx.findFiles((f) => /^\.husky\/[^.]/.test(f));
    const gitHookConfigs = [
      huskyFiles.length > 0 ? `.husky/ (${huskyFiles.length} hooks)` : '',
      ctx.hasFile('lefthook.yml') || ctx.hasFile('.lefthook.yml') ? 'lefthook.yml' : '',
      ctx.hasFile('.pre-commit-config.yaml') ? '.pre-commit-config.yaml' : '',
      ctx.findFiles((f) => /^\.githooks\//.test(f)).length > 0 ? '.githooks/' : '',
    ].filter(Boolean);

    if (gitHookConfigs.length > 0) {
      hasGitHooks = true;
      evidence.push(`Git hooks: ${gitHookConfigs.join(', ')}`);
    }

    let status: CheckResult['status'] = 'warn';
    if (hookIssues.length > 0) {
      status = 'fail';
      evidence.push(...hookIssues);
    } else if (hasAgentHooks || hasGitHooks) {
      status = 'pass';
    } else {
      status = 'warn';
      evidence.push('No deterministic agent hooks (.claude/settings.json hooks, .cursor/hooks.json) or git hooks (.husky, lefthook, pre-commit) detected');
    }

    results.push({
      id: 'harness.hooks',
      station: 'harness',
      weight: 20,
      status,
      severity: hookIssues.length > 0 ? 'high' : status === 'warn' ? 'medium' : 'low',
      title: {
        en: 'Deterministic lifecycle & git hooks',
        pl: 'Deterministyczne hooki cyklu życia i hooki Git',
      },
      evidence,
      why: {
        en: 'Prompt instructions are advisory; hooks turn critical checks (format, lint, targeted tests, secret guards) into deterministic enforcement.',
        pl: 'Instrukcje w prompcie mają charakter doradczy — hooki zamieniają kluczowe sprawdzenia (format, lint, szybkie testy, ochrona sekretów) w twardą egzekucję.',
      },
      fix: {
        en: hookIssues.length > 0
          ? 'Check `stop_hook_active` from stdin JSON at the top of your Stop hook and exit 0 when true so failed runs stop cleanly.'
          : 'Add deterministic hooks via `.claude/settings.json` (`PostToolUse` / guarded `Stop`) and/or `lefthook.yml` / `.husky/` for fast pre-commit checks.',
        pl: hookIssues.length > 0
          ? 'Sprawdzaj pole `stop_hook_active` z JSON na stdin na początku hooka `Stop` i zwracaj kod 0, gdy ma wartość true, aby uniknąć pętli nieskończonej.'
          : 'Dodaj deterministyczne hooki w `.claude/settings.json` (`PostToolUse` / zabezpieczony `Stop`) oraz/lub `lefthook.yml` / `.husky/` dla szybkich sprawdzeń przed commitem.',
      },
      docsPath: 'workflows/harness/',
    });
  }

  // 3. harness.mcp-hygiene
  {
    const mcpFiles: string[] = [];
    if (ctx.hasFile('.mcp.json')) mcpFiles.push('.mcp.json');
    if (ctx.hasFile('.cursor/mcp.json')) mcpFiles.push('.cursor/mcp.json');
    if (ctx.hasFile('.claude/mcp.json')) mcpFiles.push('.claude/mcp.json');
    const codexHasMcp = Boolean(codexToml && /\[mcp_servers\./.test(codexToml));
    if (codexHasMcp) mcpFiles.push('.codex/config.toml');

    const issues: string[] = [];
    const warnings: string[] = [];
    const okNotes: string[] = [];

    if (ctx.hasFile('.claude/mcp.json')) {
      warnings.push('Misplaced `.claude/mcp.json` — Claude Code reads `.mcp.json` at the repo root, not `.claude/mcp.json`');
    }

    for (const file of mcpFiles) {
      const raw = ctx.readText(file) ?? '';
      okNotes.push(`Inspected ${file}`);

      // Check archived/broken npm packages
      for (const bad of ARCHIVED_OR_BROKEN_MCP_PACKAGES) {
        if (raw.includes(bad.pkg)) {
          issues.push(`${file}: references \`${bad.pkg}\` (${bad.note})`);
        }
      }

      // Check deprecated /sse transport
      if (/["']https?:\/\/[^"']+\/sse["']/.test(raw) || /"type"\s*:\s*"sse"/.test(raw)) {
        warnings.push(`${file}: uses deprecated SSE transport (/sse) — prefer Streamable HTTP (type: "http")`);
      }

      // Check hardcoded Bearer tokens or plaintext secrets in MCP config
      const bearerMatch = raw.match(/Bearer\s+(?!\$\{)([A-Za-z0-9._-]{12,})/);
      if (bearerMatch && !isPlaceholderToken(bearerMatch[0])) {
        issues.push(`${file}: hardcoded Authorization Bearer token instead of \${VAR} env interpolation`);
      }
      for (const sp of SECRET_PATTERNS) {
        const m = raw.match(sp.regex);
        if (m && !isPlaceholderToken(m[0])) {
          issues.push(`${file}: hardcoded ${sp.name} in MCP configuration`);
        }
      }

      // Check .cursor/mcp.json stdio entries for required `type` or plaintext secrets in env
      if (file === '.cursor/mcp.json' || file === '.mcp.json') {
        const parsed = ctx.readJson<{ mcpServers?: Record<string, Record<string, unknown>> }>(file);
        const servers = parsed?.mcpServers;
        if (servers && typeof servers === 'object') {
          for (const [serverName, cfg] of Object.entries(servers)) {
            if (!cfg || typeof cfg !== 'object') continue;
            if (file === '.cursor/mcp.json' && cfg['command'] && !cfg['type']) {
              warnings.push(`.cursor/mcp.json (${serverName}): missing explicit \`type: "stdio"\` on stdio server entry`);
            }
            const envObj = cfg['env'];
            if (envObj && typeof envObj === 'object') {
              for (const [k, v] of Object.entries(envObj as Record<string, unknown>)) {
                if (
                  typeof v === 'string' &&
                  /(TOKEN|SECRET|KEY|PASSWORD|API_KEY)/i.test(k) &&
                  v.length >= 16 &&
                  !v.includes('${') &&
                  !isPlaceholderToken(v)
                ) {
                  issues.push(`${file} (${serverName}.env.${k}): plaintext secret instead of \${${k}} / \${env:${k}}`);
                }
              }
            }
          }
        }
      }
    }

    let status: CheckResult['status'] = 'pass';
    const evidence: string[] = [];
    if (mcpFiles.length === 0) {
      status = 'info';
      evidence.push('No project MCP config files (.mcp.json, .cursor/mcp.json, .codex/config.toml) — clean zero-bloat default');
    } else if (issues.length > 0) {
      status = 'fail';
      evidence.push(...issues, ...warnings);
    } else if (warnings.length > 0) {
      status = 'warn';
      evidence.push(...warnings, ...okNotes);
    } else {
      status = 'pass';
      evidence.push(`${okNotes.join(', ')} — no broken packages, deprecated /sse, or hardcoded tokens found`);
    }

    results.push({
      id: 'harness.mcp-hygiene',
      station: 'harness',
      weight: 20,
      status,
      severity: issues.length > 0 ? 'critical' : warnings.length > 0 ? 'medium' : 'low',
      title: {
        en: 'MCP server & transport hygiene',
        pl: 'Higiena konfiguracji serwerów MCP',
      },
      evidence,
      why: {
        en: 'Broken or archived MCP servers silently fail at session startup, deprecated `/sse` endpoints break across clients, and hardcoded tokens leak credentials in git.',
        pl: 'Wycofane lub nieistniejące serwery MCP psują start sesji, przestarzałe endpointy `/sse` przestają działać, a wpisane na sztywno tokeny powodują wyciek sekretów w gicie.',
      },
      fix: {
        en: issues.length > 0 || warnings.length > 0
          ? 'Remove archived `@modelcontextprotocol/server-*` entries, migrate `/sse` to Streamable HTTP (`type: "http"`), replace plaintext secrets with `${VAR}` / `${env:VAR}`, and keep Claude Code MCP config in root `.mcp.json`.'
          : 'Keep MCP configs lean, prefer official vendor MCP servers from the MCP registry, and always interpolate credentials via env vars.',
        pl: issues.length > 0 || warnings.length > 0
          ? 'Usuń zarchiwizowane pakiety `@modelcontextprotocol/server-*`, zmigruj `/sse` na Streamable HTTP (`type: "http"`), zastąp jawne sekrety zmiennymi `${VAR}` / `${env:VAR}` i trzymaj konfigurację Claude Code w głównym `.mcp.json`.'
          : 'Utrzymuj konfiguracje MCP zwięzłe, korzystaj z oficjalnych serwerów z rejestru MCP i zawsze przekazuj sekrety przez zmienne środowiskowe.',
      },
      docsPath: 'workflows/harness/permissions-and-sandboxing/',
      meta: {
        hasHardcodedMcpSecrets: issues.some((i) => /token|secret|key/i.test(i)),
      },
    });
  }

  // 4. harness.secret-hygiene
  {
    const gitignore = ctx.readText('.gitignore') ?? '';
    const hasWrangler = ctx.hasFile('wrangler.toml') || ctx.hasFile('wrangler.jsonc') || ctx.hasFile('wrangler.json');
    const missingIgnores: string[] = [];
    if (!/(^|\n)\s*\.env(\b|\.|\/|\*|$)/m.test(gitignore)) missingIgnores.push('.env');
    if (!/(^|\n)\s*(\.env\.local|\.env\.\*|\.env\*)/m.test(gitignore)) missingIgnores.push('.env.local');
    if (hasWrangler && !/(^|\n)\s*\.dev\.vars/m.test(gitignore)) missingIgnores.push('.dev.vars');
    if (!/(^|\n)\s*(\*\.pem|\*\.key)/m.test(gitignore)) missingIgnores.push('*.pem / *.key');

    const envExamples = ['.env.example', '.env.sample', '.env.template', '.dev.vars.example'].filter((f) =>
      ctx.hasFile(f),
    );

    // Scan config & root files (not tests or fixtures) for accidental hardcoded credentials
    const scanCandidates = ctx.findFiles((f) => {
      if (/(^|\/)(tests?|__tests__|fixtures?|mocks?)\//.test(f)) return false;
      if (f.endsWith('.lock') || f.endsWith('package-lock.json') || f.endsWith('pnpm-lock.yaml')) return false;
      return (
        /^(AGENTS|CLAUDE|README)\.md$/i.test(f) ||
        /^\.(claude|codex|cursor|github)\//.test(f) ||
        /\.(json|toml|ya?ml|env\.example|sh)$/.test(f)
      );
    }).slice(0, 120);

    const leakedSecrets: string[] = [];
    for (const file of scanCandidates) {
      const content = ctx.readText(file);
      if (!content) continue;
      for (const sp of SECRET_PATTERNS) {
        const match = content.match(sp.regex);
        if (match && !isPlaceholderToken(match[0])) {
          leakedSecrets.push(`${file}: possible hardcoded ${sp.name}`);
          break;
        }
      }
    }

    // Check CI or hooks for secret scanning (gitleaks / trufflehog / secretlint)
    const workflowFiles = ctx.findFiles((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f) || f === '.gitlab-ci.yml');
    const hasSecretScanner = workflowFiles.some((wf) => {
      const content = ctx.readText(wf) ?? '';
      return /\b(gitleaks|trufflehog|secretlint|detect-secrets)\b/i.test(content);
    }) || ctx.hasFile('.gitleaks.toml');

    const evidence: string[] = [];
    if (leakedSecrets.length > 0) evidence.push(...leakedSecrets.slice(0, 5));
    if (missingIgnores.length > 0) evidence.push(`.gitignore missing patterns: ${missingIgnores.join(', ')}`);
    else evidence.push('.gitignore covers .env, .env.local, and private key files');
    if (envExamples.length > 0) evidence.push(`Template env files: ${envExamples.join(', ')}`);
    if (hasSecretScanner) evidence.push('Secret scanner configured (gitleaks/trufflehog/secretlint)');

    let status: CheckResult['status'] = 'pass';
    if (leakedSecrets.length > 0) {
      status = 'fail';
    } else if (missingIgnores.includes('.env') || missingIgnores.includes('.dev.vars')) {
      status = 'fail';
    } else if (missingIgnores.length > 0) {
      status = 'warn';
    }

    results.push({
      id: 'harness.secret-hygiene',
      station: 'harness',
      weight: 20,
      status,
      severity: leakedSecrets.length > 0 ? 'critical' : status === 'fail' ? 'high' : 'low',
      title: {
        en: 'Secret hygiene & ignore rules',
        pl: 'Higiena sekretów i reguły .gitignore',
      },
      evidence,
      why: {
        en: 'Coding agents frequently run `git add` or generate env files; missing `.gitignore` rules or plaintext keys in config lead directly to credential leaks.',
        pl: 'Agenci kodujący często uruchamiają `git add` lub tworzą pliki env; brak reguł `.gitignore` lub jawne klucze w konfiguracji prowadzą wprost do wycieku poświadczeń.',
      },
      fix: {
        en: leakedSecrets.length > 0
          ? 'Rotate any exposed credentials immediately, remove them from tracked files, and load them via environment variables.'
          : 'Add `.env`, `.env.local`, `*.pem`, `*.key` (and `.dev.vars` for Cloudflare) to `.gitignore`, commit `.env.example`, and add `gitleaks` in CI.',
        pl: leakedSecrets.length > 0
          ? 'Natychmiast zrotuj ujawnione klucze, usuń je z wersjonowanych plików i ładuj przez zmienne środowiskowe.'
          : 'Dodaj `.env`, `.env.local`, `*.pem`, `*.key` (oraz `.dev.vars` dla Cloudflare) do `.gitignore`, dodaj `.env.example` i włącz `gitleaks` w CI.',
      },
      docsPath: 'org/agent-identity-and-secrets/',
      meta: {
        hasHardcodedSecrets: leakedSecrets.length > 0,
      },
    });
  }

  // 5. harness.sandbox-readiness
  {
    const sandboxArtifacts: string[] = [];
    if (ctx.findFiles((f) => /^\.devcontainer\//.test(f)).length > 0) sandboxArtifacts.push('.devcontainer/');
    if (ctx.hasAnyFile(['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'])) {
      sandboxArtifacts.push('Docker / Compose');
    }
    if (ctx.hasAnyFile(['flake.nix', 'shell.nix'])) sandboxArtifacts.push('Nix shell');
    if (claudeSettings?.sandbox) sandboxArtifacts.push('.claude/settings.json sandbox');
    if (codexToml && /^\s*sandbox_mode\s*=/m.test(codexToml)) sandboxArtifacts.push('.codex/config.toml sandbox_mode');

    const brief = `${ctx.readText('AGENTS.md') ?? ''}\n${ctx.readText('CLAUDE.md') ?? ''}`;
    const hasProdBoundaryNotes =
      /\b(production|prod|remote|deploy|shared)\b/i.test(brief) &&
      /\b(never|do not|don't|forbidden|shared|deny)\b/i.test(brief);
    if (hasProdBoundaryNotes) {
      sandboxArtifacts.push('Production / shared-resource boundary documented in root brief');
    }

    const status: CheckResult['status'] =
      sandboxArtifacts.length >= 2 ? 'pass' : sandboxArtifacts.length === 1 ? 'warn' : 'fail';

    results.push({
      id: 'harness.sandbox-readiness',
      station: 'harness',
      weight: 15,
      status,
      severity: status === 'fail' ? 'medium' : 'low',
      title: {
        en: 'Sandbox & production boundary readiness',
        pl: 'Gotowość piaskownicy i granice środowiska produkcyjnego',
      },
      evidence:
        sandboxArtifacts.length > 0
          ? sandboxArtifacts
          : ['No devcontainer/Docker/Nix sandbox config, tool sandbox settings, or production boundary rules found'],
      why: {
        en: 'Higher-autonomy runs need an OS/container boundary plus clear written boundaries around shared cloud resources (prod DBs, deploy targets, live webhooks).',
        pl: 'Uruchomienia o wyższej autonomii wymagają izolacji kontenerowej/OS oraz jasnych granic chroniących współdzielone zasoby chmurowe (baza produkcyjna, deploy, webhooki).',
      },
      fix: {
        en: 'Add sandbox configuration (`.devcontainer/`, `Dockerfile`, `.claude/settings.json` `sandbox`, or `.codex/config.toml` `sandbox_mode`) and document shared production resources agents must never mutate.',
        pl: 'Dodaj konfigurację piaskownicy (`.devcontainer/`, `Dockerfile`, `sandbox` w `.claude/settings.json` lub `sandbox_mode` w `.codex/config.toml`) i opisz w `AGENTS.md` zasoby produkcyjne, których agentom nie wolno dotykać.',
      },
      docsPath: 'workflows/harness/permissions-and-sandboxing/',
    });
  }

  return results;
}

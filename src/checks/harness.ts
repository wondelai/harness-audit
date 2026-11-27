import { localDeployCommands, minimalVerifySet } from '../capabilities.js';
import { scanBoundaries } from '../brief.js';
import { stripJsonComments, type RepoContext } from '../fs-scanner.js';
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
  { name: 'OpenRouter API key', regex: /\bsk-or-v1-[A-Za-z0-9]{32,}\b/ },
  { name: 'Stripe secret key', regex: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/ },
  { name: 'OpenAI API key', regex: /\bsk-(?:proj-|live-|svcacct-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'npm token', regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'PostHog personal API key', regex: /\bphx_[A-Za-z0-9]{32,}\b/ },
  { name: 'GitHub PAT', regex: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { name: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/ },
  { name: 'Private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'Polar OAT token', regex: /\bpolar_oat_[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Polar webhook secret', regex: /\bpolar_whs_[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Resend API key', regex: /\bre_[A-Za-z0-9]{24,}\b/ },
];

/**
 * A variable whose name says credential and whose value looks like one, whatever the provider:
 * `FAL_KEY = "a1b2…"` in wrangler.toml `[vars]`, `API_TOKEN=…` in a tracked env file.
 * Names that are public by design (publishable keys, site keys, client ids) are left alone.
 */
const NAMED_CREDENTIAL = /^\s*(?:export\s+)?["']?([A-Za-z][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?))["']?\s*[:=]\s*["']?([^"'\s]{20,})["']?\s*,?\s*(?:#.*)?$/;
const PUBLIC_BY_DESIGN = /PUBLIC|PUBLISHABLE|SITE_?KEY|CLIENT_?ID|ANON|PROJECT_?(API_)?KEY|WRITE_?KEY|DSN|KEY_?ID|ACCESS_KEY_ID/i;

function looksLikeCredential(value: string): boolean {
  if (/^(phc_|pk_(live|test)_|G-|UA-|GTM-|ca-pub-|https?:)/.test(value)) return false;
  // Letters and digits mixed, no spaces: a hash, a token. Plain words and paths are not.
  return /[A-Za-z]/.test(value) && /\d/.test(value) && !/^[a-z]+(?:[-_.][a-z]+)*$/.test(value) && !value.includes('/') ;
}

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

/**
 * A PreToolUse hook that inspects shell commands in code: its command line, or the script it runs,
 * mentions deploys, wrangler or `--remote`. Such a hook is a permission policy written as a program.
 */
export function guardHooks(ctx: RepoContext): string[] {
  const settings = ctx.readJson<ClaudeSettings>('.claude/settings.json');
  const pre = settings?.hooks?.['PreToolUse'];
  if (!pre) return [];
  const serialized = JSON.stringify(pre);
  const guards: string[] = [];
  for (const path of new Set(serialized.match(/(?:\.claude\/hooks|scripts|bin|\.github\/scripts)\/[\w./-]+/g) ?? [])) {
    const body = ctx.readText(path);
    if (body && /deploy|wrangler|--remote|publish|force/i.test(body)) guards.push(path);
  }
  if (guards.length === 0 && /deploy|wrangler|--remote/i.test(serialized)) guards.push('.claude/settings.json PreToolUse command');
  return guards;
}

/** Bindings that are a remote service with no local emulator and no stored data: running them remotely is the only way. */
const SERVICE_BINDINGS = new Set(['ai', 'browser', 'images', 'send_email', 'version_metadata']);

/**
 * The bindings a Worker config marks `remote: true`, split into those that hold data (D1, KV, R2,
 * queues, Vectorize: a local run writes the real thing) and remote-only services (Workers AI,
 * Browser Rendering: quota, not data). Comments are not configuration.
 */
export function remoteBindings(path: string, config: string): { stores: string[]; services: string[] } {
  const text = path.endsWith('.toml')
    ? config.split(/\r?\n/).map((l) => (/^\s*#/.test(l) ? '' : l.replace(/\s+#[^"']*$/, ''))).join('\n')
    : stripJsonComments(config);
  const stores: string[] = [];
  const services: string[] = [];
  const HEADER = /^\s*\[\[?([\w.-]+)\]\]?\s*$|"([\w-]+)"\s*:\s*[\[{]|^\s*([\w-]+)\s*=\s*\{/gm;
  for (const hit of text.matchAll(/"?\bremote"?\s*[:=]\s*true\b/g)) {
    // The nearest table or key above the flag names the binding kind (`[[d1_databases]]`, `"ai": {`).
    const headers = [...text.slice(0, hit.index).matchAll(HEADER)].map((m) => (m[1] ?? m[2] ?? m[3] ?? '').split('.').pop()!.toLowerCase());
    const kind = headers.pop() ?? 'binding';
    (SERVICE_BINDINGS.has(kind) ? services : stores).push(kind);
  }
  return { stores, services };
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
    const verifyAllows = minimalVerifySet(ctx.verify).slice(0, 3).map((c) => `Bash(${c}:*)`);
    const allowExample = verifyAllows.length > 0 ? verifyAllows.map((a) => `\`${a}\``).join(', ') : '`Bash(<your test command>)`';

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

    // settings.local.json is one person's machine: committed, it becomes everyone's silent policy.
    const committedLocal = ctx.isTracked('.claude/settings.local.json') === true;
    const denyCount = claudeSettings?.permissions?.deny?.length ?? 0;
    const deployDenies = localDeployCommands(ctx).map((c) => `\`Bash(${c}:*)\``);
    // Nothing deploys from here (a library, a mobile app): force pushes and secret files are what is left to deny.
    const denyExample = deployDenies.length > 0 ? deployDenies.slice(0, 3).join(', ') : '`Bash(git push --force:*)` and `Read(./.env)`';
    // A committed policy needs a path git will take: `.claude/` in .gitignore swallows settings.json too.
    const settingsIgnored = !claudeSettings && ctx.ignoredPaths(['.claude/settings.json']).size > 0;
    const unignore = {
      en: settingsIgnored ? ' Git ignores `.claude/` here, so first change that rule to `.claude/*` and add `!.claude/settings.json`.' : '',
      pl: settingsIgnored ? ' Git ignoruje tu `.claude/`, więc najpierw zmień tę regułę na `.claude/*` i dodaj `!.claude/settings.json`.' : '',
    };

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
    } else if (guardHooks(ctx).length > 0) {
      // No allow/deny lists, but the rules exist as code that runs before every shell command.
      status = 'warn';
      evidence.push(`No permissions.allow / permissions.deny, but a PreToolUse guard decides on shell commands: ${guardHooks(ctx).join(', ')}`);
    } else {
      status = 'fail';
      if (claudeSettings) {
        const holds = Object.keys(claudeSettings).filter((k) => k !== '$schema');
        evidence.push(
          `.claude/settings.json is committed (${holds.join(', ') || 'empty'}) but sets no permissions.allow / permissions.deny`,
        );
      } else if (ctx.isLocalOnly('.claude/settings.json')) {
        evidence.push('.claude/settings.json exists on this machine but git ignores it — the policy is not shared with teammates or CI agents');
      } else if (settingsIgnored) {
        evidence.push('No versioned agent permission policy, and .gitignore excludes .claude/ so a settings.json could not be committed as things stand');
      } else {
        evidence.push('No versioned agent permission policy found (.claude/settings.json, .codex/config.toml, or .cursor/cli.json)');
      }
    }

    if (committedLocal) {
      evidence.push('.claude/settings.local.json is committed: personal settings are now shared; move the rules everyone needs into settings.json and gitignore the local file');
      if (status === 'pass') status = 'warn';
    }
    // The fix follows the evidence: never "create" a file that exists, never ask for rules that are there.
    const permissionFix =
      criticalErrors.length > 0
        ? {
            en: 'Replace retired Codex `approval_policy = "untrusted"` with `"on-request"` (or `"never"` only in isolated CI) and remove any `bypassPermissions` defaults from repo settings.',
            pl: 'Zastąp wycofane w Codex `approval_policy = "untrusted"` wartością `"on-request"` (lub `"never"` tylko w izolowanym CI) i usuń domyślne `bypassPermissions` z konfiguracji repozytorium.',
          }
        : hasPolicy && denyCount === 0 && status !== 'pass'
          ? {
              en: `The allow list is there; add \`permissions.deny\` for what must never run from an agent session: ${denyExample}, plus force pushes.${committedLocal ? ' Gitignore `.claude/settings.local.json`.' : ''}`,
              pl: `Lista allow już jest; dodaj \`permissions.deny\` dla komend, których sesja agenta nie może uruchomić: ${denyExample} oraz force push.${committedLocal ? ' Dodaj `.claude/settings.local.json` do .gitignore.' : ''}`,
            }
          : claudeSettings && !hasPolicy
            ? {
                en: `Add a \`permissions\` block to the existing \`.claude/settings.json\`: allow the verify commands (${allowExample}) and deny ${denyExample}.`,
                pl: `Dodaj blok \`permissions\` do istniejącego \`.claude/settings.json\`: zezwól na komendy weryfikacji (${allowExample}) i zablokuj ${denyExample}.`,
              }
            : committedLocal
              ? {
                  en: 'Move the shared allow/deny rules from `.claude/settings.local.json` into `.claude/settings.json` and gitignore the local file.',
                  pl: 'Przenieś wspólne reguły allow/deny z `.claude/settings.local.json` do `.claude/settings.json` i dodaj plik lokalny do .gitignore.',
                }
              : {
                  en: `Commit \`.claude/settings.json\` with \`permissions.allow\` for the verify commands (${allowExample}) and \`permissions.deny\` for ${denyExample}; for Codex, \`.codex/config.toml\` with \`approval_policy = "on-request"\` and \`sandbox_mode = "workspace-write"\`. \`npx harness-audit init\` writes the Claude Code file from these commands.${unignore.en}`,
                  pl: `Dodaj \`.claude/settings.json\` z \`permissions.allow\` dla komend weryfikacji (${allowExample}) i \`permissions.deny\` dla ${denyExample}; dla Codexa \`.codex/config.toml\` z \`approval_policy = "on-request"\` oraz \`sandbox_mode = "workspace-write"\`. \`npx harness-audit init\` utworzy plik dla Claude Code z tych komend.${unignore.pl}`,
                };

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
      fix: permissionFix,
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
      ctx.findFiles((f) => /^\.vite-hooks\/[^.]/.test(f)).length > 0 ? '.vite-hooks/ (vite-plus staged hooks)' : '',
      ctx.hasDependency('simple-git-hooks') ? 'simple-git-hooks' : '',
      /core\.hooksPath/.test(Object.values(ctx.packageJson?.scripts ?? {}).join('\n')) ? 'core.hooksPath set by a package script' : '',
    ].filter(Boolean);

    if (gitHookConfigs.length > 0) {
      hasGitHooks = true;
      evidence.push(`Git hooks: ${gitHookConfigs.join(', ')}`);
    }

    // The owner may have decided against hooks and written it down; that is a decision, not a gap.
    const optOut = ctx.brief.files
      .flatMap((f) => (ctx.readText(f) ?? '').split(/\r?\n/).map((text, i) => ({ f, line: i + 1, text })))
      .find((l) => /\b(no|without|removed|there is no)\b[^.\n]{0,40}\b(PreToolUse|PostToolUse|hooks?|guard)\b/i.test(l.text) && /on purpose|deliberate|by design|decision|intentional/i.test(l.text));
    // A hook runs on every edit, so only a command that just lints or formats is fast enough to suggest.
    const formatCommand = ctx.verify.commands.filter((c) => c.kinds.every((k) => k === 'format' || k === 'lint')).sort((a, b) => a.kinds.length - b.kinds.length)[0]?.command;

    let status: CheckResult['status'] = 'warn';
    if (hookIssues.length > 0) {
      status = 'fail';
      evidence.push(...hookIssues);
    } else if (hasAgentHooks || hasGitHooks) {
      status = 'pass';
    } else if (optOut) {
      status = 'info';
      evidence.push(`No hooks, by decision recorded at ${optOut.f}:${optOut.line}`);
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
          : `Add one deterministic hook: a \`PostToolUse\` hook in \`.claude/settings.json\` that runs ${formatCommand ? `\`${formatCommand}\`` : 'your formatter or linter'} on edited files, or a pre-commit hook (lefthook, husky, pre-commit) that does the same.`,
        pl: hookIssues.length > 0
          ? 'Sprawdzaj pole `stop_hook_active` z JSON na stdin na początku hooka `Stop` i zwracaj kod 0, gdy ma wartość true, aby uniknąć pętli nieskończonej.'
          : `Dodaj jeden deterministyczny hook: \`PostToolUse\` w \`.claude/settings.json\`, który uruchamia ${formatCommand ? `\`${formatCommand}\`` : 'formatter lub linter'} na edytowanych plikach, albo hook pre-commit (lefthook, husky, pre-commit) robiący to samo.`,
      },
      docsPath: 'workflows/harness/agent-hooks/',
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
      okNotes.push(file);

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

    // The fix names what was found, nothing else.
    const found = [...issues, ...warnings].join('\n');
    const mcpFix = { en: [] as string[], pl: [] as string[] };
    if (/references `@modelcontextprotocol/.test(found)) {
      mcpFix.en.push('Remove the archived or non-existent `@modelcontextprotocol/server-*` entries (they fail at session start) and use the vendor\'s official server.');
      mcpFix.pl.push('Usuń zarchiwizowane lub nieistniejące wpisy `@modelcontextprotocol/server-*` (psują start sesji) i użyj oficjalnego serwera dostawcy.');
    }
    if (/deprecated SSE/.test(found)) {
      mcpFix.en.push('Move the `/sse` endpoints to Streamable HTTP: `"type": "http"` with the server\'s `/mcp` URL.');
      mcpFix.pl.push('Przenieś endpointy `/sse` na Streamable HTTP: `"type": "http"` z adresem `/mcp` serwera.');
    }
    if (/hardcoded|plaintext secret/.test(found)) {
      mcpFix.en.push('Rotate the exposed credential and replace it with `${VAR}` / `${env:VAR}` interpolation.');
      mcpFix.pl.push('Zrotuj ujawniony sekret i zastąp go interpolacją `${VAR}` / `${env:VAR}`.');
    }
    if (/Misplaced/.test(found)) {
      mcpFix.en.push('Move `.claude/mcp.json` to `.mcp.json` at the repository root, where Claude Code reads it.');
      mcpFix.pl.push('Przenieś `.claude/mcp.json` do `.mcp.json` w katalogu głównym, skąd czyta go Claude Code.');
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
      evidence.push(...warnings, `Inspected: ${mcpFiles.join(', ')}`);
    } else {
      status = 'pass';
      evidence.push(`Inspected ${okNotes.join(', ')} — no broken packages, deprecated /sse, or hardcoded tokens found`);
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
        en: mcpFix.en.length > 0
          ? mcpFix.en.join(' ')
          : 'Keep MCP configs lean, prefer official vendor MCP servers from the MCP registry, and always interpolate credentials via env vars.',
        pl: mcpFix.pl.length > 0
          ? mcpFix.pl.join(' ')
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
    const stack = ctx.stack;
    const hasWrangler = ctx.hasFile('wrangler.toml') || ctx.hasFile('wrangler.jsonc') || ctx.hasFile('wrangler.json');
    const hasEnvTemplate = ['.env.example', '.env.sample', '.env.template'].some((f) => ctx.hasFile(f));
    // A Workers project keeps local secrets in .dev.vars; there .env is a habit to guard, not the convention.
    const usesDotenv =
      hasEnvTemplate ||
      ctx.hasDependency('dotenv') ||
      (!hasWrangler &&
        (ctx.packageJson !== null || ['Python', 'Ruby', 'PHP', 'Go', 'Rust', 'Elixir'].some((l) => stack.languages.includes(l))));
    const isAndroid = stack.frameworks.includes('Android');

    // The local secret files this stack produces; each must be ignored before an agent runs `git add`.
    const required: string[] = [];
    if (usesDotenv) required.push('.env', '.env.local');
    if (hasWrangler) required.push('.dev.vars');
    if (isAndroid) required.push('local.properties');
    const advisory = [
      ...(hasWrangler && !usesDotenv ? ['.env'] : []),
      'secret.pem',
      'secret.key',
      ...(isAndroid ? ['release.jks', 'release.keystore'] : []),
    ];
    const ignored = ctx.ignoredPaths([...required, ...advisory]);
    const missingIgnores = required.filter((p) => !ignored.has(p));
    const missingAdvisory = advisory.filter((p) => !ignored.has(p)).map((p) => (p.startsWith('.') ? p : `*${p.slice(p.lastIndexOf('.'))}`));

    const envExamples = ['.env.example', '.env.sample', '.env.template', '.dev.vars.example', 'secrets.defaults.properties'].filter((f) =>
      ctx.hasFile(f),
    );

    // Config and root files (not tests or fixtures), shallow paths first so a large repository's
    // root manifests are always inside the budget.
    const scanCandidates = ctx
      .findFiles((f) => {
        if (/(^|\/)(tests?|__tests__|fixtures?|mocks?|testdata|snapshots?)\//.test(f)) return false;
        if (/(\.lock|package-lock\.json|pnpm-lock\.yaml|\.resolved|\.min\.js)$/.test(f)) return false;
        return (
          /^(AGENTS|CLAUDE|README)\.md$/i.test(f) ||
          /^\.(claude|codex|cursor|github)\//.test(f) ||
          /\.(json|jsonc|toml|ya?ml|sh|properties|xcconfig|plist|tfvars)$/.test(f) ||
          /(^|\/)\.?env(\.[\w.-]+)?$/.test(f) ||
          /(^|\/)\.dev\.vars(\.[\w.-]+)?$/.test(f)
        );
      })
      .sort((a, b) => a.split('/').length - b.split('/').length)
      .slice(0, 400);

    const trackedLeaks: string[] = [];
    const untrackedLeaks: string[] = [];
    // Only a recognised live credential blocks a level: a test-mode key or a provider-less value
    // under a secret-sounding name is worth fixing, but the audit cannot be sure enough to cap on it.
    let liveCredentials = 0;
    for (const file of scanCandidates) {
      const content = ctx.readText(file);
      if (!content) continue;
      const lines = content.split(/\r?\n/);
      const envLike = /\.(toml|properties|tfvars|ya?ml|json|jsonc)$|(^|\/)\.?(env|dev\.vars)/.test(file) && !/\.(example|sample|template)$/.test(file);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const provider = SECRET_PATTERNS.find((sp) => {
          const m = sp.regex.exec(line);
          return m !== null && !isPlaceholderToken(m[0]);
        });
        // The variable's own name is the better label when the line has one: a generic `sk-` value
        // is not always an OpenAI key.
        const named = envLike ? NAMED_CREDENTIAL.exec(line) : null;
        const namedHit = named && !PUBLIC_BY_DESIGN.test(named[1]!) && !isPlaceholderToken(named[2]!) && !named[2]!.includes('${') && looksLikeCredential(named[2]!);
        if (!provider && !namedHit) continue;
        const testMode = /\b[sr]k_test_[A-Za-z0-9]{10,}/.test(line) && !provider;
        const specific = provider && provider.name !== 'OpenAI API key' ? provider.name : undefined;
        const label = testMode ? 'Stripe test-mode secret key' : (specific ?? (named ? `credential in \`${named[1]}\`` : provider!.name));
        if (provider && ctx.isTracked(file) !== false) liveCredentials++;
        // Outside a git work tree nothing is known about tracking: treat the file as shared.
        if (ctx.isTracked(file) === false) untrackedLeaks.push(`${file}:${i + 1} ${label} (untracked, not gitignored)`);
        else trackedLeaks.push(`${file}:${i + 1} ${label}${ctx.isTracked(file) ? ' (committed)' : ''}`);
      }
    }

    // Check CI or hooks for secret scanning (gitleaks / trufflehog / secretlint)
    const workflowFiles = ctx.findFiles((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f) || f === '.gitlab-ci.yml');
    const hasSecretScanner = workflowFiles.some((wf) => {
      const content = ctx.readText(wf) ?? '';
      return /\b(gitleaks|trufflehog|secretlint|detect-secrets)\b/i.test(content);
    }) || ctx.hasFile('.gitleaks.toml');

    const evidence: string[] = [];
    evidence.push(...trackedLeaks.slice(0, 8));
    if (trackedLeaks.length > 8) {
      // Every remaining line is still named, so "rotate everything listed" leaves nothing out.
      const rest = new Map<string, string[]>();
      for (const leak of trackedLeaks.slice(8)) {
        const [, file, line] = /^(.*?):(\d+) /.exec(leak) ?? [];
        if (file && line) rest.set(file, [...(rest.get(file) ?? []), line]);
      }
      evidence.push(`… and ${trackedLeaks.length - 8} more: ${[...rest].map(([file, ls]) => `${file} lines ${ls.join(', ')}`).join('; ')}`);
    }
    evidence.push(...untrackedLeaks.slice(0, 3));
    if (missingIgnores.length > 0) evidence.push(`Not gitignored: ${missingIgnores.join(', ')}`);
    else if (required.length > 0) evidence.push(`Git ignores ${required.join(', ')}`);
    else if (ctx.findFiles((f) => /\.xcconfig(\.example)?$/.test(f)).length > 0) {
      const local = ctx.ignoredPaths(['Config/Local.xcconfig', 'Local.xcconfig']);
      evidence.push(local.size > 0 ? 'Git ignores the local .xcconfig that holds team ids and client keys' : 'Build settings live in tracked .xcconfig files; keep keys in an ignored Local.xcconfig');
    } else evidence.push('No env-file convention for this stack; nothing required in .gitignore');
    if (missingAdvisory.length > 0 && trackedLeaks.length === 0) evidence.push(`Optional: also ignore ${missingAdvisory.join(', ')}`);
    if (envExamples.length > 0) evidence.push(`Template env files: ${envExamples.join(', ')}`);
    if (hasSecretScanner) evidence.push('Secret scanner configured (gitleaks/trufflehog/secretlint)');

    // A missing ignore rule is a failure when the file it should cover is sitting in the tree,
    // unignored; for a file that does not exist it is a precaution.
    const exposed = missingIgnores.filter((p) => ctx.hasFile(p));
    if (exposed.length > 0) evidence.push(`Present and not ignored: ${exposed.join(', ')}`);
    let status: CheckResult['status'] = 'pass';
    if (trackedLeaks.length > 0 || untrackedLeaks.length > 0 || exposed.length > 0) {
      status = 'fail';
    } else if (missingIgnores.length > 0) {
      status = 'warn';
    }

    const ignoreLines = [...missingIgnores, ...missingAdvisory].join(', ');
    // A committed file that .gitignore names: the rule came after the commit, and git still tracks it.
    const leakFiles = [...new Set(trackedLeaks.map((l) => /^(.*?):\d+ /.exec(l)?.[1] ?? '').filter(Boolean))];
    const trackedButIgnored = leakFiles.filter((f) => ctx.isTracked(f) === true && ctx.ignoredPaths([f]).size > 0);
    const untrack = trackedButIgnored.length > 0 ? ` ${trackedButIgnored.map((f) => `\`git rm --cached ${f}\``).join(', ')} first: .gitignore already names it, but git still tracks the committed copy.` : '';
    results.push({
      id: 'harness.secret-hygiene',
      station: 'harness',
      weight: 20,
      status,
      severity: liveCredentials > 0 ? 'critical' : status === 'fail' ? 'high' : 'low',
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
        en: trackedLeaks.length > 0
          ? `Rotate every credential listed above now (it is in git history even after you delete the line), move the values to your secret store (e.g. \`wrangler secret put\`, CI secrets, a gitignored env file), and add \`gitleaks\` to CI.${untrack}`
          : untrackedLeaks.length > 0
            ? 'Add the listed files to `.gitignore` before the next `git add`, or move the credentials out of the working tree.'
            : missingIgnores.length > 0
              ? `Append to \`.gitignore\`: ${ignoreLines}.`
              : 'Keep credentials in ignored env files or a secret store, and add `gitleaks` to CI as a backstop.',
        pl: trackedLeaks.length > 0
          ? 'Zrotuj teraz każdy wymieniony wyżej klucz (zostaje w historii gita nawet po usunięciu linii), przenieś wartości do magazynu sekretów (np. `wrangler secret put`, sekrety CI, ignorowany plik env) i dodaj `gitleaks` do CI.'
          : untrackedLeaks.length > 0
            ? 'Dodaj wymienione pliki do `.gitignore` przed kolejnym `git add` albo wynieś sekrety poza katalog roboczy.'
            : missingIgnores.length > 0
              ? `Dopisz do \`.gitignore\`: ${ignoreLines}.`
              : 'Trzymaj sekrety w ignorowanych plikach env lub magazynie sekretów i dodaj `gitleaks` do CI jako bezpiecznik.',
      },
      docsPath: 'org/agent-identity-and-secrets/',
      meta: {
        hasHardcodedSecrets: liveCredentials > 0,
      },
    });
  }

  // 5. harness.sandbox-readiness
  {
    const brief = ctx.brief;
    // A place built for agents to run in. A Dockerfile or a compose file is the product's image or
    // its backing services unless it is a devcontainer.
    const sandboxes: string[] = [];
    if (ctx.findFiles((f) => /^\.devcontainer\//.test(f)).length > 0) sandboxes.push('.devcontainer/');
    if (ctx.hasAnyFile(['flake.nix', 'shell.nix'])) sandboxes.push('Nix shell');
    if (claudeSettings?.sandbox) sandboxes.push('.claude/settings.json sandbox');
    if (codexToml && /^\s*sandbox_mode\s*=/m.test(codexToml)) sandboxes.push('.codex/config.toml sandbox_mode');

    // Local work that reaches production: said in the brief, or wired into a dev script.
    const reach = brief.productionReach.map((r) => `${r.file}:${r.line} says local work reaches production: "${r.text}"`);
    for (const [name, body] of Object.entries(ctx.packageJson?.scripts ?? {})) {
      if (/^(dev|start|serve)$/.test(name) && /--remote\b/.test(body)) reach.push(`package script \`${name}\` runs against remote bindings (\`--remote\`)`);
    }
    for (const m of ctx.workspaceManifests) {
      for (const [name, body] of Object.entries(m.manifest.scripts ?? {})) {
        if (/^(dev|start|serve)$/.test(name) && /--remote\b/.test(body)) reach.push(`${m.path} script \`${name}\` runs against remote bindings (\`--remote\`)`);
      }
    }
    // The default dev path writes real data: this, not a single remote bucket, is what caps a level.
    const devReachesProduction = reach.length > 0;
    // Individual bindings marked remote in the Worker config: local runs read and write them for real.
    for (const cfg of ctx.findFiles((f) => /(^|\/)wrangler\.(toml|jsonc|json)$/.test(f) && f.split('/').length <= 3).slice(0, 4)) {
      const { stores } = remoteBindings(cfg, ctx.readText(cfg) ?? '');
      if (stores.length > 0) {
        reach.push(`${cfg} marks ${stores.length} data binding(s) \`remote: true\` (${[...new Set(stores)].join(', ')}): a local run reads and writes them for real`);
      }
    }

    const rules = brief.boundaryRules;
    const evidence: string[] = [];
    if (sandboxes.length > 0) evidence.push(`Sandbox: ${sandboxes.join(', ')}`);
    else evidence.push('No agent sandbox configured (.devcontainer/, Claude Code `sandbox`, Codex `sandbox_mode`)');
    if (rules.length > 0) {
      evidence.push(`Boundary rule at ${rules[0]!.file}:${rules[0]!.line}: "${rules[0]!.text}"${rules.length > 1 ? ` (+${rules.length - 1} more)` : ''}`);
    } else {
      // A rule the README states is written down, but no agent loads the README on its own.
      const readmeRule = brief.files.length === 0 ? scanBoundaries('README.md', ctx.readText('README.md') ?? '').rules[0] : undefined;
      evidence.push(
        brief.files.length > 0
          ? `Found no sentence in ${brief.files.join(' / ')} that forbids or reserves an action on production`
          : readmeRule
            ? `README.md:${readmeRule.line} states a production rule ("${readmeRule.text}"), but there is no agent brief to carry it`
            : 'No brief, so no written boundary around production or shared resources',
      );
    }
    evidence.push(...reach.slice(0, 2));

    let status: CheckResult['status'] = sandboxes.length > 0 && rules.length > 0 ? 'pass' : sandboxes.length > 0 || rules.length > 0 ? 'warn' : 'fail';
    // An agent's ordinary local run can write production: that outranks everything else here.
    if (reach.length > 0 && sandboxes.length === 0) status = 'fail';

    // Reaching production with no sandbox, no written rule about it and no guard hook is what caps
    // a level; a repository that documents the reach and governs it has a risk, not a blind spot.
    const ungovernedReach = devReachesProduction && sandboxes.length === 0 && rules.length === 0 && guardHooks(ctx).length === 0;

    const needSandbox = {
      en: 'Give agents an OS-level boundary: enable the tool sandbox (`"sandbox": { "enabled": true }` in `.claude/settings.json`, or `sandbox_mode = "workspace-write"` in `.codex/config.toml`) or commit a `.devcontainer/`.',
      pl: 'Daj agentom granicę na poziomie systemu: włącz piaskownicę narzędzia (`"sandbox": { "enabled": true }` w `.claude/settings.json` lub `sandbox_mode = "workspace-write"` w `.codex/config.toml`) albo dodaj `.devcontainer/`.',
    };
    const needBoundary = {
      en: `Write in ${brief.primary} which production and shared resources an agent must never touch (remote databases, deploys, live webhooks, secrets).`,
      pl: `Napisz w ${brief.primary}, których zasobów produkcyjnych i współdzielonych agent nie może dotykać (zdalne bazy, deploy, żywe webhooki, sekrety).`,
    };
    const cutReach = {
      en: 'Local development reaches production: give it local or preview bindings (Miniflare state, a preview database) so an agent running the app or its tests cannot write real data.',
      pl: 'Lokalny development sięga produkcji: daj mu lokalne lub podglądowe bindingi (stan Miniflare, baza preview), aby agent uruchamiający aplikację lub testy nie mógł zapisać prawdziwych danych.',
    };

    results.push({
      id: 'harness.sandbox-readiness',
      station: 'harness',
      weight: 15,
      status,
      severity: ungovernedReach ? 'critical' : reach.length > 0 && status === 'fail' ? 'high' : status === 'fail' ? 'medium' : 'low',
      title: {
        en: 'Sandbox & production boundary readiness',
        pl: 'Gotowość piaskownicy i granice środowiska produkcyjnego',
      },
      evidence,
      why: {
        en: 'Higher-autonomy runs need an OS/container boundary plus clear written boundaries around shared cloud resources (prod DBs, deploy targets, live webhooks).',
        pl: 'Uruchomienia o wyższej autonomii wymagają izolacji kontenerowej/OS oraz jasnych granic chroniących współdzielone zasoby chmurowe (baza produkcyjna, deploy, webhooki).',
      },
      fix: {
        en: [reach.length > 0 ? cutReach.en : '', sandboxes.length === 0 ? needSandbox.en : '', rules.length === 0 ? needBoundary.en : ''].filter(Boolean).join(' ') || 'Keep the sandbox setting and the boundary rules in step with new environments.',
        pl: [reach.length > 0 ? cutReach.pl : '', sandboxes.length === 0 ? needSandbox.pl : '', rules.length === 0 ? needBoundary.pl : ''].filter(Boolean).join(' ') || 'Aktualizuj ustawienia piaskownicy i zasady granic wraz z nowymi środowiskami.',
      },
      docsPath: 'workflows/harness/permissions-and-sandboxing/',
      meta: {
        localDevReachesProduction: ungovernedReach,
      },
    });
  }

  return results;
}

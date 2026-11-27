import { repoDocLinks, repoPathsIn } from '../brief.js';
import type { RepoContext } from '../fs-scanner.js';
import type { CheckResult } from '../types.js';

const BOILERPLATE_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'generic "write clean code"', regex: /\bwrite clean(,|\s+and)?\s+(maintainable\s+)?code\b/i },
  { label: 'generic "follow best practices"', regex: /\bfollow (industry\s+)?best practices\b/i },
  { label: 'generic "ensure high quality"', regex: /\bensure high[- ]quality\b/i },
  { label: 'generic "be helpful and concise"', regex: /\bbe (helpful|concise|thorough)\b/i },
  { label: 'generic "always test your changes"', regex: /\balways test your (changes|code)\b/i },
];

/**
 * Checks whether a markdown file contains a bare `@AGENTS.md` import line
 * outside fenced code blocks and outside inline backticks (Claude Code only
 * imports bare `@AGENTS.md`).
 */
export function hasBareAgentsImport(content: string): { bare: boolean; backticked: boolean } {
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let bare = false;
  let backticked = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (/@AGENTS\.md\b/.test(trimmed)) backticked = true;
      continue;
    }
    if (/^@AGENTS\.md\s*$/.test(trimmed)) {
      bare = true;
      continue;
    }
    // Check inline bare @AGENTS.md not wrapped in backticks
    const withoutBackticks = trimmed.replace(/`[^`]*`/g, '');
    if (/(^|\s)@AGENTS\.md(\s|$)/.test(withoutBackticks)) {
      bare = true;
    } else if (/`[^`]*@AGENTS\.md[^`]*`/.test(trimmed)) {
      backticked = true;
    }
  }

  return { bare, backticked };
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

export function runIntentChecks(ctx: RepoContext): CheckResult[] {
  const results: CheckResult[] = [];

  const hasAgentsMd = ctx.hasFile('AGENTS.md');
  const hasClaudeMd = ctx.hasFile('CLAUDE.md');
  const hasCopilot = ctx.hasFile('.github/copilot-instructions.md');
  const hasLegacyCursorRules = ctx.hasFile('.cursorrules');
  const cursorMdcFiles = ctx.findFiles((f) => /^\.cursor\/rules\/.+\.mdc$/.test(f));
  // A README inside .cursor/rules documents the folder; it was never meant to be a rule.
  const cursorPlainMdFiles = ctx.findFiles((f) => /^\.cursor\/rules\/.+\.md$/.test(f) && !/(^|\/)readme\.md$/i.test(f));
  const claudeRuleFiles = ctx.findFiles((f) => /^\.claude\/rules\/.+\.md$/.test(f));

  // CLAUDE.md -> AGENTS.md (or the reverse) is one file under two names.
  const claudeLink = hasClaudeMd ? ctx.linkTarget('CLAUDE.md') : undefined;
  const agentsLink = hasAgentsMd ? ctx.linkTarget('AGENTS.md') : undefined;
  const sameFile = claudeLink === 'AGENTS.md' || agentsLink === 'CLAUDE.md';
  const named = (file: string, link: string | undefined): string => (link ? `${file} → ${link}` : file);
  // On this machine but ignored by git: the author has a brief, a teammate or a CI agent does not.
  const localOnlyBriefs = ['AGENTS.md', 'CLAUDE.md'].filter((f) => ctx.isLocalOnly(f));

  // 1. intent.instructions-file
  {
    const found: string[] = [];
    if (hasAgentsMd) found.push(named('AGENTS.md', agentsLink));
    if (hasClaudeMd) found.push(named('CLAUDE.md', claudeLink));
    for (const f of localOnlyBriefs) {
      found.push(`${f} exists on this machine but git ignores it — teammates and CI agents never see it`);
    }
    if (cursorMdcFiles.length > 0) found.push(`.cursor/rules/*.mdc (${cursorMdcFiles.length})`);
    if (claudeRuleFiles.length > 0) found.push(`.claude/rules/*.md (${claudeRuleFiles.length})`);
    if (hasCopilot) found.push('.github/copilot-instructions.md');
    if (hasLegacyCursorRules) found.push('.cursorrules (undocumented legacy format)');
    if (cursorPlainMdFiles.length > 0) {
      found.push(`.cursor/rules/*.md (${cursorPlainMdFiles.length} ignored — must be .mdc)`);
    }

    // A Cursor rule counts as the project brief only when Cursor can apply it (alwaysApply or
    // globs) and it is about this repository: it names a path that exists or a script the project
    // defines. A vendor's generic rule dropped in by a starter template is neither.
    const scriptNames = Object.keys(ctx.packageJson?.scripts ?? {}).filter((n) => n.length >= 4);
    const grounded = (text: string): boolean =>
      repoPathsIn(text, (p) => ctx.hasFile(p) || ctx.findFiles((f) => f.startsWith(`${p.replace(/\/$/, '')}/`)).length > 0) ||
      scriptNames.some((n) => new RegExp(`\\b(?:run\\s+)?${n.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')}\\b`).test(text) && /\b(npm|pnpm|yarn|bun|vp)\b/.test(text));
    const applicableMdc = cursorMdcFiles.filter((f) => {
      const body = ctx.readText(f) ?? '';
      const front = /^---\n([\s\S]*?)\n---/.exec(body)?.[1] ?? '';
      const applies = /alwaysApply:\s*true/.test(front) || /globs:[ \t]*\S/.test(front);
      return applies && grounded(body);
    });
    const genericMdcOnly = cursorMdcFiles.length > 0 && applicableMdc.length === 0 && !hasAgentsMd && !hasClaudeMd && !hasCopilot;
    if (genericMdcOnly) {
      found.push(`${cursorMdcFiles.join(', ')}: generic rule (no \`alwaysApply\`/\`globs\`, or it names no path or script of this repository) — not a project brief`);
    }
    const hasPrimary = hasAgentsMd || hasClaudeMd || applicableMdc.length > 0 || hasCopilot;
    let status: CheckResult['status'] = 'fail';
    if (hasPrimary && cursorPlainMdFiles.length === 0 && !hasLegacyCursorRules) {
      status = 'pass';
    } else if (hasPrimary || hasLegacyCursorRules || claudeRuleFiles.length > 0 || localOnlyBriefs.length > 0) {
      status = 'warn';
    }
    // The brief exists but is not committed: no other checkout, and no CI agent, has it yet.
    const uncommittedBriefs = ['AGENTS.md', 'CLAUDE.md'].filter((f) => ctx.hasFile(f) && ctx.isTracked(f) === false);
    if (uncommittedBriefs.length > 0) {
      found.push(`${uncommittedBriefs.join(', ')} not committed yet`);
      if (status === 'pass') status = 'warn';
    }
    const onlyLocalBrief = !hasPrimary && localOnlyBriefs.length > 0;

    results.push({
      id: 'intent.instructions-file',
      station: 'intent',
      weight: 30,
      status,
      severity: status === 'fail' ? 'critical' : onlyLocalBrief ? 'high' : status === 'warn' ? 'medium' : 'low',
      title: {
        en: 'Canonical project instructions file',
        pl: 'Kanoniczny plik instrukcji projektu',
      },
      evidence: found.length > 0 ? found : ['No AGENTS.md, CLAUDE.md, .cursor/rules/*.mdc, or copilot-instructions.md found'],
      why: {
        en: 'Without versioned project instructions, every agent session guesses your build commands, architecture boundaries, and safety rules from scratch.',
        pl: 'Bez wersjonowanych instrukcji projektu każda sesja agenta zgaduje komendy budowania, granice architektury i zasady bezpieczeństwa od zera.',
      },
      fix: {
        en: onlyLocalBrief
          ? `Commit ${localOnlyBriefs.join(' and ')}: remove the matching line from .gitignore so the brief is versioned and reaches teammates, CI agents and fresh worktrees.`
          : hasLegacyCursorRules || cursorPlainMdFiles.length > 0
            ? `Consolidate into a root AGENTS.md (read natively by Codex, Cursor, and Copilot) and keep a thin CLAUDE.md importing @AGENTS.md${cursorPlainMdFiles.length > 0 ? '; rename the .cursor/rules/*.md files to .mdc with frontmatter, or Cursor ignores them' : ''}.`
            : 'Add a concise root AGENTS.md (<= 150 lines) with real build/test commands and invariants, plus a thin CLAUDE.md containing `@AGENTS.md`. `npx harness-audit init` scaffolds both from the commands this audit detected.',
        pl: onlyLocalBrief
          ? `Dodaj ${localOnlyBriefs.join(' i ')} do repozytorium: usuń pasującą linię z .gitignore, aby instrukcje były wersjonowane i docierały do zespołu, agentów w CI i nowych worktree.`
          : hasLegacyCursorRules || cursorPlainMdFiles.length > 0
            ? `Skonsoliduj instrukcje do AGENTS.md w katalogu głównym (czytanym przez Codex, Cursor i Copilot) i dodaj cienki CLAUDE.md z @AGENTS.md${cursorPlainMdFiles.length > 0 ? '; zmień rozszerzenie plików .cursor/rules/*.md na .mdc z frontmatterem, inaczej Cursor je pomija' : ''}.`
            : 'Dodaj zwięzły plik AGENTS.md (<= 150 linii) w katalogu głównym z realnymi komendami build/test i niezmiennikami oraz cienki CLAUDE.md zawierający `@AGENTS.md`. `npx harness-audit init` utworzy oba pliki z komend wykrytych w tym audycie.',
      },
      docsPath: 'workflows/harness/agent-ready-codebase/',
    });
  }

  // 2. intent.single-source
  {
    const agentsText = hasAgentsMd ? (ctx.readText('AGENTS.md') ?? '') : '';
    const claudeText = hasClaudeMd ? (ctx.readText('CLAUDE.md') ?? '') : '';
    const agentsLines = countLines(agentsText);
    const claudeLines = countLines(claudeText);

    if (!hasAgentsMd && !hasClaudeMd) {
      results.push({
        id: 'intent.single-source',
        station: 'intent',
        weight: 20,
        status: 'info',
        severity: 'info',
        title: {
          en: 'Single source of truth for agent instructions',
          pl: 'Jedno źródło prawdy dla instrukcji agentów',
        },
        evidence: ['Not applicable yet: no root AGENTS.md or CLAUDE.md (counted once, under intent.instructions-file)'],
        why: {
          en: 'Cross-tool teams need one canonical instruction file so Codex, Cursor, and Claude Code never follow contradicting rules.',
          pl: 'Zespoły pracujące wieloma narzędziami potrzebują jednego kanonicznego pliku instrukcji, aby Codex, Cursor i Claude Code nie dostawały sprzecznych zasad.',
        },
        fix: {
          en: 'Create AGENTS.md as the single canonical brief and add a 1-line CLAUDE.md containing `@AGENTS.md`.',
          pl: 'Utwórz AGENTS.md jako jedno kanoniczne źródło i dodaj 1-liniowy plik CLAUDE.md zawierający `@AGENTS.md`.',
        },
        docsPath: 'workflows/harness/agent-ready-codebase/',
      });
    } else if (sameFile) {
      results.push({
        id: 'intent.single-source',
        station: 'intent',
        weight: 20,
        status: 'pass',
        severity: 'low',
        title: {
          en: 'Single source of truth for agent instructions',
          pl: 'Jedno źródło prawdy dla instrukcji agentów',
        },
        evidence: [
          `${claudeLink ? 'CLAUDE.md is a symlink to AGENTS.md' : 'AGENTS.md is a symlink to CLAUDE.md'} (${agentsLines} lines) — one file under both names, nothing to drift`,
        ],
        why: {
          en: 'One physical file read by Codex, Cursor and Claude Code cannot disagree with itself.',
          pl: 'Jeden fizyczny plik czytany przez Codex, Cursor i Claude Code nie może się rozjechać sam ze sobą.',
        },
        fix: {
          en: 'Keep the symlink. On Windows checkouts without symlink support, a one-line CLAUDE.md containing `@AGENTS.md` does the same job.',
          pl: 'Zostaw symlink. Na Windowsie bez obsługi symlinków to samo daje jednoliniowy CLAUDE.md z `@AGENTS.md`.',
        },
        docsPath: 'workflows/harness/agent-ready-codebase/',
      });
    } else if (ctx.brief.pointer) {
      const { from, to } = ctx.brief.pointer;
      results.push({
        id: 'intent.single-source',
        station: 'intent',
        weight: 20,
        status: 'pass',
        severity: 'low',
        title: {
          en: 'Single source of truth for agent instructions',
          pl: 'Jedno źródło prawdy dla instrukcji agentów',
        },
        evidence: [`${from} (${from === 'AGENTS.md' ? agentsLines : claudeLines} lines) only sends the reader to ${to} (${to === 'AGENTS.md' ? agentsLines : claudeLines} lines) — one source, two entry points`],
        why: {
          en: 'A pointer file gives every tool an entry point without a second copy of the rules.',
          pl: 'Plik-wskaźnik daje każdemu narzędziu punkt wejścia bez drugiej kopii zasad.',
        },
        fix: {
          en: `Keep ${from} a pointer. Codex and Cursor follow a "read ${to}" line; Claude Code needs a bare \`@AGENTS.md\` import when the brief lives in AGENTS.md.`,
          pl: `Zostaw ${from} jako wskaźnik. Codex i Cursor pójdą za linią „przeczytaj ${to}”; Claude Code wymaga gołego importu \`@AGENTS.md\`, gdy instrukcje są w AGENTS.md.`,
        },
        docsPath: 'workflows/harness/agent-ready-codebase/',
      });
    } else if (ctx.brief.stub && ctx.brief.stub.file === 'AGENTS.md') {
      // AGENTS.md is a template or a tool-managed block; the rules are in CLAUDE.md, which only Claude Code reads.
      const { lines, real } = ctx.brief.stub;
      results.push({
        id: 'intent.single-source',
        station: 'intent',
        weight: 20,
        status: 'fail',
        severity: 'high',
        title: {
          en: 'Single source of truth for agent instructions',
          pl: 'Jedno źródło prawdy dla instrukcji agentów',
        },
        evidence: [`AGENTS.md is a ${lines}-line stub (a template or a tool-managed block); the brief is ${real} (${claudeLines} lines), which Codex and Cursor never read`],
        why: {
          en: 'Codex and Cursor read AGENTS.md. When it holds a stub and the rules live in CLAUDE.md, those tools work in this repository without them.',
          pl: 'Codex i Cursor czytają AGENTS.md. Gdy jest tam tylko szkielet, a zasady są w CLAUDE.md, te narzędzia pracują w repozytorium bez nich.',
        },
        fix: {
          en: `Move the content of ${real} into AGENTS.md (keep any tool-managed block where the tool put it) and reduce CLAUDE.md to a bare \`@AGENTS.md\` line plus Claude-only notes.`,
          pl: `Przenieś treść ${real} do AGENTS.md (zostaw blok zarządzany przez narzędzie tam, gdzie go umieściło) i skróć CLAUDE.md do gołej linii \`@AGENTS.md\` oraz notatek tylko dla Claude.`,
        },
        docsPath: 'workflows/harness/agent-ready-codebase/',
      });
    } else if (hasAgentsMd && hasClaudeMd) {
      const imp = hasBareAgentsImport(claudeText);
      if (imp.bare && claudeLines <= 45) {
        results.push({
          id: 'intent.single-source',
          station: 'intent',
          weight: 20,
          status: 'pass',
          severity: 'low',
          title: {
            en: 'Single source of truth for agent instructions',
            pl: 'Jedno źródło prawdy dla instrukcji agentów',
          },
          evidence: [
            `AGENTS.md (${agentsLines} lines) imported via bare @AGENTS.md in thin CLAUDE.md (${claudeLines} lines)`,
          ],
          why: {
            en: 'AGENTS.md is read natively by Codex and Cursor while Claude Code pulls it cleanly via `@AGENTS.md` without duplicating policy.',
            pl: 'AGENTS.md jest czytany natywnie przez Codex i Cursor, a Claude Code importuje go przez `@AGENTS.md` bez duplikowania zasad.',
          },
          fix: {
            en: 'Keep editing AGENTS.md as the single source and keep CLAUDE.md reserved for Claude-only notes.',
            pl: 'Edytuj zasady w AGENTS.md jako jedynym źródle i zostaw CLAUDE.md wyłącznie na notatki specyficzne dla Claude Code.',
          },
          docsPath: 'workflows/harness/agent-ready-codebase/',
        });
      } else if (imp.backticked && !imp.bare) {
        results.push({
          id: 'intent.single-source',
          station: 'intent',
          weight: 20,
          status: 'fail',
          severity: 'high',
          title: {
            en: 'Single source of truth for agent instructions',
            pl: 'Jedno źródło prawdy dla instrukcji agentów',
          },
          evidence: [
            `CLAUDE.md (${claudeLines} lines) wraps @AGENTS.md in backticks or a code fence — Claude Code does NOT import backticked @references`,
          ],
          why: {
            en: 'Claude Code only expands a bare `@AGENTS.md` line; wrapping it in backticks turns the import into inert text so Claude never loads your brief.',
            pl: 'Claude Code rozwija wyłącznie gołą linię `@AGENTS.md`; ujęcie jej w backticki zamienia import w zwykły tekst, przez co Claude nie ładuje instrukcji.',
          },
          fix: {
            en: 'Put `@AGENTS.md` on its own unquoted line at the top of CLAUDE.md (remove backticks/fences around it).',
            pl: 'Umieść `@AGENTS.md` w osobnej linii na początku CLAUDE.md bez backticków i bloków kodu.',
          },
          docsPath: 'workflows/harness/agent-ready-codebase/',
        });
      } else if (claudeLines > 35 && !imp.bare) {
        results.push({
          id: 'intent.single-source',
          station: 'intent',
          weight: 20,
          status: 'fail',
          severity: 'high',
          title: {
            en: 'Single source of truth for agent instructions',
            pl: 'Jedno źródło prawdy dla instrukcji agentów',
          },
          evidence: [
            `Policy by duplication: AGENTS.md (${agentsLines} lines) and CLAUDE.md (${claudeLines} lines) both exist, and CLAUDE.md does not import @AGENTS.md`,
          ],
          why: {
            en: 'Maintaining parallel AGENTS.md and CLAUDE.md files causes silent drift the first time someone updates a command or rule in only one file.',
            pl: 'Utrzymywanie równoległych plików AGENTS.md i CLAUDE.md powoduje cichy rozjazd przy pierwszej zmianie komendy lub zasady tylko w jednym z nich.',
          },
          fix: {
            en: 'Merge shared project instructions into AGENTS.md and replace duplicated sections in CLAUDE.md with a bare `@AGENTS.md` import line.',
            pl: 'Scal wspólne instrukcje projektu do AGENTS.md i zastąp zduplikowane sekcje w CLAUDE.md gołą linią importu `@AGENTS.md`.',
          },
          docsPath: 'workflows/harness/agent-ready-codebase/',
        });
      } else {
        results.push({
          id: 'intent.single-source',
          station: 'intent',
          weight: 20,
          status: 'warn',
          severity: 'medium',
          title: {
            en: 'Single source of truth for agent instructions',
            pl: 'Jedno źródło prawdy dla instrukcji agentów',
          },
          evidence: [
            imp.bare
              ? `CLAUDE.md (${claudeLines} lines) imports @AGENTS.md but carries substantial extra text`
              : `AGENTS.md (${agentsLines} lines) and short CLAUDE.md (${claudeLines} lines) exist without a bare @AGENTS.md import`,
          ],
          why: {
            en: 'Claude Code ignores AGENTS.md whenever a CLAUDE.md file exists unless CLAUDE.md explicitly imports `@AGENTS.md`.',
            pl: 'Claude Code ignoruje AGENTS.md, gdy istnieje CLAUDE.md — chyba że CLAUDE.md jawnie importuje `@AGENTS.md`.',
          },
          fix: {
            en: 'Add a bare `@AGENTS.md` line at the top of CLAUDE.md and move general project rules into AGENTS.md.',
            pl: 'Dodaj gołą linię `@AGENTS.md` na górze CLAUDE.md i przenieś ogólne zasady projektu do AGENTS.md.',
          },
          docsPath: 'workflows/harness/agent-ready-codebase/',
        });
      }
    } else if (hasAgentsMd) {
      results.push({
        id: 'intent.single-source',
        station: 'intent',
        weight: 20,
        status: 'pass',
        severity: 'low',
        title: {
          en: 'Single source of truth for agent instructions',
          pl: 'Jedno źródło prawdy dla instrukcji agentów',
        },
        evidence: [`Single canonical AGENTS.md (${agentsLines} lines) — no duplicated root brief`],
        why: {
          en: 'A single AGENTS.md avoids instruction drift across tools; modern Claude Code, Codex, and Cursor all support it.',
          pl: 'Jeden plik AGENTS.md eliminuje rozjazd instrukcji między narzędziami — wspierają go nowoczesne Claude Code, Codex i Cursor.',
        },
        fix: {
          en: 'Optionally add a 1-line CLAUDE.md with `@AGENTS.md` if teammates run older Claude Code versions.',
          pl: 'Opcjonalnie dodaj 1-liniowy CLAUDE.md z `@AGENTS.md`, jeśli zespół używa starszych wersji Claude Code.',
        },
        docsPath: 'workflows/harness/agent-ready-codebase/',
      });
    } else {
      // Only CLAUDE.md exists
      results.push({
        id: 'intent.single-source',
        station: 'intent',
        weight: 20,
        status: 'warn',
        severity: 'low',
        title: {
          en: 'Single source of truth for agent instructions',
          pl: 'Jedno źródło prawdy dla instrukcji agentów',
        },
        evidence: [
          hasLegacyCursorRules
            ? `Only ${named('CLAUDE.md', claudeLink)} (${claudeLines} lines) and the legacy .cursorrules — Codex reads neither`
            : `Only ${named('CLAUDE.md', claudeLink)} (${claudeLines} lines) found — Codex and Cursor do not read CLAUDE.md natively`,
        ],
        why: {
          en: 'Putting shared instructions only in CLAUDE.md leaves Codex and Cursor users without project context.',
          pl: 'Umieszczenie wspólnych instrukcji wyłącznie w CLAUDE.md pozbawia użytkowników Codexa i Cursora kontekstu projektu.',
        },
        fix: {
          en: 'Move shared rules into AGENTS.md and make CLAUDE.md a thin adapter containing `@AGENTS.md`.',
          pl: 'Przenieś wspólne zasady do AGENTS.md i zamień CLAUDE.md w cienki adapter zawierający `@AGENTS.md`.',
        },
        docsPath: 'workflows/harness/agent-ready-codebase/',
      });
    }
  }

  // 3. intent.instruction-budget
  {
    // The file that holds the brief: behind a pointer, the file it points to.
    const primaryFile = ctx.brief.pointer?.to ?? ctx.brief.stub?.real ?? (hasAgentsMd ? 'AGENTS.md' : hasClaudeMd ? 'CLAUDE.md' : undefined);
    if (!primaryFile) {
      results.push({
        id: 'intent.instruction-budget',
        station: 'intent',
        weight: 20,
        status: 'info',
        severity: 'info',
        title: {
          en: 'Root instruction budget & signal-to-noise',
          pl: 'Budżet długości i jakość instrukcji głównych',
        },
        evidence: ['Not applicable yet: no root instruction file to measure'],
        why: {
          en: 'Every line of root instructions consumes context in every session. Concise, concrete commands outperform long essays.',
          pl: 'Każda linia głównych instrukcji zajmuje okno kontekstowe w każdej sesji. Konkretne komendy działają lepiej niż długie eseje.',
        },
        fix: {
          en: 'Author a root AGENTS.md under 150 lines focusing exclusively on commands, non-obvious invariants, and links to deeper docs.',
          pl: 'Napisz plik AGENTS.md poniżej 150 linii zawierający wyłącznie komendy, nieoczywiste niezmienniki i linki do głębszej dokumentacji.',
        },
        docsPath: 'workflows/context/',
      });
    } else {
      const text = ctx.readText(primaryFile) ?? '';
      const lines = countLines(text);
      const bytes = Buffer.byteLength(text, 'utf8');
      const fillerHits = BOILERPLATE_PATTERNS.filter((p) => p.regex.test(text)).map((p) => p.label);

      const primaryLink = primaryFile === 'AGENTS.md' ? agentsLink : claudeLink;
      const evidence = [`${named(primaryFile, primaryLink)}: ${lines} lines (${(bytes / 1024).toFixed(1)} KiB)`];
      if (fillerHits.length > 0) {
        evidence.push(`Generic filler detected: ${fillerHits.join(', ')}`);
      }
      if (bytes > 32 * 1024) {
        evidence.push(
          primaryFile === 'AGENTS.md'
            ? 'Exceeds Codex default project_doc_max_bytes (32 KiB) — Codex silently drops the tail'
            : `${(bytes / 1024).toFixed(0)} KiB is loaded into every Claude Code session before the first prompt`,
        );
      }

      let status: CheckResult['status'] = 'pass';
      if (lines > 350 || bytes > 32 * 1024 || lines < 5) {
        status = 'fail';
      } else if (lines > 150 || fillerHits.length >= 2) {
        status = 'warn';
      }

      results.push({
        id: 'intent.instruction-budget',
        station: 'intent',
        weight: 20,
        status,
        severity: status === 'fail' ? 'high' : status === 'warn' ? 'medium' : 'low',
        title: {
          en: 'Root instruction budget & signal-to-noise',
          pl: 'Budżet długości i jakość instrukcji głównych',
        },
        evidence,
        why: {
          en: 'Bloated root instruction files degrade agent task success and inflate token cost (>20% overhead on generic advice), and files >32 KiB truncate in Codex.',
          pl: 'Rozbuchane instrukcje główne obniżają skuteczność agentów i podnoszą koszt tokenów (>20% narzutu przy ogólnikach), a pliki >32 KiB są ucinane w Codexie.',
        },
        fix: {
          en: lines < 5
            ? `Expand ${primaryFile} with concrete verify commands, architecture pointers, and hard constraints (target 40–150 lines).`
            : `Trim ${primaryLink ?? primaryFile} to <= 150 lines by moving domain-specific guidance into path-scoped rules (.claude/rules/ or .cursor/rules/) or linked READMEs, and delete generic advice.`,
          pl: lines < 5
            ? `Rozbuduj ${primaryFile} o konkretne komendy weryfikacji, wskaźniki architektury i twarde ograniczenia (cel: 40–150 linii).`
            : `Skróć ${primaryLink ?? primaryFile} do <= 150 linii, przenosząc zasady domenowe do reguł przypisanych do ścieżek (.claude/rules/ lub .cursor/rules/) albo linkowanych README i usuwając ogólniki.`,
        },
        docsPath: 'workflows/context/',
      });
    }
  }

  // 4. intent.scoped-rules
  {
    // Nested briefs load when an agent works in that directory; a root brief that sends agents to
    // a doc per area ("Read before you touch") scopes context too.
    const { nestedBriefs, routedDocs } = ctx.brief;
    const claudeRulesWithoutPaths: string[] = [];
    for (const rf of claudeRuleFiles) {
      const content = ctx.readText(rf) ?? '';
      if (!/^---[\s\S]*?\bpaths\s*:/m.test(content)) {
        claudeRulesWithoutPaths.push(rf);
      }
    }

    const routesToDocs = routedDocs.length >= 3;
    // A Cursor rule is scoped when it has globs (or always applies); without either Cursor never loads it.
    const scopedMdc = cursorMdcFiles.filter((f) => /^---\n[\s\S]*?(?:globs:[ \t]*\S|alwaysApply:[ \t]*true)[\s\S]*?\n---/.test(ctx.readText(f) ?? ''));
    const totalScoped = scopedMdc.length + claudeRuleFiles.length + nestedBriefs.length + (routesToDocs ? routedDocs.length : 0);
    const evidence: string[] = [];
    if (claudeRuleFiles.length > 0) evidence.push(`.claude/rules/*.md: ${claudeRuleFiles.length}`);
    if (scopedMdc.length > 0) evidence.push(`.cursor/rules/*.mdc with globs: ${scopedMdc.length}`);
    if (cursorMdcFiles.length > scopedMdc.length) evidence.push(`${cursorMdcFiles.length - scopedMdc.length} .cursor rule(s) have no \`globs\` and \`alwaysApply: false\`, so Cursor never applies them`);
    if (nestedBriefs.length > 0) {
      evidence.push(`Nested briefs (${nestedBriefs.length}): ${nestedBriefs.slice(0, 5).join(', ')}${nestedBriefs.length > 5 ? ', …' : ''}`);
    }
    if (routesToDocs) {
      evidence.push(`Root brief routes agents to ${routedDocs.length} area docs: ${routedDocs.slice(0, 4).join(', ')}${routedDocs.length > 4 ? ', …' : ''}`);
    }
    if (claudeRulesWithoutPaths.length > 0) {
      evidence.push(`Warning: ${claudeRulesWithoutPaths.length} .claude/rules/*.md lack paths: frontmatter (loaded unconditionally)`);
    }

    const isLargeOrMono = ctx.stack.monorepo || ctx.sourceFiles.length >= 40;
    let status: CheckResult['status'] = 'pass';
    if (totalScoped === 0) {
      status = isLargeOrMono ? 'warn' : 'info';
      evidence.push(
        isLargeOrMono
          ? `No path-scoped rules found in a ${ctx.stack.monorepo ? 'monorepo' : `${ctx.sourceFiles.length}-file`} codebase`
          : 'No path-scoped rules yet (optional for small repos; add as modules grow)',
      );
    } else if (claudeRulesWithoutPaths.length > 0 && claudeRulesWithoutPaths.length === claudeRuleFiles.length && totalScoped === claudeRuleFiles.length) {
      status = 'warn';
    }

    results.push({
      id: 'intent.scoped-rules',
      station: 'intent',
      weight: 15,
      status,
      severity: status === 'warn' ? 'medium' : 'low',
      title: {
        en: 'Path-scoped rules & nested context',
        pl: 'Reguły przypisane do ścieżek i kontekst zagnieżdżony',
      },
      evidence,
      why: {
        en: 'Path-scoped rules load only when an agent touches matching files (tests, migrations, styles), preserving context budget while enforcing local invariants.',
        pl: 'Reguły przypisane do ścieżek ładują się tylko wtedy, gdy agent dotyka pasujących plików (testy, migracje, style), oszczędzając budżet kontekstu.',
      },
      fix: {
        en: claudeRulesWithoutPaths.length > 0
          ? 'Add `paths:` YAML frontmatter to `.claude/rules/*.md` files so they load only on matching directories instead of every turn.'
          : 'Add glob-scoped rules under `.claude/rules/*.md` (with `paths:`), `.cursor/rules/*.mdc` (with `globs:`), or nested `AGENTS.md` / `README.md` pointers for sensitive subdirectories.',
        pl: claudeRulesWithoutPaths.length > 0
          ? 'Dodaj nagłówek YAML `paths:` do plików `.claude/rules/*.md`, aby ładowały się tylko dla pasujących ścieżek, a nie w każdej sesji.'
          : 'Dodaj reguły przypisane do ścieżek w `.claude/rules/*.md` (z `paths:`), `.cursor/rules/*.mdc` (z `globs:`) lub zagnieżdżone `AGENTS.md` dla wrażliwych modułów.',
      },
      docsPath: 'workflows/harness/',
    });
  }

  // 5. intent.skills-and-specs
  {
    // Skills a coding agent loads live in a tool's folder. A SKILL.md tree elsewhere in an
    // application is the product's own model-facing content; a repository that is itself a skill
    // collection (more skills than source files) is the exception.
    const allSkillFiles = ctx.findFiles((f) => /(^|\/)SKILL\.md$/.test(f) && !/(^|\/)(node_modules|vendor)\//.test(f));
    const isCollection = allSkillFiles.length > ctx.sourceFiles.length;
    const skillFiles = allSkillFiles.filter((f) => isCollection || /(^|\/)\.(?:claude|agents|codex|cursor|github|opencode|gemini)\/skills?\//.test(f));
    const productSkills = allSkillFiles.filter((f) => !skillFiles.includes(f));
    const prTemplate = ctx.hasAnyFile([
      '.github/pull_request_template.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'docs/pull_request_template.md',
    ]) ?? ctx.findFiles((f) => /^\.github\/PULL_REQUEST_TEMPLATE\/.+\.md$/i.test(f))[0];
    const issueTemplates = ctx.findFiles((f) => /^\.github\/ISSUE_TEMPLATE\/.+\.(md|ya?ml)$/i.test(f));
    const SPEC_NAME = /(architecture|design|spec|standards|testing|contract|security|conventions|adr|rfc|decision|roadmap|api)/i;
    const specDocs = [
      ...new Set([
        ...ctx.findFiles(
          (f) =>
            /^(DESIGN|PRODUCT|CODING_STANDARDS|TESTING|ARCHITECTURE|CONTRIBUTING|SECURITY|CONVENTIONS|SPEC|CONTEXT|ROADMAP)\.md$/i.test(f) ||
            // A named spec at the root: `forme-spec.md`, `MIGRATION.md`, `design-system.md`.
            (!f.includes('/') && /^(?:[\w.-]*[-_.])?(?:specs?|prd|requirements|migration|adr|design|plan|architecture|roadmap)(?:[-_.][\w.-]*)?\.mdx?$/i.test(f)) ||
            /^(plans|specs?|adr|adrs|rfcs?)\/.+\.mdx?$/i.test(f) ||
            (/^docs\/(?:[^/]+\/)*(adr|adrs|specs?|rfcs?|architecture|decisions|plans)\//i.test(f) && /\.mdx?$/i.test(f)) ||
            (/^docs\/[^/]+\.mdx?$/i.test(f) && SPEC_NAME.test(f)),
        ),
        // Docs the brief or the README sends readers to are the repository's standing specs.
        // Whatever the brief routes an agent to is a standing reference, whatever its name.
        ...ctx.brief.routedDocs.filter((p) => !/(^|\/)SKILL\.md$/.test(p)),
        ...repoDocLinks(ctx.readText('README.md') ?? '', (p) => ctx.hasFile(p)).filter((p) => SPEC_NAME.test(p)),
      ]),
    ];

    const evidence: string[] = [];
    if (skillFiles.length > 0) evidence.push(`Reusable skills: ${skillFiles.length} (${skillFiles.slice(0, 3).join(', ')})`);
    if (productSkills.length > 0) {
      evidence.push(`${productSkills.length} SKILL.md file(s) outside the agent tool folders (e.g. ${productSkills[0]}) read as product content and are not counted`);
    }
    if (prTemplate) evidence.push(`PR template: ${prTemplate}`);
    if (issueTemplates.length > 0) evidence.push(`Issue templates: ${issueTemplates.length}`);
    if (specDocs.length > 0) evidence.push(`Design/spec/standard docs: ${specDocs.slice(0, 5).join(', ')}`);

    const categoriesHit =
      (skillFiles.length > 0 ? 1 : 0) +
      (prTemplate || issueTemplates.length > 0 ? 1 : 0) +
      (specDocs.length > 0 ? 1 : 0);

    const status: CheckResult['status'] = categoriesHit >= 2 ? 'pass' : categoriesHit === 1 ? 'warn' : 'fail';
    // Name only what this repository lacks.
    const missingKinds = { en: [] as string[], pl: [] as string[] };
    if (skillFiles.length === 0) {
      missingKinds.en.push('a reusable skill for a procedure you repeat (`.claude/skills/<name>/SKILL.md` or `.agents/skills/`)');
      missingKinds.pl.push('skilla dla powtarzanej procedury (`.claude/skills/<nazwa>/SKILL.md` lub `.agents/skills/`)');
    }
    if (!prTemplate && issueTemplates.length === 0) {
      missingKinds.en.push('a PR or issue template with acceptance criteria');
      missingKinds.pl.push('szablonu PR lub zgłoszenia z kryteriami akceptacji');
    }
    if (specDocs.length === 0) {
      missingKinds.en.push('a standards, testing or architecture doc agents can be pointed at');
      missingKinds.pl.push('dokumentu standardów, testów lub architektury, do którego można odesłać agenta');
    }
    if (categoriesHit === 0) {
      evidence.push('No project skills, spec/ADR/standards docs, or PR/issue templates found');
    }

    results.push({
      id: 'intent.skills-and-specs',
      station: 'intent',
      weight: 15,
      status,
      severity: status === 'fail' ? 'medium' : 'low',
      title: {
        en: 'Reusable skills, specs & workflow templates',
        pl: 'Wielokrotnego użytku skille, specyfikacje i szablony',
      },
      evidence,
      why: {
        en: 'Climbing past Level 2 requires reusable procedures (skills) and durable specification/standards artifacts rather than re-explaining requirements in chat.',
        pl: 'Wejście powyżej Poziomu 2 wymaga wielokrotnego użytku procedur (skilli) i trwałych specyfikacji zamiast ciągłego tłumaczenia wymagań na czacie.',
      },
      fix: {
        en: missingKinds.en.length > 0 ? `Still missing: ${missingKinds.en.join('; ')}.` : 'Keep skills, templates and standards docs current as the workflow changes.',
        pl: missingKinds.pl.length > 0 ? `Wciąż brakuje: ${missingKinds.pl.join('; ')}.` : 'Aktualizuj skille, szablony i dokumenty standardów wraz ze zmianami procesu.',
      },
      docsPath: 'method/',
    });
  }

  return results;
}

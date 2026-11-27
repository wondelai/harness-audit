import { docsUrl, LEVELS, STATION_MAP, t, UI } from '../i18n.js';
import { unblocksNextLevel } from '../scoring.js';
import { branchNotes, describeGate, uncappedGates } from './gates.js';
import type { AuditReport, CheckStatus, RenderOptions } from '../types.js';

interface Colors {
  reset: string;
  bold: string;
  dim: string;
  green: string;
  yellow: string;
  red: string;
  cyan: string;
  orange: string;
  gray: string;
}

function makeColors(enabled: boolean): Colors {
  if (!enabled) {
    return {
      reset: '',
      bold: '',
      dim: '',
      green: '',
      yellow: '',
      red: '',
      cyan: '',
      orange: '',
      gray: '',
    };
  }
  return {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    orange: '\x1b[38;5;202m',
    gray: '\x1b[90m',
  };
}

function progressBar(score: number, width = 20): string {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function statusBadge(status: CheckStatus, lang: 'en' | 'pl', c: Colors): string {
  switch (status) {
    case 'pass':
      return `${c.green}[${t(UI.pass, lang)}]${c.reset}`;
    case 'warn':
      return `${c.yellow}[${t(UI.warn, lang)}]${c.reset}`;
    case 'fail':
      return `${c.red}[${t(UI.fail, lang)}]${c.reset}`;
    case 'info':
      return `${c.cyan}[${t(UI.info, lang)}]${c.reset}`;
  }
}

function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      out.push(indent + line);
      line = word;
    } else {
      line = line.length > 0 ? `${line} ${word}` : word;
    }
  }
  if (line.length > 0) out.push(indent + line);
  return out;
}

export function renderTerminal(report: AuditReport, options: RenderOptions = {}): string {
  const lang = options.lang ?? report.lang;
  const ci = Boolean(options.ci);
  const verbose = Boolean(options.verbose);
  const noPromo = Boolean(options.noPromo) || ci;
  const useColor =
    !options.noColor && !ci && !process.env['NO_COLOR'] && (process.stdout.isTTY === true || Boolean(process.env['FORCE_COLOR']));
  const c = makeColors(useColor);
  const WIDTH = 96;

  const lines: string[] = [];
  const levelMeta = LEVELS[report.level];
  const scoreColor =
    report.overallScore >= 78 ? c.green : report.overallScore >= 50 ? c.yellow : c.red;

  if (!ci) {
    lines.push(`${c.orange}${c.bold}━━━ ${t(UI.reportTitle, lang).toUpperCase()} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    lines.push(`${c.dim}${t(UI.subtitle, lang)}${c.reset}`);
  } else {
    lines.push(`${t(UI.reportTitle, lang)} — ${report.repoName}`);
  }

  lines.push('');
  lines.push(
    `${c.bold}Repo:${c.reset} ${report.repoName} ${c.gray}(${report.repoPath})${c.reset}`,
  );

  const stackBits = [
    report.stack.languages.length > 0 ? report.stack.languages.join(', ') : t(UI.stackUnknown, lang),
    report.stack.frameworks.length > 0 ? report.stack.frameworks.join(', ') : '',
    report.stack.packageManagers.length > 0 ? `pm: ${report.stack.packageManagers.join(', ')}` : '',
    report.stack.monorepo ? 'monorepo' : '',
  ].filter(Boolean);
  lines.push(`${c.bold}Stack:${c.reset} ${stackBits.join(' · ')}`);

  if (report.git.isGitRepo) {
    lines.push(
      `${c.bold}Git:${c.reset} ${report.git.branch ?? 'HEAD'} · ${report.git.gitAuthors90d} ${t(report.git.gitAuthors90d === 1 ? UI.contributor90d : UI.contributors90d, lang)} · ${report.git.commits30d} ${t(UI.commits30d, lang)}`,
    );
    for (const note of branchNotes(report, lang)) lines.push(`${c.yellow}${c.bold}! ${note}${c.reset}`);
  }
  lines.push(
    `${c.bold}Scan:${c.reset} ${report.scan.fileCount} ${t(report.scan.mode === 'git' ? UI.scanGit : UI.scanWalk, lang)}`,
  );
  if (report.scan.truncated) {
    lines.push(`${c.yellow}${c.bold}! ${t(UI.scanTruncated, lang)}${c.reset}`);
  }

  lines.push('');
  lines.push(
    `  ${c.bold}${t(UI.overallScore, lang)}:${c.reset}   ${scoreColor}${c.bold}${report.overallScore}/100${c.reset}  ${progressBar(report.overallScore, 24)}`,
  );
  if (report.criticalPenalty.points > 0) {
    lines.push(
      `  ${c.dim}${t(UI.penaltyLine, lang)
        .replace('{stations}', String(report.stationScore))
        .replace('{points}', String(report.criticalPenalty.points))
        .replace('{checks}', report.criticalPenalty.checks.join(', '))}${c.reset}`,
    );
  }
  lines.push(
    `  ${c.bold}${t(UI.autonomyLevel, lang)}:${c.reset} ${c.orange}${c.bold}Level ${report.level} — ${t(levelMeta.shortName, lang)}${c.reset} ${c.dim}(${t(levelMeta.shapiroName, lang)})${c.reset}`,
  );
  lines.push(...wrap(t(levelMeta.summary, lang), WIDTH, '  ').map((l) => `${c.dim}${l}${c.reset}`));

  // Why the level sits below what the score alone would give: only the unmet requirements, once.
  if (report.level !== report.rawLevel) {
    lines.push('');
    lines.push(
      `${c.yellow}${c.bold}! ${t(UI.levelCapsHeading, lang)}: Level ${report.rawLevel} → Level ${report.level}${c.reset}`,
    );
    for (const cap of report.levelCaps.filter((cp) => cp.cappedTo < report.rawLevel)) {
      const needs = cap.triggeredBy.map((id) => describeGate(id, report, lang)).join(' · ');
      lines.push(...wrap(`• Level ${cap.cappedTo + 1}+ ${t(UI.capNeeds, lang)}: ${needs}`, WIDTH, '  '));
    }
  }

  // What the next level takes
  const next = report.nextLevel;
  if (next) {
    const nextMeta = LEVELS[next.level];
    lines.push('');
    const scorePart =
      next.pointsMissing > 0
        ? `${next.scoreNeeded}/100 (+${next.pointsMissing} ${t(UI.pointsToGo, lang)})`
        : `${next.scoreNeeded}/100 ✓`;
    const gates = uncappedGates(report);
    const cappedHere = next.blockers.length > gates.length;
    lines.push(
      `${c.bold}${t(UI.nextLevelHeading, lang)}: Level ${next.level} — ${t(nextMeta.shortName, lang)}${c.reset} · ${t(UI.scoreNeeded, lang)} ${scorePart}${cappedHere ? ` · ${t(UI.liftCap, lang)}` : ''}`,
    );
    for (const id of gates) {
      lines.push(`  • ${describeGate(id, report, lang)}`);
    }
  }

  // Six Stations table
  lines.push('');
  lines.push(`${c.bold}${t(UI.stationsHeading, lang)}${c.reset}`);
  lines.push(`${c.gray}${'─'.repeat(72)}${c.reset}`);
  for (const st of report.stations) {
    const meta = STATION_MAP[st.id];
    const stName = padRight(`${meta.order}. ${t(meta.name, lang)}`, 22);
    const bar = progressBar(st.score, 18);
    const stColor = st.score >= 78 ? c.green : st.score >= 50 ? c.yellow : c.red;
    const scoreStr = padRight(`${st.score}/100`, 7);
    const counts = `${st.passed} pass · ${st.warned} warn · ${st.failed} fail`;
    lines.push(`  ${stName} ${stColor}${bar}${c.reset} ${stColor}${c.bold}${scoreStr}${c.reset} ${c.dim}${counts}${c.reset}`);
  }
  lines.push(`${c.gray}${'─'.repeat(72)}${c.reset}`);

  // Top priorities: full evidence and fix, once
  const priorityRank = new Map(report.topPriorities.map((p, i) => [p.id, i + 1]));
  const gain = (impact: number | undefined): string => (impact ? `+${impact % 1 === 0 ? impact : impact.toFixed(1)} ${t(UI.pts, lang)}` : '');

  if (report.topPriorities.length > 0) {
    lines.push('');
    lines.push(`${c.bold}${t(UI.topPrioritiesHeading, lang)}${c.reset} ${c.dim}${t(UI.topPrioritiesOrder, lang)}${c.reset}`);
    for (let i = 0; i < report.topPriorities.length; i++) {
      const check = report.topPriorities[i]!;
      const tags = [gain(check.impact), next && unblocksNextLevel(check, next) ? `${t(UI.unblocks, lang)} Level ${next.level}` : ''].filter(Boolean);
      lines.push(
        `  ${i + 1}. ${statusBadge(check.status, lang, c)} ${c.bold}${check.id}${c.reset} — ${t(check.title, lang)}${tags.length > 0 ? `  ${c.cyan}${tags.join(' · ')}${c.reset}` : ''}`,
      );
      for (const ev of check.evidence.slice(0, 4)) {
        lines.push(...wrap(`↳ ${ev}`, WIDTH, '     ').map((l) => `${c.gray}${l}${c.reset}`));
      }
      if (check.evidence.length > 4) lines.push(`     ${c.gray}↳ … +${check.evidence.length - 4}${c.reset}`);
      lines.push(...wrap(`${t(UI.fixLabel, lang)}: ${t(check.fix, lang)}`, WIDTH, '     '));
      lines.push(`     ${c.dim}${t(UI.docsLabel, lang)}: ${docsUrl(lang, check.docsPath)}${c.reset}`);
    }
  }

  // Per-station findings: what needs attention in full, what passes in one line
  lines.push('');
  lines.push(`${c.bold}${t(UI.allChecksHeading, lang)}${c.reset}${verbose ? '' : ` ${c.dim}${t(UI.verboseHint, lang)}${c.reset}`}`);
  for (const st of report.stations) {
    const meta = STATION_MAP[st.id];
    lines.push('');
    lines.push(`  ${c.bold}${meta.order}. ${t(meta.name, lang)} (${st.score}/100)${c.reset} ${c.dim}— ${t(meta.decision, lang)}${c.reset}`);
    const short = (id: string): string => id.slice(id.indexOf('.') + 1);

    const open = st.checks.filter((ch) => ch.status === 'fail' || ch.status === 'warn');
    for (const check of open) {
      const rank = priorityRank.get(check.id);
      const head = `    ${statusBadge(check.status, lang, c)} ${c.bold}${check.id}${c.reset}: ${t(check.title, lang)}${check.impact ? ` ${c.cyan}${gain(check.impact)}${c.reset}` : ''}`;
      if (rank !== undefined && !verbose) {
        lines.push(`${head} ${c.dim}→ ${t(UI.seeTopFix, lang)} #${rank}${c.reset}`);
        continue;
      }
      lines.push(head);
      for (const ev of check.evidence) {
        lines.push(...wrap(`↳ ${ev}`, WIDTH, '      ').map((l) => `${c.gray}${l}${c.reset}`));
      }
      lines.push(...wrap(`${t(UI.fixLabel, lang)}: ${t(check.fix, lang)}`, WIDTH, '      ').map((l) => `${c.dim}${l}${c.reset}`));
    }

    const passed = st.checks.filter((ch) => ch.status === 'pass');
    const infos = st.checks.filter((ch) => ch.status === 'info');
    if (verbose) {
      for (const check of [...passed, ...infos]) {
        lines.push(`    ${statusBadge(check.status, lang, c)} ${c.bold}${check.id}${c.reset}: ${t(check.title, lang)}`);
        for (const ev of check.evidence) {
          lines.push(...wrap(`↳ ${ev}`, WIDTH, '      ').map((l) => `${c.gray}${l}${c.reset}`));
        }
      }
    } else {
      if (passed.length > 0) {
        lines.push(...wrap(`${statusBadge('pass', lang, c)} ${passed.map((p) => short(p.id)).join(', ')}`, WIDTH + 12, '    '));
      }
      for (const check of infos) {
        lines.push(...wrap(`${statusBadge('info', lang, c)} ${short(check.id)}: ${check.evidence[0] ?? ''}`, WIDTH + 12, '    ').map((l, i) => (i === 0 ? l : `${c.gray}  ${l}${c.reset}`)));
      }
    }
  }

  // Interview section
  if (report.interview) {
    lines.push('');
    lines.push(`${c.bold}${t(UI.interviewHeading, lang)} (${report.interview.score}/100 · role: ${report.interview.role})${c.reset}`);
    for (const ans of report.interview.answers) {
      const mark = ans.score === 2 ? `${c.green}●${c.reset}` : ans.score === 1 ? `${c.yellow}◐${c.reset}` : `${c.red}○${c.reset}`;
      lines.push(`  ${mark} ${t(ans.question, lang)}`);
      lines.push(`    ${c.dim}↳ ${t(ans.choiceLabel, lang)}${c.reset}`);
    }
    if (report.interview.gaps.length > 0) {
      lines.push(`  ${c.yellow}${c.bold}Key workflow gaps:${c.reset}`);
      for (const gap of report.interview.gaps.slice(0, 4)) {
        lines.push(`    • ${t(gap, lang)}`);
      }
    }
  }

  // Deep review section
  if (report.deepReview) {
    lines.push('');
    lines.push(`${c.bold}${t(UI.deepReviewHeading, lang)} (${report.deepReview.provider})${c.reset}`);
    if (report.deepReview.error) {
      lines.push(`  ${c.yellow}${report.deepReview.error}${c.reset}`);
    } else {
      lines.push(`  ${c.dim}Inspected: ${report.deepReview.filesInspected.join(', ') || 'none'}${c.reset}`);
      if (report.deepReview.summary) {
        lines.push(`  ${report.deepReview.summary}`);
      }
      for (const f of report.deepReview.findings) {
        lines.push(`  • [${f.severity.toUpperCase()} · ${f.area}] ${c.bold}${f.title}${c.reset}: ${f.detail}`);
        if (f.suggestion) {
          lines.push(`    ${c.dim}↳ ${f.suggestion}${c.reset}`);
        }
      }
    }
  }

  // Tasteful 3-line Next Steps footer (omitted in --ci and --no-promo)
  if (!noPromo) {
    lines.push('');
    lines.push(`${c.gray}${'─'.repeat(72)}${c.reset}`);
    lines.push(`${c.bold}${t(UI.nextStepsHeading, lang)}${c.reset}`);
    if (report.scaffold.length > 0) {
      lines.push(...wrap(`• ${t(UI.scaffoldHint, lang)} npx harness-audit init --dry-run  (${report.scaffold.join(', ')})`, WIDTH, '  '));
    }
    lines.push(
      `  • ${c.bold}${t(UI.fixPromptHint, lang)}${c.reset} npx harness-audit --prompt --out HARNESS-FIX-PROMPT.md`,
    );
    lines.push(
      `  • ${c.bold}${t(UI.deepDiveBook, lang)}:${c.reset} ${t(report.recommendations.book.title, lang)} — ${report.recommendations.book.url}`,
    );
    if (report.recommendations.service.show) {
      lines.push(
        `  • ${c.bold}${t(UI.forTeams, lang)}:${c.reset} ${t(report.recommendations.service.headline, lang)} — ${report.recommendations.service.url}`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

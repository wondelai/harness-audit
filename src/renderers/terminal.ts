import { docsUrl, LEVELS, STATION_MAP, t, UI } from '../i18n.js';
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

export function renderTerminal(report: AuditReport, options: RenderOptions = {}): string {
  const lang = options.lang ?? report.lang;
  const ci = Boolean(options.ci);
  const noPromo = Boolean(options.noPromo) || ci;
  const useColor =
    !options.noColor && !ci && !process.env['NO_COLOR'] && (process.stdout.isTTY !== false);
  const c = makeColors(useColor);

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
    report.stack.languages.length > 0 ? report.stack.languages.join(', ') : 'unknown',
    report.stack.frameworks.length > 0 ? report.stack.frameworks.join(', ') : '',
    report.stack.packageManagers.length > 0 ? `pm: ${report.stack.packageManagers.join(', ')}` : '',
    report.stack.monorepo ? 'monorepo' : '',
  ].filter(Boolean);
  lines.push(`${c.bold}Stack:${c.reset} ${stackBits.join(' · ')}`);

  if (report.git.isGitRepo) {
    lines.push(
      `${c.bold}Git:${c.reset} ${report.git.branch ?? 'HEAD'} · ${report.git.gitAuthors90d} ${t(UI.contributors90d, lang)} · ${report.git.commits30d} ${t(UI.commits30d, lang)}`,
    );
  }

  lines.push('');
  lines.push(
    `  ${c.bold}${t(UI.overallScore, lang)}:${c.reset}   ${scoreColor}${c.bold}${report.overallScore}/100${c.reset}  ${progressBar(report.overallScore, 24)}`,
  );
  lines.push(
    `  ${c.bold}${t(UI.autonomyLevel, lang)}:${c.reset} ${c.orange}${c.bold}Level ${report.level} — ${t(levelMeta.shortName, lang)}${c.reset} ${c.dim}(${t(levelMeta.shapiroName, lang)})${c.reset}`,
  );
  if (report.level !== report.rawLevel) {
    lines.push(
      `  ${c.dim}${t(UI.rawScoreLevel, lang)}: Level ${report.rawLevel} -> capped to Level ${report.level}${c.reset}`,
    );
  }
  lines.push(`  ${c.dim}${t(levelMeta.summary, lang)}${c.reset}`);

  if (report.levelCaps.length > 0) {
    lines.push('');
    lines.push(`${c.yellow}${c.bold}! ${t(UI.levelCapsHeading, lang)}${c.reset}`);
    for (const cap of report.levelCaps) {
      lines.push(`  • ${t(cap.reason, lang)} ${c.gray}[${cap.triggeredBy.join(', ')}]${c.reset}`);
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

  // Top priorities
  if (report.topPriorities.length > 0) {
    lines.push('');
    lines.push(`${c.bold}${t(UI.topPrioritiesHeading, lang)}${c.reset}`);
    for (let i = 0; i < report.topPriorities.length; i++) {
      const check = report.topPriorities[i]!;
      lines.push(
        `  ${i + 1}. ${statusBadge(check.status, lang, c)} ${c.bold}${check.id}${c.reset} — ${t(check.title, lang)}`,
      );
      lines.push(`     ${c.dim}${t(UI.evidenceLabel, lang)}:${c.reset} ${check.evidence[0] ?? ''}`);
      lines.push(`     ${c.dim}${t(UI.fixLabel, lang)}:${c.reset} ${t(check.fix, lang)}`);
      lines.push(`     ${c.dim}${t(UI.docsLabel, lang)}:${c.reset} ${docsUrl(lang, check.docsPath)}`);
    }
  }

  // Per-station detailed checks
  lines.push('');
  lines.push(`${c.bold}${t(UI.allChecksHeading, lang)}${c.reset}`);
  for (const st of report.stations) {
    const meta = STATION_MAP[st.id];
    lines.push('');
    lines.push(`  ${c.bold}${meta.order}. ${t(meta.name, lang)} (${st.score}/100)${c.reset} ${c.dim}— ${t(meta.decision, lang)}${c.reset}`);
    for (const check of st.checks) {
      lines.push(`    ${statusBadge(check.status, lang, c)} ${c.bold}${check.id}${c.reset}: ${t(check.title, lang)}`);
      for (const ev of check.evidence) {
        lines.push(`      ${c.gray}↳ ${ev}${c.reset}`);
      }
      if (check.status === 'fail' || check.status === 'warn') {
        lines.push(`      ${c.dim}${t(UI.fixLabel, lang)}: ${t(check.fix, lang)}${c.reset}`);
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
    lines.push(
      `  • ${c.bold}${t(UI.fixPromptHint, lang)}${c.reset} npx @wondelai/harness-audit --prompt --out HARNESS-FIX-PROMPT.md`,
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

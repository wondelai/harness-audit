import { docsUrl, LEVELS, STATION_MAP, t, UI } from '../i18n.js';
import type { AuditReport, RenderOptions } from '../types.js';
import { describeGate, uncappedGates } from './gates.js';

export function renderMarkdown(report: AuditReport, options: RenderOptions = {}): string {
  const lang = options.lang ?? report.lang;
  const noPromo = Boolean(options.noPromo) || Boolean(options.ci);
  const levelMeta = LEVELS[report.level];

  const lines: string[] = [];

  lines.push(`# ${t(UI.reportTitle, lang)}: \`${report.repoName}\``);
  lines.push('');
  lines.push(`> ${t(UI.subtitle, lang)}`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(
    `| **${t(UI.overallScore, lang)}** | **${report.overallScore}/100**${
      report.criticalPenalty.points > 0
        ? ` ${t(UI.penaltyLine, lang).replace('{stations}', String(report.stationScore)).replace('{points}', String(report.criticalPenalty.points)).replace('{checks}', report.criticalPenalty.checks.join(', '))}`
        : ''
    } |`,
  );
  lines.push(
    `| **${t(UI.autonomyLevel, lang)}** | **Level ${report.level} — ${t(levelMeta.shortName, lang)}** (${t(levelMeta.shapiroName, lang)}) |`,
  );
  if (report.level !== report.rawLevel) {
    lines.push(`| ${t(UI.rawScoreLevel, lang)} | Level ${report.rawLevel} (capped to Level ${report.level}) |`);
  }
  lines.push(
    `| **Stack** | ${[...report.stack.languages, ...report.stack.frameworks].join(', ') || 'Unknown'} (${report.stack.packageManagers.join(', ') || 'n/a'}) |`,
  );
  if (report.git.isGitRepo) {
    lines.push(
      `| **Git Activity** | ${report.git.gitAuthors90d} ${t(UI.contributors90d, lang)} · ${report.git.commits30d} ${t(UI.commits30d, lang)} |`,
    );
  }
  lines.push(`| **Scan** | ${report.scan.fileCount} ${t(report.scan.mode === 'git' ? UI.scanGit : UI.scanWalk, lang)}${report.scan.truncated ? ` — ${t(UI.scanTruncated, lang)}` : ''} |`);
  lines.push(`| **Audited At** | ${report.auditedAt} |`);
  lines.push('');
  lines.push(t(levelMeta.summary, lang));

  if (report.levelCaps.length > 0) {
    lines.push('');
    lines.push(`## ${t(UI.levelCapsHeading, lang)}`);
    lines.push('');
    for (const cap of report.levelCaps) {
      const needs = cap.triggeredBy.map((id) => describeGate(id, report, lang)).join(' · ');
      lines.push(`- **Level ${cap.cappedTo + 1}+ ${t(UI.capNeeds, lang)}:** ${needs}`);
      lines.push(`  - ${t(cap.reason, lang)}`);
    }
  }

  if (report.nextLevel) {
    const next = report.nextLevel;
    lines.push('');
    lines.push(`## ${t(UI.nextLevelHeading, lang)}: Level ${next.level} — ${t(LEVELS[next.level].shortName, lang)}`);
    lines.push('');
    lines.push(
      next.pointsMissing > 0
        ? `- **${next.scoreNeeded}/100** (+${next.pointsMissing} ${t(UI.pointsToGo, lang)})`
        : `- **${next.scoreNeeded}/100** ✓`,
    );
    for (const id of uncappedGates(report)) {
      lines.push(`- **${t(UI.gateLabel, lang)}:** ${describeGate(id, report, lang)}`);
    }
  }

  lines.push('');
  lines.push(`## ${t(UI.stationsHeading, lang)}`);
  lines.push('');
  lines.push('| # | Station | Decision | Score | Pass / Warn / Fail |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const st of report.stations) {
    const meta = STATION_MAP[st.id];
    lines.push(
      `| ${meta.order} | **${t(meta.name, lang)}** | ${t(meta.decision, lang)} | **${st.score}/100** | ${st.passed} / ${st.warned} / ${st.failed} |`,
    );
  }

  if (report.topPriorities.length > 0) {
    lines.push('');
    lines.push(`## ${t(UI.topPrioritiesHeading, lang)}`);
    lines.push('');
    for (let i = 0; i < report.topPriorities.length; i++) {
      const c = report.topPriorities[i]!;
      lines.push(
        `${i + 1}. **[${c.status.toUpperCase()}] \`${c.id}\` — ${t(c.title, lang)}**${c.impact ? ` (+${c.impact} ${t(UI.pts, lang)})` : ''}`,
      );
      lines.push(`   - **${t(UI.evidenceLabel, lang)}:** ${c.evidence.join(' ; ')}`);
      lines.push(`   - **${t(UI.fixLabel, lang)}:** ${t(c.fix, lang)}`);
      lines.push(`   - **${t(UI.docsLabel, lang)}:** ${docsUrl(lang, c.docsPath)}`);
    }
  }

  lines.push('');
  lines.push(`## ${t(UI.allChecksHeading, lang)}`);
  for (const st of report.stations) {
    const meta = STATION_MAP[st.id];
    lines.push('');
    lines.push(`### ${meta.order}. ${t(meta.name, lang)} (${st.score}/100)`);
    lines.push('');
    lines.push('| Status | Check | Title | Evidence |');
    lines.push('| --- | --- | --- | --- |');
    for (const c of st.checks) {
      const ev = c.evidence.join('; ').replace(/\|/g, '\\|');
      lines.push(
        `| **${c.status.toUpperCase()}** | \`${c.id}\` | ${t(c.title, lang)} | ${ev} |`,
      );
    }
  }

  if (report.interview) {
    lines.push('');
    lines.push(`## ${t(UI.interviewHeading, lang)} (${report.interview.score}/100 · ${report.interview.role})`);
    lines.push('');
    for (const ans of report.interview.answers) {
      lines.push(`- **${t(ans.question, lang)}** (${ans.score}/2) — ${t(ans.choiceLabel, lang)}`);
    }
  }

  if (report.deepReview) {
    lines.push('');
    lines.push(`## ${t(UI.deepReviewHeading, lang)} (${report.deepReview.provider})`);
    lines.push('');
    if (report.deepReview.error) {
      lines.push(`> ${report.deepReview.error}`);
    } else {
      lines.push(report.deepReview.summary);
      lines.push('');
      for (const f of report.deepReview.findings) {
        lines.push(`- **[${f.severity.toUpperCase()} · ${f.area}] ${f.title}** — ${f.detail} _Suggestion:_ ${f.suggestion}`);
      }
    }
  }

  if (!noPromo) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`## ${t(UI.nextStepsHeading, lang)}`);
    lines.push('');
    lines.push(`- **${t(UI.fixPromptHint, lang)}** \`npx harness-audit --prompt --out HARNESS-FIX-PROMPT.md\``);
    lines.push(
      `- **${t(UI.deepDiveBook, lang)}:** [${t(report.recommendations.book.title, lang)}](${report.recommendations.book.url}) — ${t(report.recommendations.book.reason, lang)}`,
    );
    if (report.recommendations.service.show) {
      lines.push(
        `- **${t(UI.forTeams, lang)}:** [${t(report.recommendations.service.headline, lang)}](${report.recommendations.service.url}) — ${t(report.recommendations.service.body, lang)}`,
      );
    }
  }

  lines.push('');
  lines.push(`_${t(UI.generatedBy, lang)}_`);
  lines.push('');

  return lines.join('\n');
}

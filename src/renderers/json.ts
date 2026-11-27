import { docsUrl, LEVELS, STATION_MAP, t } from '../i18n.js';
import type { AuditReport, RenderOptions } from '../types.js';

export function renderJson(report: AuditReport, options: RenderOptions = {}): string {
  const lang = options.lang ?? report.lang;
  const levelMeta = LEVELS[report.level];

  const payload = {
    schemaVersion: report.schemaVersion,
    toolVersion: report.toolVersion,
    auditedAt: report.auditedAt,
    repoName: report.repoName,
    repoPath: report.repoPath,
    lang,
    overallScore: report.overallScore,
    rawLevel: report.rawLevel,
    level: report.level,
    levelName: t(levelMeta.shortName, lang),
    shapiroName: t(levelMeta.shapiroName, lang),
    levelCaps: report.levelCaps.map((cap) => ({
      cappedTo: cap.cappedTo,
      triggeredBy: cap.triggeredBy,
      reason: t(cap.reason, lang),
    })),
    ...(report.nextLevel
      ? {
          nextLevel: {
            level: report.nextLevel.level,
            levelName: t(LEVELS[report.nextLevel.level].shortName, lang),
            scoreNeeded: report.nextLevel.scoreNeeded,
            pointsMissing: report.nextLevel.pointsMissing,
            blockers: report.nextLevel.blockers.map((b) => ({ id: b.id, requirement: t(b.requirement, lang) })),
          },
        }
      : {}),
    topPriorities: report.topPriorities.map((c) => c.id),
    scaffold: report.scaffold,
    scan: report.scan,
    stack: report.stack,
    git: report.git,
    stations: report.stations.map((st) => ({
      id: st.id,
      name: t(STATION_MAP[st.id].name, lang),
      weight: st.weight,
      score: st.score,
      passed: st.passed,
      warned: st.warned,
      failed: st.failed,
      info: st.info,
    })),
    checks: report.checks.map((c) => ({
      id: c.id,
      station: c.station,
      weight: c.weight,
      status: c.status,
      severity: c.severity,
      ...(c.impact !== undefined ? { impact: c.impact } : {}),
      title: t(c.title, lang),
      evidence: c.evidence,
      why: t(c.why, lang),
      fix: t(c.fix, lang),
      docsUrl: docsUrl(lang, c.docsPath),
    })),
    ...(report.interview
      ? {
          interview: {
            role: report.interview.role,
            score: report.interview.score,
            answers: report.interview.answers.map((a) => ({
              id: a.id,
              question: t(a.question, lang),
              choice: t(a.choiceLabel, lang),
              score: a.score,
            })),
            gaps: report.interview.gaps.map((g) => t(g, lang)),
          },
        }
      : {}),
    ...(report.deepReview ? { deepReview: report.deepReview } : {}),
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

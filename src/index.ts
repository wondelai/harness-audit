import { runAllChecks } from './checks/index.js';
import { RepoContext } from './fs-scanner.js';
import { STATIONS, TOOL_VERSION } from './i18n.js';
import {
  buildRecommendations,
  computeOverallScore,
  evaluateLevel,
  scoreStation,
  selectTopPriorities,
} from './scoring.js';
import type { AuditOptions, AuditReport } from './types.js';

export { RepoContext } from './fs-scanner.js';
export { initHarness } from './init.js';
export { INTERVIEW_QUESTIONS, runInteractiveInterview, scoreInterview } from './interview.js';
export { buildDeepPromptPayload, runDeepReview } from './deep.js';
export { generateFixPrompt } from './prompt-gen.js';
export { renderHtml, renderJson, renderMarkdown, renderReport, renderTerminal } from './renderers/index.js';
export { TOOL_VERSION, STATIONS, LEVELS, docsUrl } from './i18n.js';
export type * from './types.js';

export function auditRepo(repoPath: string, options: AuditOptions = {}): AuditReport {
  const lang = options.lang ?? 'en';
  const ctx = new RepoContext(repoPath);
  const checks = runAllChecks(ctx);

  const stations = STATIONS.map((s) => scoreStation(s.id, checks));
  const overallScore = computeOverallScore(stations);
  const { rawLevel, level, caps } = evaluateLevel(overallScore, stations, checks);
  const topPriorities = selectTopPriorities(checks, 5);
  const recommendations = buildRecommendations({
    lang,
    level,
    git: ctx.git,
    stack: ctx.stack,
    role: options.role,
  });

  return {
    schemaVersion: '1.0.0',
    toolVersion: TOOL_VERSION,
    auditedAt: new Date().toISOString(),
    repoPath: ctx.root,
    repoName: ctx.repoName,
    lang,
    stack: ctx.stack,
    git: ctx.git,
    overallScore,
    rawLevel,
    level,
    levelCaps: caps,
    stations,
    checks,
    topPriorities,
    interview: options.interview,
    deepReview: options.deepReview,
    recommendations,
  };
}

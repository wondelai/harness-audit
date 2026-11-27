import { describe, expect, it } from 'vitest';
import { STATIONS } from '../src/i18n.js';
import {
  assignImpact,
  buildRecommendations,
  computeOverallScore,
  criticalPenalty,
  evaluateLevel,
  nextLevelFor,
  rawLevelFromScore,
  scoreStation,
} from '../src/scoring.js';
import type { CheckResult, StationId } from '../src/types.js';

function makeCheck(
  id: string,
  station: StationId,
  status: CheckResult['status'],
  weight = 20,
  meta?: Record<string, unknown>,
): CheckResult {
  return {
    id,
    station,
    weight,
    status,
    severity: status === 'fail' ? 'high' : 'low',
    title: { en: id, pl: id },
    evidence: ['evidence'],
    why: { en: 'why', pl: 'dlaczego' },
    fix: { en: 'fix', pl: 'napraw' },
    docsPath: 'ladder/',
    meta,
  };
}

describe('scoring engine & level gating caps', () => {
  it('station weights sum to 1.00', () => {
    const sum = STATIONS.reduce((acc, s) => acc + s.weight, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('computes exact station scores excluding info checks', () => {
    const checks: CheckResult[] = [
      makeCheck('a', 'intent', 'pass', 40),
      makeCheck('b', 'intent', 'warn', 40), // 20 earned out of 40
      makeCheck('c', 'intent', 'fail', 20), // 0 earned out of 20
      makeCheck('d', 'intent', 'info', 50), // excluded from denominator
    ];
    // (40 + 20 + 0) / (40 + 40 + 20) = 60%
    const st = scoreStation('intent', checks);
    expect(st.score).toBe(60);
    expect(st.passed).toBe(1);
    expect(st.warned).toBe(1);
    expect(st.failed).toBe(1);
    expect(st.info).toBe(1);
  });

  it('maps raw score boundaries cleanly to Levels 0-5', () => {
    expect(rawLevelFromScore(0)).toBe(0);
    expect(rawLevelFromScore(24)).toBe(0);
    expect(rawLevelFromScore(25)).toBe(1);
    expect(rawLevelFromScore(44)).toBe(1);
    expect(rawLevelFromScore(45)).toBe(2);
    expect(rawLevelFromScore(62)).toBe(2);
    expect(rawLevelFromScore(63)).toBe(3);
    expect(rawLevelFromScore(77)).toBe(3);
    expect(rawLevelFromScore(78)).toBe(4);
    expect(rawLevelFromScore(89)).toBe(4);
    expect(rawLevelFromScore(90)).toBe(5);
    expect(rawLevelFromScore(100)).toBe(5);
  });

  it('caps a high raw score at Level 3 when Verification is weak or test quality fails', () => {
    const checks: CheckResult[] = [
      makeCheck('intent.instructions-file', 'intent', 'pass', 100),
      makeCheck('harness.permissions-policy', 'harness', 'pass', 100),
      makeCheck('loop.single-command-verify', 'loop', 'pass', 100),
      makeCheck('graph.worktree-isolation', 'graph', 'pass', 100),
      makeCheck('verification.unit-tests', 'verification', 'pass', 50),
      makeCheck('verification.test-quality-scan', 'verification', 'fail', 50),
      makeCheck('release.ci-pipeline', 'release', 'pass', 100),
    ];
    const stations = STATIONS.map((s) => scoreStation(s.id, checks));
    const overall = computeOverallScore(stations);
    // 0.2*100 + 0.18*100 + 0.18*100 + 0.1*100 + 0.2*50 + 0.14*100 = 90
    expect(overall).toBe(90);

    const { rawLevel, level, caps } = evaluateLevel(overall, stations, checks);
    expect(rawLevel).toBe(5);
    expect(level).toBe(3);
    expect(caps.some((c) => c.cappedTo === 3 && c.triggeredBy.includes('verification.test-quality-scan'))).toBe(true);
  });

  it('caps a 90+ score at Level 3 while the harness station is below 60', () => {
    const checks: CheckResult[] = [
      makeCheck('intent.instructions-file', 'intent', 'pass', 100),
      makeCheck('harness.permissions-policy', 'harness', 'fail', 50),
      makeCheck('harness.secret-hygiene', 'harness', 'pass', 50),
      makeCheck('loop.single-command-verify', 'loop', 'pass', 100),
      makeCheck('graph.worktree-isolation', 'graph', 'pass', 100),
      makeCheck('verification.unit-tests', 'verification', 'pass', 100),
      makeCheck('release.ci-pipeline', 'release', 'pass', 100),
    ];
    const stations = STATIONS.map((s) => scoreStation(s.id, checks));
    const overall = computeOverallScore(stations);
    // 100 - 0.18 * 50 = 91
    expect(overall).toBe(91);

    const { rawLevel, level, caps } = evaluateLevel(overall, stations, checks);
    expect(rawLevel).toBe(5);
    expect(level).toBe(3);
    expect(caps.some((c) => c.cappedTo === 3 && c.triggeredBy.includes('harness (<60)'))).toBe(true);

    // The same gate is what the report names as standing between Level 3 and Level 4.
    const next = nextLevelFor(level, overall, stations, checks);
    expect(next?.level).toBe(4);
    expect(next?.pointsMissing).toBe(0);
    expect(next?.blockers.map((b) => b.id)).toContain('harness (<60)');
  });

  it('caps at Level 3 without a permission policy even when hygiene checks carry the harness station', () => {
    const checks: CheckResult[] = [
      makeCheck('intent.instructions-file', 'intent', 'pass', 100),
      makeCheck('harness.permissions-policy', 'harness', 'fail', 25),
      makeCheck('harness.secret-hygiene', 'harness', 'pass', 75),
      makeCheck('loop.single-command-verify', 'loop', 'pass', 100),
      makeCheck('graph.worktree-isolation', 'graph', 'pass', 100),
      makeCheck('verification.unit-tests', 'verification', 'pass', 100),
      makeCheck('release.ci-pipeline', 'release', 'pass', 100),
    ];
    const stations = STATIONS.map((s) => scoreStation(s.id, checks));
    expect(stations.find((s) => s.id === 'harness')?.score).toBe(75);
    const overall = computeOverallScore(stations);
    const { level, caps } = evaluateLevel(overall, stations, checks);
    expect(level).toBe(3);
    expect(caps.find((c) => c.cappedTo === 3)?.triggeredBy).toEqual(['harness.permissions-policy']);
  });

  it('caps at Level 2 when there is no project brief, whatever the rest scores', () => {
    const checks: CheckResult[] = [
      makeCheck('intent.instructions-file', 'intent', 'fail', 10),
      makeCheck('intent.skills-and-specs', 'intent', 'pass', 90),
      makeCheck('harness.permissions-policy', 'harness', 'pass', 100),
      makeCheck('loop.single-command-verify', 'loop', 'pass', 100),
      makeCheck('graph.worktree-isolation', 'graph', 'pass', 100),
      makeCheck('verification.unit-tests', 'verification', 'pass', 100),
      makeCheck('release.ci-pipeline', 'release', 'pass', 100),
    ];
    const stations = STATIONS.map((s) => scoreStation(s.id, checks));
    const { rawLevel, level, caps } = evaluateLevel(computeOverallScore(stations), stations, checks);
    expect(rawLevel).toBe(5);
    expect(level).toBe(2);
    expect(caps.some((c) => c.cappedTo === 2 && c.triggeredBy.includes('intent.instructions-file'))).toBe(true);
  });

  it('takes 5 points per critical finding, 15 at most, and gives them back in the impact', () => {
    const critical = (id: string, station: StationId): CheckResult => ({ ...makeCheck(id, station, 'fail', 50), severity: 'critical' });
    const two = [critical('a', 'intent'), critical('b', 'loop'), makeCheck('c', 'harness', 'fail', 50)];
    expect(criticalPenalty(two)).toEqual({ points: 10, perCheck: 5, checks: ['a', 'b'] });

    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => critical(id, 'intent'));
    expect(criticalPenalty(five).points).toBe(15);
    expect(criticalPenalty(five).perCheck).toBe(3);

    // One station with one critical failing check: its whole weight plus the penalty comes back.
    const lone = [critical('intent.instructions-file', 'intent')];
    assignImpact(lone);
    expect(lone[0]!.impact).toBe(25);
  });

  it('caps a 95+ score at Level 4 when oracle protection is missing', () => {
    const checks: CheckResult[] = [
      makeCheck('intent.instructions-file', 'intent', 'pass', 100),
      makeCheck('harness.permissions-policy', 'harness', 'pass', 100),
      makeCheck('loop.single-command-verify', 'loop', 'pass', 100),
      makeCheck('graph.worktree-isolation', 'graph', 'pass', 100),
      makeCheck('verification.unit-tests', 'verification', 'pass', 90),
      makeCheck('verification.oracle-protection', 'verification', 'fail', 10),
      makeCheck('release.ci-pipeline', 'release', 'pass', 100),
    ];
    const stations = STATIONS.map((s) => scoreStation(s.id, checks));
    const overall = computeOverallScore(stations);
    expect(overall).toBeGreaterThanOrEqual(90);

    const { rawLevel, level, caps } = evaluateLevel(overall, stations, checks);
    expect(rawLevel).toBe(5);
    expect(level).toBe(4);
    expect(caps.some((c) => c.cappedTo === 4 && c.triggeredBy.includes('verification.oracle-protection'))).toBe(true);
  });

  it('tailors book & team services recommendations by contributor count and role in both EN and PL', () => {
    const soloEn = buildRecommendations({
      lang: 'en',
      level: 2,
      git: { isGitRepo: true, gitAuthors90d: 1, commits30d: 12 },
      stack: {
        languages: ['TypeScript'],
        frameworks: [],
        packageManagers: ['npm'],
        monorepo: false,
        verifyScripts: [],
        detectedTools: ['claude-code'],
        sourceFileCount: 10,
        testFileCount: 2,
      },
    });
    expect(soloEn.book.id).toBe('claude-code');
    expect(soloEn.service.show).toBe(false);
    expect(soloEn.book.url).toBe('https://developertoolkit.ai/en/books/');

    const teamPl = buildRecommendations({
      lang: 'pl',
      level: 3,
      git: { isGitRepo: true, gitAuthors90d: 6, commits30d: 90 },
      stack: {
        languages: ['TypeScript'],
        frameworks: ['Next.js'],
        packageManagers: ['pnpm'],
        monorepo: true,
        verifyScripts: ['test'],
        detectedTools: ['claude-code', 'cursor'],
        sourceFileCount: 100,
        testFileCount: 20,
      },
      role: 'lead',
    });
    expect(teamPl.book.id).toBe('track-tech-lead');
    expect(teamPl.book.title.pl).toBe('Inżynieria agentowa dla tech leadów');
    expect(teamPl.service.show).toBe(true);
    expect(teamPl.service.url).toBe('https://developertoolkit.ai/pl/services/');
  });
});

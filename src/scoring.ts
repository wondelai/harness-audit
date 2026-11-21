import { BOOK_CATALOG, docsUrl, STATIONS } from './i18n.js';
import type {
  AutonomyLevel,
  BookRecommendation,
  CheckResult,
  GitStats,
  InterviewRole,
  Lang,
  LevelCap,
  ServiceRecommendation,
  Severity,
  StackInfo,
  StationId,
  StationScore,
} from './types.js';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function scoreStation(stationId: StationId, checks: CheckResult[]): StationScore {
  const stationMeta = STATIONS.find((s) => s.id === stationId)!;
  const stationChecks = checks.filter((c) => c.station === stationId);

  let earned = 0;
  let possible = 0;
  let passed = 0;
  let warned = 0;
  let failed = 0;
  let info = 0;

  for (const c of stationChecks) {
    if (c.status === 'info') {
      info++;
      continue;
    }
    possible += c.weight;
    if (c.status === 'pass') {
      earned += c.weight;
      passed++;
    } else if (c.status === 'warn') {
      earned += c.weight * 0.5;
      warned++;
    } else {
      failed++;
    }
  }

  const score = possible > 0 ? Math.round((earned / possible) * 100) : 100;

  return {
    id: stationId,
    weight: stationMeta.weight,
    score,
    passed,
    warned,
    failed,
    info,
    checks: stationChecks,
  };
}

export function computeOverallScore(stations: StationScore[]): number {
  let sum = 0;
  let totalWeight = 0;
  for (const st of stations) {
    sum += st.score * st.weight;
    totalWeight += st.weight;
  }
  return totalWeight > 0 ? Math.round(sum / totalWeight) : 0;
}

export function rawLevelFromScore(overallScore: number): AutonomyLevel {
  if (overallScore < 25) return 0;
  if (overallScore < 45) return 1;
  if (overallScore < 63) return 2;
  if (overallScore < 78) return 3;
  if (overallScore < 90) return 4;
  return 5;
}

export function evaluateLevel(
  overallScore: number,
  stations: StationScore[],
  checks: CheckResult[],
): { rawLevel: AutonomyLevel; level: AutonomyLevel; caps: LevelCap[] } {
  const rawLevel = rawLevelFromScore(overallScore);
  const byId = new Map(checks.map((c) => [c.id, c]));
  const stationById = new Map(stations.map((s) => [s.id, s]));
  const caps: LevelCap[] = [];

  const checkStatus = (id: string) => byId.get(id)?.status;
  const checkMeta = (id: string) => byId.get(id)?.meta ?? {};
  const stationScore = (id: StationId) => stationById.get(id)?.score ?? 0;

  // Cap 1: No Level 2+ without instructions AND verify loop
  if (
    rawLevel >= 2 &&
    checkStatus('intent.instructions-file') === 'fail' &&
    checkStatus('loop.single-command-verify') === 'fail'
  ) {
    caps.push({
      cappedTo: 1,
      triggeredBy: ['intent.instructions-file', 'loop.single-command-verify'],
      reason: {
        en: 'Capped at Level 1: repository has neither canonical agent instructions nor a repeatable local verification loop.',
        pl: 'Ograniczenie do Poziomu 1: repozytorium nie ma ani kanonicznych instrukcji dla agentów, ani powtarzalnej lokalnej pętli weryfikacji.',
      },
    });
  }

  // Cap 2: No Level 3+ without unit tests OR without a CI pipeline
  if (rawLevel >= 3) {
    const missingTests = checkStatus('verification.unit-tests') === 'fail';
    const missingCi = checkStatus('release.ci-pipeline') === 'fail';
    if (missingTests || missingCi) {
      const triggered = [
        missingTests ? 'verification.unit-tests' : '',
        missingCi ? 'release.ci-pipeline' : '',
      ].filter(Boolean);
      caps.push({
        cappedTo: 2,
        triggeredBy: triggered,
        reason: {
          en: 'Capped at Level 2: delegating whole tasks (Level 3+) requires both a real test suite and a CI verification pipeline.',
          pl: 'Ograniczenie do Poziomu 2: delegowanie całych zadań (Poziom 3+) wymaga zarówno prawdziwego zestawu testów, jak i potoku CI.',
        },
      });
    }
  }

  // Cap 3: No Level 3+ with hardcoded secrets or broken/bypassed permission config
  if (rawLevel >= 3) {
    const hasSecrets =
      Boolean(checkMeta('harness.secret-hygiene')['hasHardcodedSecrets']) ||
      Boolean(checkMeta('harness.mcp-hygiene')['hasHardcodedMcpSecrets']);
    const hasCritPerm = Boolean(checkMeta('harness.permissions-policy')['hasCriticalPermissionError']);
    if (hasSecrets || hasCritPerm) {
      const triggered = [
        hasSecrets ? 'harness.secret-hygiene' : '',
        hasCritPerm ? 'harness.permissions-policy' : '',
      ].filter(Boolean);
      caps.push({
        cappedTo: 2,
        triggeredBy: triggered,
        reason: {
          en: 'Capped at Level 2: critical harness hygiene blocker (hardcoded credentials, retired Codex approval_policy, or bypassPermissions in repo config).',
          pl: 'Ograniczenie do Poziomu 2: krytyczny błąd higieny uprzęży (jawne sekrety, wycofane approval_policy w Codex lub bypassPermissions w konfiguracji repo).',
        },
      });
    }
  }

  // Cap 4: No Level 4+ without strong Verification (>=70), Loop (>=70), passing CI, and non-failing test quality scan
  if (rawLevel >= 4) {
    const triggers: string[] = [];
    if (stationScore('verification') < 70) triggers.push('verification (<70)');
    if (stationScore('loop') < 70) triggers.push('loop (<70)');
    if (checkStatus('release.ci-pipeline') !== 'pass') triggers.push('release.ci-pipeline');
    if (checkStatus('verification.test-quality-scan') === 'fail') triggers.push('verification.test-quality-scan');

    if (triggers.length > 0) {
      caps.push({
        cappedTo: 3,
        triggeredBy: triggers,
        reason: {
          en: 'Capped at Level 3: unattended Level 4 runs require strong Verification (>=70), fast Loop (>=70), PR-gated CI, and clean non-tautological tests.',
          pl: 'Ograniczenie do Poziomu 3: bezobsługowe uruchomienia Poziomu 4 wymagają silnej Weryfikacji (>=70), szybkiej Pętli (>=70), CI na PR i rzetelnych testów.',
        },
      });
    }
  }

  // Cap 5: No Level 5 without protected oracles + Graph >= 70 + Release >= 80 + Harness >= 75 + Verification >= 85
  if (rawLevel === 5) {
    const triggers: string[] = [];
    if (checkStatus('verification.oracle-protection') !== 'pass') triggers.push('verification.oracle-protection');
    if (stationScore('graph') < 70) triggers.push('graph (<70)');
    if (stationScore('release') < 80) triggers.push('release (<80)');
    if (stationScore('harness') < 75) triggers.push('harness (<75)');
    if (stationScore('verification') < 85) triggers.push('verification (<85)');

    if (triggers.length > 0) {
      caps.push({
        cappedTo: 4,
        triggeredBy: triggers,
        reason: {
          en: 'Capped at Level 4: Level 5 dark-factory loops require protected oracles (CODEOWNERS/CI guard), multi-agent isolation (Graph >=70), hardened Harness (>=75), Verification (>=85), and Release (>=80).',
          pl: 'Ograniczenie do Poziomu 4: pętle ciemnej fabryki Poziomu 5 wymagają chronionych wyroczni (CODEOWNERS/CI), izolacji równoległej (Graf >=70), utwardzonej Uprzęży (>=75), Weryfikacji (>=85) i Wydania (>=80).',
        },
      });
    }
  }

  let level = rawLevel;
  for (const cap of caps) {
    if (cap.cappedTo < level) {
      level = cap.cappedTo;
    }
  }

  return { rawLevel, level, caps };
}

export function selectTopPriorities(checks: CheckResult[], limit = 5): CheckResult[] {
  return checks
    .filter((c) => c.status === 'fail' || c.status === 'warn')
    .sort((a, b) => {
      // Fail before warn
      if (a.status !== b.status) return a.status === 'fail' ? -1 : 1;
      // Higher severity first
      const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (sevDiff !== 0) return sevDiff;
      // Higher weight first
      return b.weight - a.weight;
    })
    .slice(0, limit);
}

export function buildRecommendations(params: {
  lang: Lang;
  level: AutonomyLevel;
  git: GitStats;
  stack: StackInfo;
  role?: InterviewRole;
}): { book: BookRecommendation; service: ServiceRecommendation } {
  const { lang, level, git, stack, role } = params;
  const isTeam = git.gitAuthors90d >= 3 || role === 'lead' || role === 'cto';

  let bookId = 'handbook';
  let bookReason = {
    en: 'End-to-end engineering handbook covering the 6 stations, specs, verification oracles, and multi-tool setup.',
    pl: 'Kompletny podręcznik inżynierski obejmujący 6 stacji fabryki, specyfikacje, wyrocznie testowe i konfigurację narzędzi.',
  };

  if (role === 'cto' || git.gitAuthors90d >= 12) {
    bookId = 'track-cto';
    bookReason = {
      en: 'Governance, risk classes, loop registers, and org-wide operating models for moving teams safely up the ladder.',
      pl: 'Zarządzanie ryzykiem, klasy zmian, rejestry pętli i model operacyjny dla całych organizacji przechodzących na wyższe poziomy drabiny.',
    };
  } else if (role === 'lead' || git.gitAuthors90d >= 3) {
    bookId = 'track-tech-lead';
    bookReason = {
      en: 'Practical playbook for breaking the Level 3 review bottleneck, protecting test oracles, and rolling out shared harnesses.',
      pl: 'Praktyczny przewodnik przełamywania wąskiego gardła review na Poziomie 3, ochrony wyroczni testowych i wdrażania wspólnej uprzęży.',
    };
  } else if (level <= 2 && stack.detectedTools.length === 1) {
    const sole = stack.detectedTools[0];
    if (sole === 'claude-code') {
      bookId = 'claude-code';
      bookReason = {
        en: 'Focused guide to Claude Code permissions, hooks, subagents, skills, and verified loops.',
        pl: 'Konkretny przewodnik po uprawnieniach, hookach, podagentach, skillach i zweryfikowanych pętlach w Claude Code.',
      };
    } else if (sole === 'cursor') {
      bookId = 'cursor';
      bookReason = {
        en: 'Focused guide to Cursor `.mdc` rules, worktrees, Bugbot, and background agent loops.',
        pl: 'Konkretny przewodnik po regułach `.mdc`, worktree, Bugbocie i pętlach agentów w tle w Cursorze.',
      };
    } else if (sole === 'codex') {
      bookId = 'codex';
      bookReason = {
        en: 'Focused guide to Codex `AGENTS.md`, permission profiles, sandboxes, and headless CI runs.',
        pl: 'Konkretny przewodnik po `AGENTS.md`, profilach uprawnień, piaskownicach i uruchomieniach headless w Codexie.',
      };
    }
  } else if (role === 'dev' || level <= 2) {
    bookId = 'track-developer';
    bookReason = {
      en: 'Step-by-step developer path from paired prompting (Level 2) to spec-driven verified runs (Level 4).',
      pl: 'Ścieżka krok po kroku dla programisty — od pracy w parze (Poziom 2) do zweryfikowanych uruchomień ze specyfikacji (Poziom 4).',
    };
  }

  const catalogEntry = BOOK_CATALOG[bookId] ?? BOOK_CATALOG['handbook']!;
  const book: BookRecommendation = {
    id: catalogEntry.id,
    title: catalogEntry.title,
    reason: bookReason,
    url: docsUrl(lang, catalogEntry.urlPath),
  };

  const service: ServiceRecommendation = {
    show: isTeam,
    headline: {
      en: 'Repo Diagnostic or Team Working Day (Wondel.ai)',
      pl: 'Diagnoza repozytorium lub Dzień pracy z zespołem (Wondel.ai)',
    },
    body: {
      en:
        git.gitAuthors90d >= 3
          ? `Detected ${git.gitAuthors90d} active contributors in the last 90 days. If your team wants a fixed-price Repo Diagnostic or hands-on Team Working Day to clear the Level 3 review queue and harden your harness:`
          : 'If your engineering team wants a fixed-price Repo Diagnostic or hands-on Team Working Day to harden your agent harness and verification pipeline:',
      pl:
        git.gitAuthors90d >= 3
          ? `Wykryto ${git.gitAuthors90d} aktywnych autorów w ostatnich 90 dniach. Jeśli zespół chce diagnozę repozytorium w stałej cenie lub praktyczny Dzień pracy z zespołem, aby odblokować review na Poziomie 3 i utwardzić uprząż:`
          : 'Jeśli zespół inżynierski chce diagnozę repozytorium w stałej cenie lub praktyczny Dzień pracy z zespołem, aby utwardzić uprząż agentów i potok weryfikacji:',
    },
    url: docsUrl(lang, 'services/'),
  };

  return { book, service };
}

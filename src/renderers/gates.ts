import { STATION_MAP, t, UI } from '../i18n.js';
import type { AuditReport, Lang, StationId } from '../types.js';

/**
 * One gate in plain words: `harness (<60)` becomes "Harness ≥ 60 (now 45)", a check id becomes
 * "harness.permissions-policy must pass". Only the requirement that is actually unmet is named.
 */
export function describeGate(id: string, report: AuditReport, lang: Lang): string {
  const station = /^(\w+) \(<(\d+)\)$/.exec(id);
  if (station) {
    const meta = STATION_MAP[station[1] as StationId];
    const score = report.stations.find((s) => s.id === station[1])?.score;
    const name = meta ? t(meta.name, lang) : station[1]!;
    return lang === 'pl' ? `${name} ≥ ${station[2]} (teraz ${score ?? '?'})` : `${name} ≥ ${station[2]} (now ${score ?? '?'})`;
  }
  return lang === 'pl' ? `${id} musi przejść` : `${id} must pass`;
}

/** The gates of the next level that the caps already printed do not cover. */
export function uncappedGates(report: AuditReport): Array<string> {
  const capped = new Set(report.levelCaps.flatMap((cap) => cap.triggeredBy));
  return [...new Set((report.nextLevel?.blockers ?? []).map((b) => b.id))].filter((id) => !capped.has(id));
}

/** Notes for a checkout that is behind the default branch: the audit is of the checkout, and says so. */
export function branchNotes(report: AuditReport, lang: Lang): Array<string> {
  const { branch, defaultBranch, behindDefault, defaultBranchOnly } = report.git;
  if (!branch || !defaultBranch || !behindDefault) {return [];}
  const fill = (text: string): string =>
    text.replace('{branch}', branch).replace('{n}', String(behindDefault)).replace('{default}', defaultBranch).replace('{files}', (defaultBranchOnly ?? []).slice(0, 4).join(', '));
  return [fill(t(UI.branchBehind, lang)), ...(defaultBranchOnly?.length ? [fill(t(UI.branchLacks, lang))] : [])];
}

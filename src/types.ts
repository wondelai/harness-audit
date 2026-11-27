export type Lang = 'en' | 'pl';

export type StationId =
  | 'intent'
  | 'harness'
  | 'loop'
  | 'graph'
  | 'verification'
  | 'release';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type InterviewRole = 'dev' | 'lead' | 'cto';

export type OutputFormat = 'terminal' | 'md' | 'html' | 'json';

export type SupportedTool = 'claude-code' | 'cursor' | 'codex';

export interface LocalizedText {
  en: string;
  pl: string;
}

/** How the repository's files were enumerated, so a report can say what it did not see. */
export interface ScanInfo {
  /** `git`: tracked files plus untracked files `.gitignore` does not exclude. `walk`: plain directory walk. */
  mode: 'git' | 'walk';
  fileCount: number;
  /** The repository holds more files than the scan limit; deep paths were left out. */
  truncated: boolean;
}

export interface CheckResult {
  id: string;
  station: StationId;
  weight: number;
  status: CheckStatus;
  severity: Severity;
  title: LocalizedText;
  evidence: string[];
  why: LocalizedText;
  fix: LocalizedText;
  docsPath: string;
  /** Optional structured metadata useful for gating caps and prompt generation. */
  meta?: Record<string, unknown>;
  /**
   * Points the overall score gains when this check passes. Set by the scoring pass for every
   * failing or warning check; absent on passing and informational ones.
   */
  impact?: number;
}

/** What stands between the repository and the next autonomy level. */
export interface NextLevel {
  level: AutonomyLevel;
  /** Overall score the level needs. */
  scoreNeeded: number;
  /** Points still missing; 0 when only gates are in the way. */
  pointsMissing: number;
  /** Gates that hold the level down whatever the score: check ids and station thresholds. */
  blockers: Array<{ id: string; requirement: LocalizedText }>;
}

export interface StationScore {
  id: StationId;
  weight: number;
  score: number;
  passed: number;
  warned: number;
  failed: number;
  info: number;
  checks: CheckResult[];
}

export interface LevelCap {
  cappedTo: AutonomyLevel;
  reason: LocalizedText;
  triggeredBy: string[];
}

export interface StackInfo {
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  monorepo: boolean;
  verifyScripts: string[];
  /** Runnable verify commands with what each proves, e.g. `bun run verify (lint + typecheck + test)`. */
  verifyCommands: string[];
  detectedTools: SupportedTool[];
  sourceFileCount: number;
  testFileCount: number;
}

export interface GitStats {
  isGitRepo: boolean;
  branch?: string;
  /** People (not bots or coding agents) who authored a commit in the last 90 days. */
  gitAuthors90d: number;
  /** People in the last 3,000 commits: who a quiet repository belongs to. */
  authorsAllTime: number;
  commits30d: number;
  commits90d: number;
  /** The branch pull requests target (origin's HEAD, else the checked-out branch). */
  defaultBranch?: string;
  /** Commits the default branch has that this checkout lacks, when another branch is checked out. */
  behindDefault?: number;
  /** Harness files (CI workflows, briefs, settings) on the default branch that this checkout lacks. */
  defaultBranchOnly?: string[];
  remoteName?: string;
}

export interface InterviewAnswer {
  id: string;
  question: LocalizedText;
  choiceLabel: LocalizedText;
  score: number; // 0, 1, or 2
}

export interface InterviewResult {
  role: InterviewRole;
  score: number; // 0-100
  answers: InterviewAnswer[];
  gaps: LocalizedText[];
}

export interface DeepFinding {
  area: 'instructions' | 'tests' | 'architecture' | 'harness';
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  suggestion: string;
}

export interface DeepReviewResult {
  provider: string;
  model?: string;
  filesInspected: string[];
  summary: string;
  findings: DeepFinding[];
  error?: string;
}

export interface BookRecommendation {
  id: string;
  title: LocalizedText;
  reason: LocalizedText;
  url: string;
}

export interface ServiceRecommendation {
  show: boolean;
  headline: LocalizedText;
  body: LocalizedText;
  url: string;
}

export interface AuditReport {
  schemaVersion: '1.1.0';
  toolVersion: string;
  auditedAt: string;
  repoPath: string;
  repoName: string;
  lang: Lang;
  scan: ScanInfo;
  stack: StackInfo;
  git: GitStats;
  /** The weighted station total minus the critical penalty. */
  overallScore: number;
  /** The weighted station total on its own. */
  stationScore: number;
  /** Points taken off for critical findings (5 each, 15 at most) and the checks that caused it. */
  criticalPenalty: { points: number; checks: string[] };
  rawLevel: AutonomyLevel;
  level: AutonomyLevel;
  levelCaps: LevelCap[];
  /** Absent at Level 5. */
  nextLevel?: NextLevel;
  /** Files `harness-audit init` would create here (it never overwrites an existing file). */
  scaffold: string[];
  stations: StationScore[];
  checks: CheckResult[];
  topPriorities: CheckResult[];
  interview?: InterviewResult;
  deepReview?: DeepReviewResult;
  recommendations: {
    book: BookRecommendation;
    service: ServiceRecommendation;
  };
}

export interface AuditOptions {
  lang?: Lang;
  role?: InterviewRole;
  interview?: InterviewResult;
  deepReview?: DeepReviewResult;
}

export interface RenderOptions {
  lang?: Lang;
  ci?: boolean;
  noPromo?: boolean;
  noColor?: boolean;
  /** Terminal only: list every check with its evidence, passing ones included. */
  verbose?: boolean;
}

export interface InitOptions {
  dryRun?: boolean;
  force?: boolean;
  tools?: SupportedTool[];
  lang?: Lang;
}

export interface InitAction {
  path: string;
  action: 'create' | 'overwrite' | 'skip';
  reason: string;
  content: string;
}

export interface InitResult {
  repoPath: string;
  dryRun: boolean;
  tools: SupportedTool[];
  actions: InitAction[];
}

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
  detectedTools: SupportedTool[];
  sourceFileCount: number;
  testFileCount: number;
}

export interface GitStats {
  isGitRepo: boolean;
  branch?: string;
  gitAuthors90d: number;
  commits30d: number;
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
  schemaVersion: '1.0.0';
  toolVersion: string;
  auditedAt: string;
  repoPath: string;
  repoName: string;
  lang: Lang;
  stack: StackInfo;
  git: GitStats;
  overallScore: number;
  rawLevel: AutonomyLevel;
  level: AutonomyLevel;
  levelCaps: LevelCap[];
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

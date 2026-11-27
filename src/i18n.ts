import { createRequire } from 'node:module';
import type { AutonomyLevel, Lang, LocalizedText, StationId } from './types.js';

/** The version in package.json, which sits one directory above both `src/` and the built `dist/`. */
export const TOOL_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
export const BASE_DOCS_URL = 'https://developertoolkit.ai';

export function docsUrl(lang: Lang, docsPath: string): string {
  const clean = docsPath.replace(/^\/+/, '');
  return `${BASE_DOCS_URL}/${lang}/${clean}`;
}

export function t(text: LocalizedText, lang: Lang): string {
  return text[lang];
}

export interface StationMeta {
  id: StationId;
  order: number;
  weight: number;
  name: LocalizedText;
  decision: LocalizedText;
  docsPath: string;
}

export const STATIONS: readonly StationMeta[] = [
  {
    id: 'intent',
    order: 1,
    weight: 0.2,
    name: { en: 'Intent', pl: 'Intencja' },
    decision: {
      en: 'What the agent knows before it starts',
      pl: 'Co agent wie, zanim zacznie pracę',
    },
    docsPath: 'workflows/harness/agent-ready-codebase/',
  },
  {
    id: 'harness',
    order: 2,
    weight: 0.18,
    name: { en: 'Harness', pl: 'Uprząż (Harness)' },
    decision: {
      en: 'What the agent may run, read, and reach',
      pl: 'Co agent może uruchamiać i do czego ma dostęp',
    },
    docsPath: 'workflows/harness/permissions-and-sandboxing/',
  },
  {
    id: 'loop',
    order: 3,
    weight: 0.18,
    name: { en: 'Loop', pl: 'Pętla (Loop)' },
    decision: {
      en: 'How fast the agent verifies and when it stops',
      pl: 'Jak szybko agent weryfikuje zmiany i kiedy kończy',
    },
    docsPath: 'ladder/level-4-write-specs/',
  },
  {
    id: 'graph',
    order: 4,
    weight: 0.1,
    name: { en: 'Graph', pl: 'Graf (Graph)' },
    decision: {
      en: 'How multiple agents run without colliding',
      pl: 'Jak wielu agentów pracuje równolegle bez kolizji',
    },
    docsPath: 'ladder/level-5-run-the-factory/',
  },
  {
    id: 'verification',
    order: 5,
    weight: 0.2,
    name: { en: 'Verification', pl: 'Weryfikacja' },
    decision: {
      en: 'What counts as proof that the agent cannot fake',
      pl: 'Co stanowi dowód, którego agent nie może sfałszować',
    },
    docsPath: 'workflows/test/protect-the-oracle/',
  },
  {
    id: 'release',
    order: 6,
    weight: 0.14,
    name: { en: 'Release', pl: 'Wydanie (Release)' },
    decision: {
      en: 'How verified work leaves the repository safely',
      pl: 'Jak zweryfikowana zmiana bezpiecznie opuszcza repozytorium',
    },
    docsPath: 'workflows/ship/evidence-bundle/',
  },
] as const;

export const STATION_MAP: Record<StationId, StationMeta> = Object.fromEntries(
  STATIONS.map((s) => [s.id, s]),
) as Record<StationId, StationMeta>;

export interface LevelMeta {
  level: AutonomyLevel;
  shortName: LocalizedText;
  shapiroName: LocalizedText;
  summary: LocalizedText;
  docsPath: string;
}

export const LEVELS: Record<AutonomyLevel, LevelMeta> = {
  0: {
    level: 0,
    shortName: { en: 'By hand', pl: 'Ręcznie' },
    shapiroName: { en: 'Spicy autocomplete', pl: 'Podkręcone autouzupełnianie' },
    summary: {
      en: 'No durable agent instructions or automated verification loop; every line still depends on manual typing and inspection.',
      pl: 'Brak trwałych instrukcji dla agentów i automatycznej pętli weryfikacji — każda linia zależy od ręcznej pracy i kontroli.',
    },
    docsPath: 'ladder/',
  },
  1: {
    level: 1,
    shortName: { en: 'Assisted', pl: 'Wspomagany' },
    shapiroName: { en: 'The coding intern', pl: 'Stażysta programista' },
    summary: {
      en: 'Basic repository scaffolding exists, so agents can handle small discrete tasks under tight supervision.',
      pl: 'Istnieją podstawy konfiguracji repozytorium — agenci mogą wykonywać małe, wydzielone zadania pod ścisłym nadzorem.',
    },
    docsPath: 'ladder/level-1-2-assisted-paired/',
  },
  2: {
    level: 2,
    shortName: { en: 'Paired', pl: 'W parze' },
    shapiroName: { en: 'The junior developer', pl: 'Junior developer' },
    summary: {
      en: 'Agents can pair on multi-file changes, but gaps in verification, CI, or permissions still require watching every diff.',
      pl: 'Agenci mogą pracować w parze nad zmianami wieloplikowymi, ale braki w weryfikacji, CI lub uprawnieniach wymagają czytania każdego diffa.',
    },
    docsPath: 'ladder/level-1-2-assisted-paired/',
  },
  3: {
    level: 3,
    shortName: { en: 'Review manager', pl: 'Zarządzanie review' },
    shapiroName: { en: 'The developer', pl: 'Deweloper' },
    summary: {
      en: 'Solid local loop, tests, and CI let agents execute whole tasks; humans act primarily as full-time diff reviewers.',
      pl: 'Solidna lokalna pętla, testy i CI pozwalają delegować całe zadania; ludzie działają głównie jako pełnoetatowi recenzenci diffów.',
    },
    docsPath: 'ladder/level-3-review-diffs/',
  },
  4: {
    level: 4,
    shortName: { en: 'Spec manager', pl: 'Zarządzanie specyfikacją' },
    shapiroName: { en: 'The engineering team', pl: 'Zespół inżynierski' },
    summary: {
      en: 'Strong stop conditions, test quality, and CI gates support unattended runs reviewed through evidence rather than line-by-line diffs.',
      pl: 'Silne warunki stopu, jakość testów i bramki CI pozwalają na pracę bez nadzoru ocenianą po dowodach, a nie linia po linii.',
    },
    docsPath: 'ladder/level-4-write-specs/',
  },
  5: {
    level: 5,
    shortName: { en: 'Dark factory', pl: 'Ciemna fabryka' },
    shapiroName: { en: 'The dark software factory', pl: 'Ciemna fabryka oprogramowania' },
    summary: {
      en: 'Protected oracles, multi-agent isolation, hardened harness, and release evidence enable bounded unattended factory loops.',
      pl: 'Chronione wyrocznie, izolacja wielu agentów, utwardzona uprząż i dowody wydań umożliwiają bezpieczne pętle fabryczne bez nadzoru.',
    },
    docsPath: 'ladder/level-5-run-the-factory/',
  },
};

export interface BookCatalogEntry {
  id: string;
  title: LocalizedText;
  urlPath: string;
}

export const BOOK_CATALOG: Record<string, BookCatalogEntry> = {
  handbook: {
    id: 'handbook',
    title: { en: 'The AI Engineering Handbook', pl: 'Podręcznik inżynierii AI' },
    urlPath: 'books/',
  },
  'track-developer': {
    id: 'track-developer',
    title: {
      en: 'Agentic Engineering for Developers',
      pl: 'Inżynieria agentowa dla deweloperów',
    },
    urlPath: 'books/',
  },
  'track-tech-lead': {
    id: 'track-tech-lead',
    title: {
      en: 'Agentic Engineering for Tech Leads',
      pl: 'Inżynieria agentowa dla tech leadów',
    },
    urlPath: 'books/',
  },
  'track-cto': {
    id: 'track-cto',
    title: {
      en: 'Agentic Engineering for CTOs',
      pl: 'Inżynieria agentowa dla CTO',
    },
    urlPath: 'books/',
  },
  'claude-code': {
    id: 'claude-code',
    title: {
      en: 'AI Engineering with Claude Code',
      pl: 'Inżynieria AI z Claude Code',
    },
    urlPath: 'books/',
  },
  cursor: {
    id: 'cursor',
    title: {
      en: 'AI Engineering with Cursor',
      pl: 'Inżynieria AI z Cursorem',
    },
    urlPath: 'books/',
  },
  codex: {
    id: 'codex',
    title: {
      en: 'AI Engineering with Codex',
      pl: 'Inżynieria AI z Codexem',
    },
    urlPath: 'books/',
  },
};

export const UI = {
  reportTitle: {
    en: 'Agent Harness Audit',
    pl: 'Audyt uprzęży agentów AI',
  },
  subtitle: {
    en: '6 Software Factory Stations · Autonomy Ladder (Level 0–5)',
    pl: '6 Stacji Fabryki Oprogramowania · Drabina Autonomii (Poziom 0–5)',
  },
  overallScore: { en: 'Overall Score', pl: 'Wynik ogólny' },
  autonomyLevel: { en: 'Autonomy Level', pl: 'Poziom autonomii' },
  rawScoreLevel: { en: 'Uncapped level', pl: 'Poziom przed ograniczeniami' },
  penaltyLine: {
    en: '= {stations} from the stations − {points} for critical findings ({checks})',
    pl: '= {stations} ze stacji − {points} za ustalenia krytyczne ({checks})',
  },
  levelCapsHeading: { en: 'Level capped', pl: 'Poziom ograniczony' },
  capNeeds: { en: 'needs', pl: 'wymaga' },
  liftCap: { en: 'lift the cap above first', pl: 'najpierw zdejmij powyższe ograniczenie' },
  stackHeading: { en: 'Detected Stack & Context', pl: 'Wykryty stos i kontekst' },
  stationsHeading: { en: 'Six Factory Stations', pl: 'Sześć stacji fabryki' },
  topPrioritiesHeading: { en: 'Top Fixes', pl: 'Najważniejsze poprawki' },
  topPrioritiesOrder: {
    en: '(critical first, then next-level gates, then by severity and points gained)',
    pl: '(najpierw krytyczne, potem bramki kolejnego poziomu, potem według wagi i zysku punktowego)',
  },
  nextLevelHeading: { en: 'Next level', pl: 'Kolejny poziom' },
  scoreNeeded: { en: 'needs', pl: 'wymaga' },
  pointsToGo: { en: 'to go', pl: 'do zdobycia' },
  gateLabel: { en: 'Gate', pl: 'Bramka' },
  unblocks: { en: 'unblocks', pl: 'odblokowuje' },
  pts: { en: 'pts', pl: 'pkt' },
  seeTopFix: { en: 'top fix', pl: 'poprawka' },
  verboseHint: { en: '(--verbose lists passing checks with evidence)', pl: '(--verbose pokazuje też zaliczone checki z dowodami)' },
  stackUnknown: { en: 'no recognised language', pl: 'nie rozpoznano języka' },
  scanGit: {
    en: 'files (tracked + untracked; .gitignore respected, so local env files and build output are not audited)',
    pl: 'plików (śledzone + nieśledzone; z uwzględnieniem .gitignore, więc lokalne pliki env i wyniki builda nie są audytowane)',
  },
  scanWalk: {
    en: 'files (directory walk; not a git work tree, so .gitignore is not applied)',
    pl: 'plików (przejście po katalogach; to nie jest repozytorium git, więc .gitignore nie jest stosowany)',
  },
  scanTruncated: {
    en: 'Scan limit reached: the deepest paths were not read, so counts and file-based findings may be incomplete.',
    pl: 'Osiągnięto limit skanu: najgłębsze ścieżki nie zostały przeczytane, więc liczniki i ustalenia mogą być niepełne.',
  },
  scaffoldHint: {
    en: 'Preview the starter files this repo is missing:',
    pl: 'Podejrzyj pliki startowe, których brakuje w tym repo:',
  },
  allChecksHeading: { en: 'Detailed Station Findings', pl: 'Szczegółowe wyniki według stacji' },
  interviewHeading: { en: 'Org & Workflow Assessment', pl: 'Ocena organizacji i procesu pracy' },
  deepReviewHeading: { en: 'Deep Qualitative Review (LLM)', pl: 'Pogłębiona analiza jakościowa (LLM)' },
  nextStepsHeading: { en: 'Next Steps', pl: 'Kolejne kroki' },
  deepDiveBook: { en: 'Deep dive (Book)', pl: 'Pogłęb temat (Książka)' },
  forTeams: { en: 'For teams', pl: 'Dla zespołów' },
  fixPromptHint: {
    en: 'Generate a repo-specific remediation prompt for your agent:',
    pl: 'Wygeneruj prompt naprawczy dopasowany do tego repozytorium:',
  },
  evidenceLabel: { en: 'Evidence', pl: 'Dowód' },
  whyLabel: { en: 'Why', pl: 'Dlaczego to ważne' },
  fixLabel: { en: 'Fix', pl: 'Jak naprawić' },
  docsLabel: { en: 'Guide', pl: 'Przewodnik' },
  pass: { en: 'PASS', pl: 'OK' },
  warn: { en: 'WARN', pl: 'UWAGA' },
  fail: { en: 'FAIL', pl: 'BŁĄD' },
  info: { en: 'INFO', pl: 'INFO' },
  contributors90d: { en: 'active contributors (90d)', pl: 'aktywnych autorów (90 dni)' },
  commits30d: { en: 'commits (30d)', pl: 'commitów (30 dni)' },
  generatedBy: {
    en: 'Generated locally by @wondelai/harness-audit — zero telemetry, zero network calls in default mode.',
    pl: 'Wygenerowano lokalnie przez @wondelai/harness-audit — zero telemetrii, zero zapytań sieciowych w trybie domyślnym.',
  },
  cliHelp: {
    en: `Usage:
  harness-audit [path] [options]
  harness-audit init [path] [options]

Audit any repository's AI coding agent harness across the 6 Software Factory
Stations (Intent, Harness, Loop, Graph, Verification, Release) and place it
on the Autonomy Ladder (Level 0–5).

Audit options:
  --format <fmt>      Output format: terminal | md | html | json (default: terminal)
  --out <file>        Write output to a file instead of stdout
  --lang <lang>       Language: en | pl (default: en)
  --ci                CI mode: strip decorative banners & promo footer
  --min-score <N>     Exit with code 1 if overall score < N (0–100)
  --no-promo          Hide book and team-services next-step links
  --verbose           List passing checks with their evidence too
  --interview         Run interactive 7-question Org & Workflow interview
  --role <role>       Role for interview & guidance: dev | lead | cto (default: dev)
  --deep              Run optional LLM qualitative pass (uses local claude/codex CLI or API key)
  --prompt            Generate a tailored HARNESS-FIX-PROMPT.md for your coding agent
  --version, -v       Print version
  --help, -h          Print help

Init subcommand options:
  harness-audit init [path]
  --dry-run           Print the files init would write, with their content, without writing
  --force             Overwrite existing files (never overwrites without --force)
  --tools <list>      Comma-separated: claude-code,cursor,codex (default: all)
  --lang <lang>       Language: en | pl (default: en)

Examples:
  npx harness-audit
  npx harness-audit ./my-app --format html --out audit.html
  npx harness-audit --ci --min-score 70 --format json
  npx harness-audit --prompt --out HARNESS-FIX-PROMPT.md
  npx harness-audit init --dry-run --tools claude-code,cursor
`,
    pl: `Użycie:
  harness-audit [ścieżka] [opcje]
  harness-audit init [ścieżka] [opcje]

Przeprowadza audyt uprzęży agentów kodujących (AI coding harness) w repozytorium
w ramach 6 Stacji Fabryki Oprogramowania (Intencja, Uprząż, Pętla, Graf,
Weryfikacja, Wydanie) i wyznacza Poziom Autonomii (Poziom 0–5).

Opcje audytu:
  --format <fmt>      Format wyjścia: terminal | md | html | json (domyślnie: terminal)
  --out <plik>        Zapisz raport do pliku zamiast na stdout
  --lang <język>      Język raportu: en | pl (domyślnie: en)
  --ci                Tryb CI: ukrywa dekoracyjne banery i stopkę z poleceniami
  --min-score <N>     Kod wyjścia 1, jeśli wynik ogólny < N (0–100)
  --no-promo          Ukrywa sekcję książek i usług dla zespołów
  --verbose           Pokazuje też zaliczone checki wraz z dowodami
  --interview         Uruchamia interaktywny wywiad (7 pytań o proces i organizację)
  --role <rola>       Rola do wywiadu i rekomendacji: dev | lead | cto (domyślnie: dev)
  --deep              Opcjonalna analiza jakościowa LLM (lokalne CLI claude/codex lub klucz API)
  --prompt            Generuje dopasowany HARNESS-FIX-PROMPT.md dla Twojego agenta
  --version, -v       Wyświetla wersję
  --help, -h          Wyświetla pomoc

Opcje podkomendy init:
  harness-audit init [ścieżka]
  --dry-run           Wypisuje pliki, które init by utworzył, wraz z treścią, bez zapisu
  --force             Nadpisz istniejące pliki (domyślnie nigdy nie nadpisuje)
  --tools <lista>     Lista narzędzi: claude-code,cursor,codex (domyślnie: wszystkie)
  --lang <język>      Język: en | pl (domyślnie: en)

Przykłady:
  npx harness-audit --lang pl
  npx harness-audit ./projekt --format html --out audyt.html --lang pl
  npx harness-audit --ci --min-score 70 --format json
  npx harness-audit --prompt --out HARNESS-FIX-PROMPT.md
  npx harness-audit init --dry-run --tools claude-code,cursor
`,
  },
} as const;

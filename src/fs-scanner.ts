import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { describeCommand, detectVerifyCapabilities, type VerifyCapabilities } from './capabilities.js';
import { readBrief, type BriefFacts } from './brief.js';
import { analyzeCi, type CiFacts } from './ci.js';
import type { GitStats, ScanInfo, StackInfo, SupportedTool } from './types.js';

/**
 * Directories that never hold first-party source, whatever git says about them. Applied to both
 * scan modes: a vendored or committed dependency tree must not inflate source and test counts.
 */
const VENDORED_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'third_party',
  'Pods',
  'Carthage',
  '__pycache__',
  '.venv',
  'venv',
  'docs-backup',
  'ebooks-dist',
]);

/**
 * Build output, caches and tool state. Only the filesystem walk needs these: in a git repository
 * `.gitignore` already says what is generated, and a tracked `build/` or `dist/` is deliberate.
 */
const GENERATED_DIRS = new Set([
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.astro',
  '.svelte-kit',
  '.vercel',
  '.wrangler',
  '.open-next',
  '.output',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.expo',
  '.dart_tool',
  'coverage',
  '.nyc_output',
  'target',
  'env',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'DerivedData',
  '.build',
  '.swiftpm',
  'xcuserdata',
  '.gradle',
  '.idea',
  '.terraform',
  'obj',
  'playwright-report',
  'test-results',
]);

function isIgnoredDir(name: string, rel: string, mode: ScanInfo['mode']): boolean {
  if (VENDORED_DIRS.has(name)) return true;
  if (mode === 'git') return false;
  return (
    GENERATED_DIRS.has(name) ||
    /^\.?deriveddata/i.test(name) ||
    rel === '.claude/worktrees' ||
    rel === 'bin/Debug' ||
    rel === 'bin/Release'
  );
}

function pathIsVendored(rel: string): boolean {
  const parts = rel.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (VENDORED_DIRS.has(parts[i]!)) return true;
  }
  return false;
}

/**
 * git's own location variables, set when the audit runs from a git hook, would point every git call
 * at the hook's repository instead of the audited one. They are dropped; the rest is kept.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete env[key];
  return env;
}
const GIT_ENV = gitEnv();

const MAX_SCAN_FILES = 60_000;
const MAX_READ_BYTES = 512 * 1024; // 512 KiB per file safety bound

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.astro',
  '.vue',
  '.svelte',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.m',
  '.mm',
  '.dart',
  '.scala',
  '.ex',
  '.exs',
  '.cpp',
  '.cc',
  '.c',
  '.h',
  '.hpp',
]);

/** App-router entry files: a route folder called `test` is production code, not a test. */
const ROUTE_ENTRY_NAME = /^(route|page|layout|loading|error|not-found|template|default)\.(ts|tsx|js|jsx)$/;

export function isTestFilePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  const name = basename(normalized);
  if (
    /\.(test|spec|e2e)\.(ts|tsx|js|jsx|mjs|cjs|py|rb|php|cs|swift|dart)$/.test(name) ||
    /_test\.(go|py|rs|rb|dart|exs|c|cc|cpp)$/.test(name) ||
    /^test_.*\.(py|rb|sh)$/.test(name) ||
    /tests?\.(java|kt|cs|swift|scala|php|m|mm)$/.test(name) ||
    /spec\.(rb|scala|swift)$/.test(name) ||
    /\.node-check\.m?js$/.test(name)
  ) {
    return true;
  }
  if (
    (/(^|\/)(__tests__|tests|test|spec|specs|e2e|androidtest)\//.test(normalized) ||
      /(^|\/)[^/]*(tests|uitests)\/[^/]*\.swift$/.test(normalized)) &&
    SOURCE_EXTENSIONS.has(extname(normalized)) &&
    !name.endsWith('.d.ts') &&
    !ROUTE_ENTRY_NAME.test(name) &&
    !/^(setup|helpers?|utils?|fixtures?|mocks?|factories?|conftest|index|preload)[.-]/.test(name) &&
    // Support code that lives beside the tests: preloads, fixtures, helpers, mocks.
    !/(^|\/)(preload|setup|fixtures?|helpers?|mocks?|__mocks__|support|testdata|utils?)\//.test(normalized)
  ) {
    return true;
  }
  return false;
}

export function isSourceFilePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  const ext = extname(normalized);
  if (!SOURCE_EXTENSIONS.has(ext)) return false;
  if (normalized.endsWith('.d.ts')) return false;
  if (isTestFilePath(normalized)) return false;
  if (
    normalized.startsWith('.') ||
    /(^|\/)(node_modules|dist|build|public|assets|static|migrations)\//.test(normalized)
  ) {
    return false;
  }
  const name = basename(normalized);
  if (/^(vite|vitest|astro|tailwind|postcss|playwright|jest|eslint|next|nuxt|svelte|webpack|rollup|babel|tsup)\.config\./.test(name)) {
    return false;
  }
  // Build manifests written in the project's own language.
  if (name === 'package.swift' || /\.gradle\.kts$/.test(name) || name === 'setup.py') {
    return false;
  }
  return true;
}

export interface PackageJsonShape {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  engines?: Record<string, string>;
  packageManager?: string;
}

interface FileListing {
  files: string[];
  /** Paths git tracks; undefined when the directory is not a git work tree. */
  tracked?: Set<string>;
  mode: ScanInfo['mode'];
  truncated: boolean;
}

function depthOf(rel: string): number {
  let depth = 0;
  for (let i = 0; i < rel.length; i++) if (rel.charCodeAt(i) === 47) depth++;
  return depth;
}

/** Shallow paths first, so a cap never drops the root manifests and agent config. */
function capFiles(files: string[]): { files: string[]; truncated: boolean } {
  if (files.length <= MAX_SCAN_FILES) return { files, truncated: false };
  const sorted = [...files].sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0));
  return { files: sorted.slice(0, MAX_SCAN_FILES), truncated: true };
}

/**
 * The files git would show a teammate or a CI runner: tracked files plus untracked files that
 * `.gitignore` does not exclude. Ignored build output, local env files and nested worktrees are
 * not part of the versioned harness, so they are not part of the audit.
 */
function listGitFiles(root: string): FileListing | null {
  const git = (args: string[]): string[] =>
    execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z', ...args], {
      cwd: root, env: GIT_ENV,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    })
      .split('\0')
      .filter((p) => p.length > 0);

  try {
    const trackedAll = git(['--cached']);
    if (trackedAll.length === 0) {
      // Nothing tracked. At the top of its own repository this is a fresh `git init`, and git's
      // ignore rules still say what a teammate would get. A directory that merely sits inside
      // someone else's work tree is walked as it is.
      const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], { cwd: root, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
      if (prefix !== '') return null;
    }
    const deleted = new Set(git(['--deleted']));
    const tracked = trackedAll.filter((p) => !deleted.has(p) && !pathIsVendored(p));
    // An untracked nested repository or worktree is listed as "dir/": not this repo's files.
    const untracked = git(['--others', '--exclude-standard']).filter(
      (p) => !p.endsWith('/') && !pathIsVendored(p),
    );
    const capped = capFiles([...new Set([...tracked, ...untracked])]);
    return { files: capped.files, tracked: new Set(tracked), mode: 'git', truncated: capped.truncated };
  } catch {
    return null;
  }
}

function walkFiles(root: string): FileListing {
  const collected: string[] = [];
  let truncated = false;
  // Breadth-first: when a huge tree hits the cap, the root manifests and agent config are already in.
  const queue: string[] = [root];

  while (queue.length > 0 && !truncated) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (collected.length >= MAX_SCAN_FILES) {
        truncated = true;
        break;
      }
      const fullPath = join(dir, entry.name);
      const rel = relative(root, fullPath).replace(/\\/g, '/');

      if (entry.isSymbolicLink()) {
        // A symlinked file counts (CLAUDE.md -> AGENTS.md); a symlinked directory is not followed.
        try {
          if (statSync(fullPath).isFile()) collected.push(rel);
        } catch {
          // broken symlink
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name, rel, 'walk')) queue.push(fullPath);
      } else if (entry.isFile()) {
        collected.push(rel);
      }
    }
  }

  return { files: collected, mode: 'walk', truncated };
}

export class RepoContext {
  readonly root: string;
  readonly repoName: string;
  readonly files: string[]; // POSIX-normalized relative paths
  readonly fileSet: Set<string>;
  readonly sourceFiles: string[];
  readonly testFiles: string[];
  readonly scan: ScanInfo;

  private readonly trackedSet: Set<string> | undefined;
  private readonly textCache = new Map<string, string | null>();
  private pkgCache: PackageJsonShape | null | undefined = undefined;
  private stackCache: StackInfo | undefined = undefined;
  private gitCache: GitStats | undefined = undefined;
  private verifyCache: VerifyCapabilities | undefined = undefined;
  private ciCache: CiFacts | undefined = undefined;
  private briefCache: BriefFacts | undefined = undefined;
  private workspaceCache: Array<{ path: string; manifest: PackageJsonShape }> | undefined = undefined;
  private suiteCache: string[] | undefined = undefined;

  constructor(repoPath: string) {
    this.root = resolve(repoPath);
    if (!existsSync(this.root)) {
      throw new Error(`Repository path does not exist: ${this.root}`);
    }
    if (!statSync(this.root).isDirectory()) {
      throw new Error(`Repository path is not a directory: ${this.root}`);
    }
    this.repoName = basename(this.root);

    const listing = listGitFiles(this.root) ?? walkFiles(this.root);
    this.files = listing.files;
    this.fileSet = new Set(listing.files);
    this.trackedSet = listing.tracked;
    this.scan = { mode: listing.mode, fileCount: listing.files.length, truncated: listing.truncated };
    this.testFiles = listing.files.filter(isTestFilePath);
    this.sourceFiles = listing.files.filter(isSourceFilePath);
  }

  /**
   * Whether git tracks the file. `undefined` outside a git work tree, where nothing is known.
   */
  isTracked(relPath: string): boolean | undefined {
    return this.trackedSet?.has(cleanRel(relPath));
  }

  /**
   * A file that is on disk but that git ignores: the person running the audit has it, a teammate
   * or a CI agent does not. Always false outside a git work tree.
   */
  isLocalOnly(relPath: string): boolean {
    if (this.scan.mode !== 'git') return false;
    const clean = cleanRel(relPath);
    // A tracked file that the scan cap left out is still part of the repository.
    return !this.fileSet.has(clean) && this.trackedSet?.has(clean) !== true && existsSync(join(this.root, clean));
  }

  /**
   * For a symlink that points at another file inside the repository, that file's relative path.
   */
  linkTarget(relPath: string): string | undefined {
    const full = join(this.root, cleanRel(relPath));
    try {
      if (!lstatSync(full).isSymbolicLink()) return undefined;
      const target = resolve(dirname(full), readlinkSync(full));
      const rel = relative(realpathSync(this.root), realpathSync(target)).replace(/\\/g, '/');
      return rel.startsWith('..') ? undefined : rel;
    } catch {
      return undefined;
    }
  }

  hasFile(relPath: string): boolean {
    return this.fileSet.has(cleanRel(relPath));
  }

  hasAnyFile(relPaths: string[]): string | undefined {
    for (const p of relPaths) {
      if (this.hasFile(p)) return p;
    }
    return undefined;
  }

  findFiles(predicate: (relPath: string) => boolean): string[] {
    return this.files.filter(predicate);
  }

  /**
   * Text of a scanned file, following a symlink to its target. `null` for a file outside the scan
   * (ignored by git, vendored), a missing file, or one above the size bound.
   */
  private realRoot: string | undefined;

  /**
   * The file's real path when it lies inside the repository. A symlink that leads out of the tree
   * (`CLAUDE.md -> ~/notes.md`, `node_modules/x -> /etc`) is not followed: the audit quotes what it
   * reads, and a repository must not be able to make it quote someone's home directory.
   */
  private contained(full: string): string | null {
    try {
      this.realRoot ??= realpathSync(this.root);
      const real = realpathSync(full);
      const rel = relative(this.realRoot, real);
      return rel.startsWith('..') || isAbsolute(rel) ? null : real;
    } catch {
      return null;
    }
  }

  readText(relPath: string): string | null {
    const clean = cleanRel(relPath);
    const cached = this.textCache.get(clean);
    if (cached !== undefined) return cached;

    let content: string | null = null;
    if (this.fileSet.has(clean)) {
      try {
        const full = this.contained(join(this.root, clean));
        const stat = full ? statSync(full) : undefined;
        if (full && stat?.isFile() && stat.size <= MAX_READ_BYTES) {
          content = readFileSync(full, 'utf8');
        }
      } catch {
        content = null;
      }
    }
    this.textCache.set(clean, content);
    return content;
  }

  readJson<T = unknown>(relPath: string): T | null {
    const raw = this.readText(relPath);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Try stripping JSONC comments & trailing commas safely (e.g. tsconfig.json)
      try {
        const stripped = stripJsonComments(raw);
        return JSON.parse(stripped) as T;
      } catch {
        return null;
      }
    }
  }

  get packageJson(): PackageJsonShape | null {
    if (this.pkgCache !== undefined) return this.pkgCache;
    this.pkgCache = this.readJson<PackageJsonShape>('package.json');
    return this.pkgCache;
  }

  /**
   * package.json files of workspace members (apps/*, packages/*, …), where a monorepo keeps its
   * frameworks, test runners and dev servers. Example, template and fixture packages are not members.
   */
  get workspaceManifests(): Array<{ path: string; manifest: PackageJsonShape }> {
    if (this.workspaceCache) return this.workspaceCache;
    this.workspaceCache = this.files
      .filter(
        (f) =>
          /^(?:[^/]+\/){1,3}package\.json$/.test(f) &&
          !/(^|\/)(examples?|templates?|fixtures?|tests?|__tests__|e2e|docs?|scripts?|vendor)\//.test(f),
      )
      .slice(0, 40)
      .map((path) => ({ path, manifest: this.readJson<PackageJsonShape>(path) }))
      .filter((m): m is { path: string; manifest: PackageJsonShape } => m.manifest !== null);
    return this.workspaceCache;
  }

  /** A dependency of the root package or of any workspace member. */
  hasDependency(name: string): boolean {
    const declares = (pkg: PackageJsonShape | null): boolean => Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);
    return declares(this.packageJson) || this.workspaceManifests.some((m) => declares(m.manifest));
  }

  hasAnyDependency(names: string[]): string | undefined {
    for (const n of names) {
      if (this.hasDependency(n)) return n;
    }
    return undefined;
  }

  get stack(): StackInfo {
    if (this.stackCache) return this.stackCache;
    this.stackCache = detectStack(this);
    return this.stackCache;
  }

  get git(): GitStats {
    if (this.gitCache) return this.gitCache;
    this.gitCache = detectGitStats(this.root);
    return this.gitCache;
  }

  /** The verify commands the repository offers and the ones its brief documents. */
  get verify(): VerifyCapabilities {
    if (this.verifyCache) return this.verifyCache;
    this.verifyCache = detectVerifyCapabilities(this);
    return this.verifyCache;
  }

  /** What the CI configuration runs, and what of it gates a pull request. */
  get ci(): CiFacts {
    if (this.ciCache) return this.ciCache;
    this.ciCache = analyzeCi(this);
    return this.ciCache;
  }

  /**
   * Which of the given paths git would ignore if they existed. In a git work tree this asks git
   * (nested rules, negations and the user's global excludes included); elsewhere it reads the
   * root `.gitignore` with a plain pattern match.
   */
  ignoredPaths(candidates: string[]): Set<string> {
    if (this.scan.mode === 'git') {
      try {
        const out = execFileSync('git', ['check-ignore', '--no-index', '--', ...candidates], {
          cwd: this.root, env: GIT_ENV,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
        });
        return new Set(out.split('\n').filter(Boolean));
      } catch (err) {
        // Exit status 1: none of the paths is ignored.
        if ((err as { status?: number }).status === 1) return new Set();
      }
    }
    const patterns = (this.readText('.gitignore') ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
    return new Set(candidates.filter((candidate) => patterns.some((p) => gitignorePatternMatches(p, candidate))));
  }

  /**
   * The test suite as the repository runs it: files named like tests, plus programs a `test*`
   * package script runs directly whose path says fixture, test, spec or e2e. A compile step or a
   * server bootstrap chained in front of the runner is not a test.
   */
  get suiteFiles(): string[] {
    if (this.suiteCache) return this.suiteCache;
    const scripts = this.packageJson?.scripts ?? {};
    const targets = new Set<string>();
    for (const [name, body] of Object.entries(scripts)) {
      if (!/^test([:._-]|$)/.test(name)) continue;
      for (const segment of body.split(/&&|;|\|\|/)) {
        const m = /^\s*(?:bun|node|tsx|deno run|python3?|npx tsx)\s+(?:run\s+)?((?:\.\/)?[\w./-]+\.(?:ts|tsx|js|mjs|cjs|py))\b/.exec(segment);
        const path = m?.[1]?.replace(/^\.\//, '');
        if (path && /(fixture|test|spec|e2e)/i.test(path) && this.hasFile(path) && !this.testFiles.includes(path)) targets.add(path);
      }
    }
    this.suiteCache = [...this.testFiles, ...targets];
    return this.suiteCache;
  }

  /** What the root AGENTS.md / CLAUDE.md say. */
  get brief(): BriefFacts {
    if (this.briefCache) return this.briefCache;
    this.briefCache = readBrief(this);
    return this.briefCache;
  }

  /**
   * How many people work here: `solo` (one human in 90 days, nobody to be a second reviewer),
   * `inactive` (no commits in 90 days), `team`, or `unknown` outside a git work tree.
   */
  get team(): 'solo' | 'inactive' | 'team' | 'unknown' {
    if (!this.git.isGitRepo) return 'unknown';
    if (this.git.gitAuthors90d === 0) return 'inactive';
    return this.git.gitAuthors90d === 1 ? 'solo' : 'team';
  }

  /**
   * No second human to review, so advice that needs a reviewer does not apply. A repository with
   * no recent commits is judged by who ever worked on it: a quiet fork of a 30-author project is
   * not a solo project.
   */
  get isSolo(): boolean {
    if (this.team === 'inactive') return this.git.authorsAllTime <= 1;
    return this.team === 'solo';
  }

  /** "One active contributor" / "No commits in the last 90 days (12 authors in the history)". */
  get teamLabel(): string {
    if (this.team === 'inactive') {
      // Commits by agents and bots only are activity, just not a second person.
      if (this.git.commits90d > 0) return `${this.git.commits90d} commit(s) in the last 90 days, none by a human author (agents or bots only)`;
      return `No commits in the last 90 days (${this.git.authorsAllTime} author${this.git.authorsAllTime === 1 ? '' : 's'} in the history)`;
    }
    return this.team === 'solo' ? 'One active contributor' : `${this.git.gitAuthors90d} active contributors`;
  }

  /**
   * Text of a file under the repository root that the scan leaves out on purpose, such as a
   * tsconfig preset inside `node_modules`. For resolving references only, never for findings.
   */
  readUnscannedText(relPath: string): string | null {
    const lexical = resolve(this.root, relPath);
    if (relative(this.root, lexical).startsWith('..')) return null;
    const full = this.contained(lexical);
    if (!full) return null;
    try {
      const stat = statSync(full);
      return stat.isFile() && stat.size <= MAX_READ_BYTES ? readFileSync(full, 'utf8') : null;
    } catch {
      return null;
    }
  }
}

/** A plain reading of one `.gitignore` line: enough for `.env`, `.env*`, `*.pem`, `dir/`. */
function gitignorePatternMatches(pattern: string, candidate: string): boolean {
  const body = pattern.replace(/^\//, '').replace(/\/$/, '');
  const source = body
    .split('*')
    .map((piece) => piece.replace(/[.+^$()|[\]{}?\\]/g, (ch) => `\\${ch}`))
    .join('[^/]*');
  const rx = new RegExp(`^${source}(?:/.*)?$`);
  return rx.test(candidate) || rx.test(candidate.split('/').pop()!);
}

function cleanRel(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Remove trailing commas before } or ]
  return out.replace(/,\s*([}\]])/g, '$1');
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.py': 'Python',
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.jsx': 'JavaScript',
  '.cjs': 'JavaScript',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.c': 'C/C++',
  '.cpp': 'C/C++',
  '.dart': 'Dart',
  '.ex': 'Elixir',
  '.scala': 'Scala',
};

function detectStack(ctx: RepoContext): StackInfo {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const packageManagers = new Set<string>();
  const verifyScripts: string[] = [];
  const detectedTools = new Set<SupportedTool>();

  const pkg = ctx.packageJson ?? (ctx.workspaceManifests.length > 0 ? {} : null);
  if (pkg) {
    // By what the files are, not only by the root manifest: a workspace keeps tsconfig and the
    // typescript dependency in its packages.
    const tsFiles = ctx.sourceFiles.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f)).length;
    const jsFiles = ctx.sourceFiles.filter((f) => /\.(js|jsx|mjs|cjs)$/.test(f)).length;
    // A handful of `.ts` files and no JavaScript is TypeScript too, tsconfig or not.
    const isTs = ctx.hasFile('tsconfig.json') || ctx.hasDependency('typescript') || (tsFiles >= 5 && tsFiles >= jsFiles * 0.25) || (tsFiles > 0 && jsFiles === 0);
    if (isTs) languages.add('TypeScript');
    if (!isTs || (jsFiles >= 20 && jsFiles >= tsFiles * 0.3)) languages.add('JavaScript');

    if (ctx.hasFile('bun.lock') || ctx.hasFile('bun.lockb') || pkg.packageManager?.startsWith('bun')) {
      packageManagers.add('bun');
    }
    if (ctx.hasFile('pnpm-lock.yaml') || pkg.packageManager?.startsWith('pnpm')) {
      packageManagers.add('pnpm');
    }
    if (ctx.hasFile('yarn.lock') || pkg.packageManager?.startsWith('yarn')) {
      packageManagers.add('yarn');
    }
    if (ctx.hasFile('package-lock.json') || pkg.packageManager?.startsWith('npm')) {
      packageManagers.add('npm');
    }
    if (ctx.hasDependency('vite-plus')) {
      packageManagers.add('vp');
    }
    if (packageManagers.size === 0) {
      packageManagers.add('npm');
    }

    // Frameworks
    const fwMap: Array<[string, string]> = [
      ['next', 'Next.js'],
      ['astro', 'Astro'],
      ['@astrojs/starlight', 'Starlight'],
      ['react', 'React'],
      ['vue', 'Vue'],
      ['nuxt', 'Nuxt'],
      ['svelte', 'Svelte'],
      ['@sveltejs/kit', 'SvelteKit'],
      ['express', 'Express'],
      ['fastify', 'Fastify'],
      ['hono', 'Hono'],
      ['@nestjs/core', 'NestJS'],
      ['expo', 'Expo'],
      ['wrangler', 'Cloudflare Workers'],
      ['tailwindcss', 'Tailwind CSS'],
      ['drizzle-orm', 'Drizzle'],
      ['prisma', 'Prisma'],
    ];
    for (const [dep, label] of fwMap) {
      // hasDependency reads the workspace members too: a monorepo's frameworks live in apps/*.
      if (ctx.hasDependency(dep)) frameworks.add(label);
    }


    const scripts = pkg.scripts ?? {};
    const verifyKeys = ['check', 'verify', 'ci', 'test', 'lint', 'typecheck', 'type-check', 'build', 'fmt:check', 'format:check'];
    for (const key of verifyKeys) {
      if (scripts[key]) verifyScripts.push(key);
    }
  }

  // Python
  const hasPyManifest =
    ctx.hasFile('pyproject.toml') || ctx.hasFile('requirements.txt') || ctx.hasFile('setup.py');
  const pyFileCount = ctx.sourceFiles.filter((f) => f.endsWith('.py')).length;
  if (hasPyManifest || pyFileCount >= 5) {
    languages.add('Python');
    const pyproject = ctx.readText('pyproject.toml') ?? '';
    if (ctx.hasFile('uv.lock') || /\[tool\.uv\]/.test(pyproject)) packageManagers.add('uv');
    else if (ctx.hasFile('poetry.lock') || /\[tool\.poetry\]/.test(pyproject)) packageManagers.add('poetry');
    else if (ctx.hasFile('Pipfile.lock')) packageManagers.add('pipenv');
    else if (hasPyManifest) packageManagers.add('pip');

    if (/fastapi/i.test(pyproject)) frameworks.add('FastAPI');
    if (/django/i.test(pyproject)) frameworks.add('Django');
    if (/flask/i.test(pyproject)) frameworks.add('Flask');
  }

  // Go
  if (ctx.hasFile('go.mod') || ctx.sourceFiles.some((f) => f.endsWith('.go'))) {
    languages.add('Go');
    packageManagers.add('go');
  }

  // Rust
  if (ctx.hasFile('Cargo.toml') || ctx.sourceFiles.some((f) => f.endsWith('.rs'))) {
    languages.add('Rust');
    packageManagers.add('cargo');
  }

  // Java / Kotlin
  if (ctx.hasFile('pom.xml')) {
    languages.add('Java');
    packageManagers.add('maven');
  }
  if (ctx.hasAnyFile(['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])) {
    const kotlin = ctx.sourceFiles.filter((f) => f.endsWith('.kt')).length;
    const java = ctx.sourceFiles.filter((f) => f.endsWith('.java')).length;
    if (kotlin > 0 || java === 0) languages.add('Kotlin');
    if (java > 0) languages.add('Java');
    packageManagers.add('gradle');
    const gradleText = ['build.gradle', 'build.gradle.kts', 'app/build.gradle', 'app/build.gradle.kts', 'gradle/libs.versions.toml']
      .map((f) => ctx.readText(f) ?? '')
      .join('\n');
    if (/com\.android\.|android\s*\{|\bagp\b/.test(gradleText)) frameworks.add('Android');
    if (/compose/i.test(gradleText)) frameworks.add('Jetpack Compose');
    if (/spring-boot|org\.springframework/.test(gradleText)) frameworks.add('Spring Boot');
  }

  // Swift / Xcode
  const xcodeProject = ctx.findFiles((f) => /(^|\/)[^/]+\.xcodeproj\/project\.pbxproj$/.test(f))[0];
  const swiftFileCount = ctx.files.filter((f) => f.endsWith('.swift')).length;
  if (ctx.hasFile('Package.swift') || xcodeProject || (ctx.hasFile('project.yml') && swiftFileCount > 0)) {
    languages.add('Swift');
    if (ctx.hasFile('Package.swift')) packageManagers.add('swiftpm');
    if (xcodeProject || ctx.hasFile('project.yml')) packageManagers.add('xcodebuild');
    if (ctx.hasFile('project.yml')) frameworks.add('XcodeGen');
    const swiftSample = ctx.sourceFiles.filter((f) => f.endsWith('.swift')).slice(0, 40);
    if (swiftSample.some((f) => /^import SwiftUI\b/m.test(ctx.readText(f) ?? ''))) frameworks.add('SwiftUI');
  }

  // Dart / Flutter
  if (ctx.hasFile('pubspec.yaml')) {
    languages.add('Dart');
    packageManagers.add('pub');
    if (/^\s*flutter\s*:/m.test(ctx.readText('pubspec.yaml') ?? '')) frameworks.add('Flutter');
  }

  // Elixir
  if (ctx.hasFile('mix.exs')) {
    languages.add('Elixir');
    packageManagers.add('mix');
    if (/:phoenix\b/.test(ctx.readText('mix.exs') ?? '')) frameworks.add('Phoenix');
  }

  // C / C++
  const cFamily = ctx.sourceFiles.filter((f) => /\.(c|cc|cpp|h|hpp)$/.test(f)).length;
  if (ctx.hasFile('CMakeLists.txt') || (cFamily >= 3 && languages.size === 0)) {
    languages.add('C/C++');
    packageManagers.add(ctx.hasFile('CMakeLists.txt') ? 'cmake' : 'make');
  }

  // Ruby
  if (ctx.hasFile('Gemfile')) {
    languages.add('Ruby');
    packageManagers.add('bundler');
    const gemfile = ctx.readText('Gemfile') ?? '';
    if (/rails/i.test(gemfile)) frameworks.add('Rails');
  }

  // PHP
  if (ctx.hasFile('composer.json')) {
    languages.add('PHP');
    packageManagers.add('composer');
    const composer = ctx.readText('composer.json') ?? '';
    if (/laravel/i.test(composer)) frameworks.add('Laravel');
  }

  // .NET / C#
  if (ctx.findFiles((f) => f.endsWith('.csproj') || f.endsWith('.sln')).length > 0) {
    languages.add('C#');
    packageManagers.add('dotnet');
  }

  // Makefile / justfile targets
  const makefile = ctx.readText('Makefile');
  if (makefile) {
    for (const target of ['check', 'verify', 'test', 'lint', 'typecheck', 'build']) {
      if (new RegExp(`^${target}:`, 'm').test(makefile) && !verifyScripts.includes(`make ${target}`)) {
        verifyScripts.push(`make ${target}`);
      }
    }
  }
  const justfile = ctx.readText('justfile') ?? ctx.readText('Justfile');
  if (justfile) {
    for (const target of ['check', 'verify', 'test', 'lint', 'typecheck', 'build']) {
      if (new RegExp(`^${target}\\b.*:`, 'm').test(justfile) && !verifyScripts.includes(`just ${target}`)) {
        verifyScripts.push(`just ${target}`);
      }
    }
  }

  // Monorepo detection
  const monorepo = Boolean(
    ctx.hasFile('pnpm-workspace.yaml') ||
      ctx.hasFile('turbo.json') ||
      ctx.hasFile('nx.json') ||
      ctx.hasFile('lerna.json') ||
      ctx.hasFile('go.work') ||
      (pkg?.workspaces &&
        (Array.isArray(pkg.workspaces)
          ? pkg.workspaces.length > 0
          : (pkg.workspaces.packages?.length ?? 0) > 0)) ||
      /\[workspace\]/.test(ctx.readText('Cargo.toml') ?? ''),
  );

  // Detected AI coding tools configured in repo
  if (
    ctx.hasFile('CLAUDE.md') ||
    ctx.hasFile('.claude/settings.json') ||
    ctx.hasFile('.mcp.json') ||
    ctx.findFiles((f) => f.startsWith('.claude/')).length > 0
  ) {
    detectedTools.add('claude-code');
  }
  if (
    ctx.findFiles((f) => f.startsWith('.cursor/')).length > 0 ||
    ctx.hasFile('.cursorrules')
  ) {
    detectedTools.add('cursor');
  }
  if (
    ctx.findFiles((f) => f.startsWith('.codex/')).length > 0 ||
    ctx.hasFile('AGENTS.md') ||
    ctx.hasFile('AGENTS.override.md')
  ) {
    detectedTools.add('codex');
  }

  // A Worker is a Worker by its config, wherever it sits and however wrangler is invoked.
  if (ctx.findFiles((f) => /(^|\/)wrangler\.(toml|jsonc|json)$/.test(f) && f.split('/').length <= 3 && !/(^|\/)(examples?|templates?|fixtures?|tests?|docs?)\//.test(f)).length > 0) {
    frameworks.add('Cloudflare Workers');
  }

  // No manifest matched: name the language the source files are written in.
  if (languages.size === 0) {
    const byExt = new Map<string, number>();
    for (const f of ctx.sourceFiles) byExt.set(extname(f), (byExt.get(extname(f)) ?? 0) + 1);
    const top = [...byExt.entries()].sort((a, b) => b[1] - a[1])[0];
    const label = top && top[1] >= 2 ? LANGUAGE_BY_EXT[top[0]] : undefined;
    if (label) languages.add(label);
  }

  // The language most of the code is written in comes first: advice is worded for it.
  const shareOf = (lang: string): number => {
    const exts = Object.entries(LANGUAGE_BY_EXT).filter(([, l]) => l === lang).map(([e]) => e);
    return ctx.sourceFiles.filter((f) => exts.includes(extname(f))).length;
  };
  const ranked = [...languages].sort((a, b) => shareOf(b) - shareOf(a));

  return {
    languages: ranked,
    frameworks: [...frameworks],
    packageManagers: [...packageManagers],
    monorepo,
    verifyScripts,
    verifyCommands: ctx.verify.commands.slice(0, 8).map(describeCommand),
    detectedTools: [...detectedTools],
    sourceFileCount: ctx.sourceFiles.length,
    testFileCount: ctx.suiteFiles.length,
  };
}

const AUTOMATION_EMAIL = /\[bot\]|noreply@anthropic\.com|@cursor\.com$|^cursoragent@|copilot|devin-ai|github-actions|dependabot|renovate|(^|[-.+_])bot([-.+_]|@)|^action@github\.com$|^codex@|noreply@openai\.com/;
// The whole name, not a prefix: "Claude Martin" is a person.
const AUTOMATION_NAME = /^(claude( code)?|codex|cursor agent|copilot|devin( ai)?|github-actions|dependabot|renovate|semantic-release)$|\[bot\]|(^|[-_ ])bot$/;

function detectGitStats(root: string): GitStats {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root, env: GIT_ENV,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
  } catch {
    return { isGitRepo: false, gitAuthors90d: 0, authorsAllTime: 0, commits30d: 0, commits90d: 0 };
  }

  let branch: string | undefined;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root, env: GIT_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    branch = undefined;
  }

  // People only, one per person: a coding agent or a bot that authors a commit is not a second
  // reviewer, and one person committing under two addresses is still one person.
  const countPeople = (args: string[]): number => {
    try {
      const out = execFileSync('git', ['log', ...args, '--format=%ae%x09%an'], {
        cwd: root, env: GIT_ENV,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        maxBuffer: 32 * 1024 * 1024,
      });
      const byEmail = new Map<string, string>();
      for (const line of out.split('\n')) {
        const [email, name = ''] = line.trim().toLowerCase().split('\t');
        if (!email || AUTOMATION_EMAIL.test(email) || AUTOMATION_NAME.test(name)) continue;
        byEmail.set(email, name || email);
      }
      return new Set(byEmail.values()).size;
    } catch {
      return 0;
    }
  };
  const gitAuthors90d = countPeople(['--since=90 days ago']);
  const authorsAllTime = Math.max(gitAuthors90d, countPeople(['-n', '3000']));

  const count = (args: string[]): number => {
    try {
      return Number.parseInt(execFileSync('git', ['rev-list', '--count', ...args, 'HEAD'], { cwd: root, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim(), 10) || 0;
    } catch {
      return 0;
    }
  };
  const commits90d = count(['--since=90 days ago']);
  // The branch pull requests target: origin's HEAD when a remote is known, else the checked-out branch.
  let defaultBranch: string | undefined;
  try {
    defaultBranch = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim().replace(/^origin\//, '');
  } catch {
    defaultBranch = branch && branch !== 'HEAD' ? branch : undefined;
  }

  // A checkout on another branch that is behind the default one: what ships may hold files this
  // branch lacks (a CI workflow, a brief), and an audit of the checkout would report them missing.
  let behindDefault: number | undefined;
  let defaultBranchOnly: string[] | undefined;
  if (defaultBranch && branch && branch !== 'HEAD' && branch !== defaultBranch) {
    const git = (args: string[]): string => execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    for (const ref of [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`]) {
      try {
        behindDefault = Number.parseInt(git(['rev-list', '--count', `HEAD..${ref}`]).trim(), 10) || 0;
        if (behindDefault > 0) {
          const there = git(['ls-tree', '-r', '--name-only', ref, '--', '.github/workflows', 'AGENTS.md', 'CLAUDE.md', '.claude/settings.json']).split('\n').filter(Boolean);
          defaultBranchOnly = there.filter((f) => !existsSync(join(root, f)));
        }
        break;
      } catch {
        // No such ref (no remote, or the default branch was never fetched): try the local branch.
      }
    }
  }

  let commits30d = 0;
  try {
    const out = execFileSync('git', ['rev-list', '--count', '--since=30 days ago', 'HEAD'], {
      cwd: root, env: GIT_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    commits30d = Number.parseInt(out, 10) || 0;
  } catch {
    commits30d = 0;
  }

  return {
    isGitRepo: true,
    branch,
    gitAuthors90d,
    authorsAllTime,
    commits30d,
    commits90d,
    defaultBranch,
    behindDefault,
    defaultBranchOnly,
  };
}

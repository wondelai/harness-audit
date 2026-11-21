import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import type { GitStats, StackInfo, SupportedTool } from './types.js';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.astro',
  '.svelte-kit',
  '.vercel',
  '.wrangler',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.nyc_output',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'Pods',
  'DerivedData',
  '.gradle',
  'bin/Debug',
  'bin/Release',
  'obj',
  'docs-backup',
  'ebooks-dist',
  'playwright-report',
  'test-results',
]);

const MAX_WALK_FILES = 12_000;
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
  '.cpp',
  '.cc',
  '.c',
  '.h',
]);

export function isTestFilePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  const name = basename(normalized);
  if (
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|rb|php|cs|swift)$/.test(name) ||
    /_test\.(go|py|rs|rb)$/.test(name) ||
    /^test_.*\.(py|rb|sh)$/.test(name) ||
    /test\.(java|kt|cs)$/.test(name) ||
    /spec\.rb$/.test(name) ||
    /\.node-check\.m?js$/.test(name)
  ) {
    return true;
  }
  if (
    /(^|\/)(__tests__|tests|test|spec|e2e)\//.test(normalized) &&
    SOURCE_EXTENSIONS.has(extname(normalized)) &&
    !name.endsWith('.d.ts') &&
    !/^(setup|helpers?|utils?|fixtures?|mocks?|factories?|conftest|index)\./.test(name)
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
  if (
    /^(vite|vitest|astro|tailwind|postcss|playwright|jest|eslint|next|nuxt|svelte|webpack|rollup|babel|tsup)\.config\./.test(
      basename(normalized),
    )
  ) {
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

export class RepoContext {
  readonly root: string;
  readonly repoName: string;
  readonly files: string[]; // POSIX-normalized relative paths
  readonly fileSet: Set<string>;
  readonly sourceFiles: string[];
  readonly testFiles: string[];
  readonly truncated: boolean;

  private readonly textCache = new Map<string, string | null>();
  private pkgCache: PackageJsonShape | null | undefined = undefined;
  private stackCache: StackInfo | undefined = undefined;
  private gitCache: GitStats | undefined = undefined;

  constructor(repoPath: string) {
    this.root = resolve(repoPath);
    if (!existsSync(this.root)) {
      throw new Error(`Repository path does not exist: ${this.root}`);
    }
    this.repoName = basename(this.root);

    const collected: string[] = [];
    let truncated = false;

    const walk = (dir: string): void => {
      if (collected.length >= MAX_WALK_FILES) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (collected.length >= MAX_WALK_FILES) {
          truncated = true;
          return;
        }
        const fullPath = join(dir, entry.name);
        const rel = relative(this.root, fullPath).replace(/\\/g, '/');

        if (entry.isSymbolicLink()) {
          // Do not follow symlinks into loops; record only if it's a file at depth <= 3
          try {
            const st = lstatSync(fullPath);
            if (!st.isDirectory()) {
              collected.push(rel);
            }
          } catch {
            // ignore broken symlink
          }
          continue;
        }

        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name) || IGNORED_DIRS.has(rel)) {
            continue;
          }
          walk(fullPath);
        } else if (entry.isFile()) {
          collected.push(rel);
        }
      }
    };

    walk(this.root);
    this.files = collected;
    this.fileSet = new Set(collected);
    this.truncated = truncated;
    this.testFiles = collected.filter(isTestFilePath);
    this.sourceFiles = collected.filter(isSourceFilePath);
  }

  hasFile(relPath: string): boolean {
    const clean = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    return this.fileSet.has(clean);
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

  readText(relPath: string): string | null {
    const clean = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (this.textCache.has(clean)) {
      return this.textCache.get(clean) ?? null;
    }
    if (!this.fileSet.has(clean)) {
      // Also try direct check in case file was ignored during walk (e.g. .git/config not needed, but hidden files are walked)
      const full = join(this.root, clean);
      if (!existsSync(full)) {
        this.textCache.set(clean, null);
        return null;
      }
    }
    try {
      const full = join(this.root, clean);
      const stat = lstatSync(full);
      if (!stat.isFile() || stat.size > MAX_READ_BYTES) {
        this.textCache.set(clean, null);
        return null;
      }
      const content = readFileSync(full, 'utf8');
      this.textCache.set(clean, content);
      return content;
    } catch {
      this.textCache.set(clean, null);
      return null;
    }
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

  hasDependency(name: string): boolean {
    const pkg = this.packageJson;
    if (!pkg) return false;
    return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
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

function detectStack(ctx: RepoContext): StackInfo {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const packageManagers = new Set<string>();
  const verifyScripts: string[] = [];
  const detectedTools = new Set<SupportedTool>();

  const pkg = ctx.packageJson;
  if (pkg) {
    if (ctx.hasFile('tsconfig.json') || ctx.hasDependency('typescript')) {
      languages.add('TypeScript');
    } else {
      languages.add('JavaScript');
    }

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
  if (ctx.hasFile('build.gradle') || ctx.hasFile('build.gradle.kts')) {
    languages.add(ctx.hasFile('build.gradle.kts') ? 'Kotlin' : 'Java');
    packageManagers.add('gradle');
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

  return {
    languages: [...languages],
    frameworks: [...frameworks],
    packageManagers: [...packageManagers],
    monorepo,
    verifyScripts,
    detectedTools: [...detectedTools],
    sourceFileCount: ctx.sourceFiles.length,
    testFileCount: ctx.testFiles.length,
  };
}

function detectGitStats(root: string): GitStats {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
  } catch {
    return { isGitRepo: false, gitAuthors90d: 0, commits30d: 0 };
  }

  let branch: string | undefined;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    branch = undefined;
  }

  let gitAuthors90d = 0;
  try {
    const out = execFileSync(
      'git',
      ['log', '--since=90 days ago', '--format=%ae', '--no-merges'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 4000,
      },
    );
    const authors = new Set(
      out
        .split('\n')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0 && !s.includes('[bot]')),
    );
    gitAuthors90d = authors.size;
  } catch {
    gitAuthors90d = 0;
  }

  let commits30d = 0;
  try {
    const out = execFileSync('git', ['rev-list', '--count', '--since=30 days ago', 'HEAD'], {
      cwd: root,
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
    commits30d,
  };
}

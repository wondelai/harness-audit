import type { RepoContext } from './fs-scanner.js';

/** What a command proves when it exits 0. */
export type VerifyKind = 'test' | 'lint' | 'typecheck' | 'build' | 'format';

export interface VerifyCommand {
  /** Runnable from the repository root. */
  command: string;
  kinds: VerifyKind[];
  /** Where the command was found: `package.json`, `Makefile`, `AGENTS.md`, a build tool. */
  source: string;
}

export interface VerifyCapabilities {
  /** Every verify command the repository offers, most general first. */
  commands: VerifyCommand[];
  /** Commands quoted in the root agent instructions (AGENTS.md / CLAUDE.md). */
  documented: VerifyCommand[];
  kinds: Set<VerifyKind>;
  /** One command that runs the tests and at least one static check. */
  unified: VerifyCommand | undefined;
}

type Scripts = Record<string, string>;

/** Wrappers that run another program: the program is what counts, the wrapper is dropped. */
const ONE_WORD_WRAPPERS = new Set(['npx', 'bunx', 'pnpx', 'time', 'sudo', 'command', 'exec', 'nice', 'xvfb-run', 'cross-env', 'dotenv', 'env']);
const TWO_WORD_WRAPPERS = new Set([
  'pnpm exec', 'pnpm dlx', 'yarn exec', 'yarn dlx', 'bun x', 'uv run', 'poetry run', 'pipenv run', 'bundle exec',
  'python -m', 'python3 -m', 'mise exec', 'doppler run', 'npm exec',
]);

/** The program a command line runs and its arguments, with env assignments and wrappers removed. */
function programOf(command: string): { program: string; args: string[] } | undefined {
  let tokens = command.trim().split(/\s+/).filter(Boolean);
  for (let guard = 0; guard < 6 && tokens.length > 0; guard++) {
    const first = tokens[0]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || first === '--') {
      tokens = tokens.slice(1);
    } else if (tokens.length > 1 && TWO_WORD_WRAPPERS.has(`${first} ${tokens[1]}`)) {
      tokens = tokens.slice(2);
    } else if (ONE_WORD_WRAPPERS.has(first)) {
      tokens = tokens.slice(1);
      // npx -y, npx --yes, npx -p pkg
      while (tokens.length > 0 && tokens[0]!.startsWith('-') && tokens[0] !== '--') {
        tokens = tokens.slice(tokens[0] === '-p' || tokens[0] === '--package' ? 2 : 1);
      }
    } else {
      break;
    }
  }
  if (tokens.length === 0) return undefined;
  const program = tokens[0]!.replace(/^.*\//, '').replace(/\.(bat|cmd|exe)$/, '').replace(/@[\w.^~-]+$/, '');
  return { program, args: tokens.slice(1) };
}

const TEST_RUNNERS = new Set(['vitest', 'jest', 'mocha', 'ava', 'playwright', 'cypress', 'pytest', 'tox', 'nox', 'rspec', 'phpunit', 'pest', 'ctest', 'karma', 'unittest']);
const LINTERS = new Set(['eslint', 'oxlint', 'flake8', 'pylint', 'golangci-lint', 'rubocop', 'swiftlint', 'ktlint', 'detekt', 'shellcheck', 'stylelint', 'actionlint', 'phpcs', 'phpstan', 'psalm', 'clang-tidy', 'cppcheck', 'staticcheck', 'knip']);
const TYPECHECKERS = new Set(['tsgo', 'vue-tsc', 'svelte-check', 'mypy', 'pyright', 'basedpyright', 'steep']);
const FORMATTERS = new Set(['prettier', 'dprint', 'oxfmt', 'black', 'gofmt', 'goimports', 'swiftformat', 'rustfmt']);
const BUNDLERS = new Set(['vite', 'next', 'astro', 'nuxt', 'webpack', 'rollup', 'esbuild', 'tsup', 'tsdown', 'remix', 'react-router', 'expo', 'docusaurus']);

/**
 * What one program invocation proves, decided by the program and its subcommand. An argument that
 * merely names a tool (`oxlint --vitest-plugin`) proves nothing about that tool. A compiled
 * language's build or test run also type-checks.
 */
function kindsOfInvocation(program: string, args: string[]): VerifyKind[] {
  const sub = args.find((a) => !a.startsWith('-')) ?? '';
  const has = (...names: string[]): boolean => args.some((a) => names.includes(a));
  const kinds: VerifyKind[] = [];
  const add = (...k: VerifyKind[]): void => {
    kinds.push(...k);
  };

  if (TEST_RUNNERS.has(program)) add('test');
  if (LINTERS.has(program)) add('lint');
  if (TYPECHECKERS.has(program)) add('typecheck');
  if (FORMATTERS.has(program)) add('format');
  if (BUNDLERS.has(program) && has('build', 'pack', 'export')) add('build');

  switch (program) {
    case 'tsc':
      add('typecheck');
      if (!has('--noEmit')) add('build');
      break;
    case 'biome':
      if (has('lint', 'check', 'ci')) add('lint');
      if (has('format', 'check', 'ci')) add('format');
      break;
    case 'ruff':
      add(sub === 'format' ? 'format' : 'lint');
      break;
    case 'node':
      if (has('--test')) add('test');
      break;
    case 'bun':
      if (sub === 'test') add('test');
      if (sub === 'check') add('typecheck');
      if (sub === 'fmt') add('format');
      if (sub === 'build') add('build');
      break;
    case 'deno':
      if (sub === 'test') add('test');
      if (sub === 'lint') add('lint');
      if (sub === 'check') add('typecheck');
      if (sub === 'fmt') add('format');
      break;
    case 'vp':
      if (sub === 'test') add('test');
      if (sub === 'lint') add('lint');
      if (sub === 'check') add('lint', 'format', 'typecheck');
      if (sub === 'fmt') add('format');
      if (sub === 'build' || sub === 'pack') add('build');
      break;
    case 'astro':
    case 'ty':
      if (sub === 'check') add('typecheck');
      break;
    case 'turbo':
    case 'nx':
      for (const a of args) add(...kindsFromName(a));
      break;
    case 'go':
      if (sub === 'test') add('test', 'typecheck');
      if (sub === 'vet') add('lint', 'typecheck');
      if (sub === 'build') add('build', 'typecheck');
      break;
    case 'cargo':
      if (sub === 'test' || sub === 'nextest') add('test', 'typecheck');
      if (sub === 'clippy') add('lint');
      if (sub === 'check') add('typecheck');
      if (sub === 'build') add('build', 'typecheck');
      if (sub === 'fmt') add('format');
      break;
    case 'swift':
      if (sub === 'test') add('test', 'typecheck');
      if (sub === 'build') add('build', 'typecheck');
      break;
    case 'dotnet':
      if (sub === 'test') add('test', 'typecheck');
      if (sub === 'build') add('build', 'typecheck');
      if (sub === 'format') add('format');
      break;
    case 'zig':
    case 'forge':
    case 'sbt':
      if (sub === 'test') add('test', 'typecheck');
      if (sub === 'build') add('build', 'typecheck');
      break;
    case 'flutter':
    case 'dart':
      if (sub === 'test') add('test');
      if (sub === 'analyze') add('lint', 'typecheck');
      if (sub === 'format') add('format');
      if (sub === 'build' || sub === 'compile') add('build', 'typecheck');
      break;
    case 'mix':
      if (sub === 'test') add('test');
      if (sub === 'credo') add('lint');
      if (sub === 'format') add('format');
      break;
    case 'rake':
      if (sub === 'test' || sub === 'spec') add('test');
      break;
    case 'fastlane':
      if (args.some((a) => /^(tests?|scan)$/.test(a))) add('test');
      break;
    case 'srb':
      if (sub === 'tc') add('typecheck');
      break;
    case 'gradle':
    case 'gradlew':
      for (const task of args.filter((a) => !a.startsWith('-')).map((a) => a.replace(/^.*:/, ''))) {
        if (/[tT]est/.test(task) || task === 'check') add('test', 'typecheck');
        if (/^(lint|detekt|ktlint)/.test(task) || task === 'spotlessCheck' || task === 'check') add('lint');
        if (/^(assemble|compile|bundle)/.test(task) || task === 'build') add('build', 'typecheck');
        if (/^spotless|^ktlintFormat$/.test(task)) add('format');
      }
      break;
    case 'mvn':
    case 'mvnw':
      if (has('test', 'verify', 'install')) add('test', 'typecheck');
      if (has('compile', 'package', 'install', 'verify')) add('build', 'typecheck');
      break;
    case 'xcodebuild':
      if (has('test', 'test-without-building')) add('test', 'typecheck');
      if (has('build', 'archive', 'build-for-testing', 'analyze')) add('build', 'typecheck');
      break;
    case 'wrangler':
      if (sub === 'deploy' && has('--dry-run')) add('build');
      break;
    case 'cmake':
      if (has('--build')) add('build');
      break;
    case 'docker':
      if (sub === 'build') add('build');
      break;
    default:
      break;
  }
  return kinds;
}

/** What a script or target proves by its name alone, when its body is a custom program. */
function kindsFromName(name: string): VerifyKind[] {
  const n = name.toLowerCase();
  if (/^(test|tests|spec)([:._-].*)?$/.test(n)) return ['test'];
  if (/^lint([:._-](?!fix).*)?$/.test(n)) return ['lint'];
  if (/^(typecheck|type-check|types|tsc|check[:._-]types)$/.test(n)) return ['typecheck'];
  if (/^build([:._-].*)?$/.test(n)) return ['build'];
  if (/^(fmt|format)[:._-]check$/.test(n)) return ['format'];
  return [];
}

const PM_BUILTINS: Record<string, ReadonlySet<string>> = {
  bun: new Set(['test', 'build', 'check', 'fmt', 'install', 'add', 'remove', 'x', 'pm', 'link', 'init', 'create', 'upgrade']),
  vp: new Set(['test', 'build', 'check', 'fmt', 'lint', 'dev', 'preview', 'pack', 'install', 'add', 'remove', 'env', 'dlx', 'exec']),
  npm: new Set(['install', 'ci', 'exec', 'publish', 'pack', 'audit', 'view']),
  pnpm: new Set(['install', 'add', 'exec', 'dlx', 'publish', 'audit']),
  yarn: new Set(['install', 'add', 'dlx', 'exec', 'npm', 'workspaces']),
};

/** The script names a package-manager invocation asks for, whether or not this package defines them. */
function scriptNamesIn(program: string, args: string[]): string[] {
  if (!(program in PM_BUILTINS) && program !== 'vpr') return [];
  const positional = args.filter((a) => !a.startsWith('-'));
  if (program === 'vpr') return positional.slice(0, 1);
  const runIndex = positional.findIndex((a) => a === 'run' || a === 'run-script');
  if (runIndex >= 0) return positional.slice(runIndex + 1, runIndex + 2);
  // `npm test`, `yarn lint`, `pnpm typecheck`
  const first = positional[0];
  return first && (first === 'test' || !PM_BUILTINS[program]!.has(first)) ? [first] : [];
}

/** The package scripts a command such as `bun run --parallel lint check test` invokes. */
function scriptsCalledBy(command: string, scripts: Scripts): string[] {
  const tokens = command.trim().split(/\s+/);
  const runner = tokens[0] ?? '';
  if (runner === 'vpr') return tokens.slice(1).filter((t) => t in scripts).slice(0, 1);
  if (!(runner in PM_BUILTINS)) return [];

  let i = 1;
  while (i < tokens.length && tokens[i]!.startsWith('-')) i++;
  const explicitRun = tokens[i] === 'run' || tokens[i] === 'run-script';
  if (explicitRun) i++;

  const names: string[] = [];
  for (; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === '--') break;
    if (tok === '--filter' || tok === '-F' || tok === '--workspace' || tok === '-w') {
      i++;
      continue;
    }
    if (tok.startsWith('-')) continue;
    if (!(tok in scripts)) break;
    if (!explicitRun && PM_BUILTINS[runner]!.has(tok)) break;
    names.push(tok);
    // Only `run --parallel a b c` (bun) or `run-s`-style lists name several scripts.
    if (!explicitRun) break;
  }
  return names;
}

interface RecipeBook {
  tool: 'make' | 'just';
  recipes: Map<string, { deps: string[]; lines: string[] }>;
}

function parseRecipes(text: string, tool: RecipeBook['tool']): RecipeBook {
  const recipes: RecipeBook['recipes'] = new Map();
  let current: { deps: string[]; lines: string[] } | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const header = /^([A-Za-z0-9_.-]+)(?:\s+[^:=]*)?:(?!=)\s*([^#]*)/.exec(raw);
    if (header && !/^\s/.test(raw)) {
      current = { deps: (header[2] ?? '').trim().split(/\s+/).filter(Boolean), lines: [] };
      recipes.set(header[1]!, current);
    } else if (current && /^\s+\S/.test(raw)) {
      current.lines.push(raw.trim().replace(/^[@-]+/, ''));
    } else if (raw.trim() === '') {
      continue;
    } else {
      current = undefined;
    }
  }
  return { tool, recipes };
}

/** A checked-in script a command line runs: `./scripts/ci.sh`, `bash scripts/test-kit.sh`, `node scripts/check.mjs`. */
const SCRIPT_FILE = /(?:^|[\s"'=])(?:\.\/)?((?:scripts?|bin|ci|tools|\.github\/scripts)\/[\w./-]+)/;

export class CommandClassifier {
  private readonly scripts: Scripts;
  private readonly books: RecipeBook[] = [];
  private readonly ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.ctx = ctx;
    this.scripts = ctx.packageJson?.scripts ?? {};
    const makefile = ctx.readText('Makefile') ?? ctx.readText('makefile');
    if (makefile) this.books.push(parseRecipes(makefile, 'make'));
    const justfile = ctx.readText('justfile') ?? ctx.readText('Justfile');
    if (justfile) this.books.push(parseRecipes(justfile, 'just'));
  }

  recipeNames(tool: RecipeBook['tool']): string[] {
    return [...(this.books.find((b) => b.tool === tool)?.recipes.keys() ?? [])];
  }

  /** Everything a shell command line proves, following package scripts and make/just targets. */
  classify(commandLine: string, seen: Set<string> = new Set()): Set<VerifyKind> {
    const kinds = new Set<VerifyKind>();
    for (const part of commandLine.split(/&&|\|\||;|\n/)) {
      const cmd = part.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '');
      // Printing or exporting a value runs nothing, even when it mentions a tool.
      if (!cmd || /^(#|echo\b|printf\b|export\b|cd\b|set\b)/.test(cmd)) continue;

      const scriptFile = SCRIPT_FILE.exec(cmd)?.[1];
      if (scriptFile && this.ctx.hasFile(scriptFile)) {
        for (const k of this.classifyFile(scriptFile, seen)) kinds.add(k);
      }

      for (const name of scriptsCalledBy(cmd, this.scripts)) {
        for (const k of this.classifyScript(name, seen)) kinds.add(k);
      }

      const recipeCall = /^(make|just)\s+(?:-\S+\s+)*([A-Za-z0-9_.-]+)/.exec(cmd);
      if (recipeCall) {
        for (const k of this.classifyRecipe(recipeCall[1] as RecipeBook['tool'], recipeCall[2]!, seen)) kinds.add(k);
      }

      const invocation = programOf(cmd);
      if (invocation) {
        for (const k of kindsOfInvocation(invocation.program, invocation.args)) kinds.add(k);
        // `npm run test:ci` inside a sub-package: the script is not ours to read, its name still says what it is.
        for (const name of scriptNamesIn(invocation.program, invocation.args)) {
          if (!(name in this.scripts)) for (const k of kindsFromName(name)) kinds.add(k);
        }
      }
    }
    return kinds;
  }

  /** What a checked-in shell or task script proves: its own name plus every command inside it. */
  classifyFile(file: string, seen: Set<string> = new Set()): Set<VerifyKind> {
    const key = `file:${file}`;
    const base = file.split('/').pop()!.replace(/\.[a-z]+$/, '');
    const kinds = new Set<VerifyKind>(kindsFromName(base.split(/[-_.]/)[0]!));
    if (seen.has(key) || seen.size > 24) return kinds;
    seen.add(key);
    // Only shell scripts are read line by line; a .mjs/.py program is judged by its name.
    if (/\.(sh|bash|zsh)$/.test(file) || !/\.[a-z]+$/.test(file)) {
      for (const line of (this.ctx.readText(file) ?? '').split(/\r?\n/)) {
        for (const k of this.classify(line.trim().replace(/\s*\\$/, ''), seen)) kinds.add(k);
      }
    }
    return kinds;
  }

  classifyScript(name: string, seen: Set<string> = new Set()): Set<VerifyKind> {
    const key = `script:${name}`;
    const kinds = new Set<VerifyKind>(kindsFromName(name));
    const body = this.scripts[name];
    if (body === undefined || seen.has(key)) return kinds;
    seen.add(key);
    for (const k of this.classify(body, seen)) kinds.add(k);
    return kinds;
  }

  classifyRecipe(tool: RecipeBook['tool'], target: string, seen: Set<string> = new Set()): Set<VerifyKind> {
    const key = `${tool}:${target}`;
    const kinds = new Set<VerifyKind>(kindsFromName(target));
    const recipe = this.books.find((b) => b.tool === tool)?.recipes.get(target);
    if (!recipe || seen.has(key)) return kinds;
    seen.add(key);
    for (const dep of recipe.deps) {
      for (const k of this.classifyRecipe(tool, dep, seen)) kinds.add(k);
    }
    for (const line of recipe.lines) {
      for (const k of this.classify(line, seen)) kinds.add(k);
    }
    return kinds;
  }
}

const KIND_ORDER: VerifyKind[] = ['lint', 'format', 'typecheck', 'build', 'test'];

export function sortKinds(kinds: Iterable<VerifyKind>): VerifyKind[] {
  const set = new Set(kinds);
  return KIND_ORDER.filter((k) => set.has(k));
}

function isUnified(kinds: VerifyKind[]): boolean {
  return kinds.includes('test') && (kinds.includes('lint') || kinds.includes('typecheck'));
}

/** How the repository's package scripts are run: `bun run x`, `pnpm run x`, `yarn x`, `npm run x`. */
export function scriptRunner(ctx: RepoContext): (script: string) => string {
  const runners: Record<string, (script: string) => string> = {
    bun: (s) => `bun run ${s}`,
    pnpm: (s) => `pnpm run ${s}`,
    yarn: (s) => `yarn ${s}`,
    npm: (s) => (s === 'test' ? 'npm test' : `npm run ${s}`),
  };
  const declared = /^(bun|pnpm|yarn|npm)@/.exec(ctx.packageJson?.packageManager ?? '')?.[1];
  if (declared) return runners[declared]!;

  const locked = [
    ctx.hasFile('bun.lock') || ctx.hasFile('bun.lockb') ? 'bun' : '',
    ctx.hasFile('pnpm-lock.yaml') ? 'pnpm' : '',
    ctx.hasFile('yarn.lock') ? 'yarn' : '',
    ctx.hasFile('package-lock.json') ? 'npm' : '',
  ].filter(Boolean);
  if (locked.length > 1) {
    // Two managers left lockfiles: the one CI installs with is the one the project really uses.
    const workflows = ctx.findFiles((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).map((f) => ctx.readText(f) ?? '').join('\n');
    const inCi = /\b(npm) ci\b|\b(pnpm|yarn|bun) install\b/.exec(workflows);
    const ciManager = inCi?.[1] ?? inCi?.[2];
    if (ciManager && locked.includes(ciManager)) return runners[ciManager]!;
  }
  return runners[locked[0] ?? 'npm']!;
}

const SCRIPT_PRIORITY = ['verify', 'check', 'ci', 'validate', 'test', 'lint', 'typecheck', 'type-check', 'build', 'fmt:check', 'format:check'];
const RECIPE_PRIORITY = ['verify', 'check', 'ci', 'test', 'lint', 'typecheck', 'build', 'fmt-check', 'format-check'];

/** Commands quoted in a markdown brief: fenced shell lines and inline code spans that look runnable. */
function quotedCommands(markdown: string, isRepoFile: (path: string) => boolean): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const cmd = line.replace(/^\$\s+/, '').replace(/\s+#.*$/, '');
      if (cmd && !cmd.startsWith('#') && cmd.length <= 240) out.push(cmd);
      continue;
    }
    for (const span of line.matchAll(/`([^`\n]{3,240})`/g)) {
      const cmd = span[1]!.trim();
      const looksRunnable = /\s/.test(cmd) || cmd.startsWith('./') || /^(pytest|tox|nox|make|just|rspec)$/.test(cmd);
      if (looksRunnable || (/\.(sh|bash|zsh)$/.test(cmd) && isRepoFile(cmd))) out.push(cmd);
    }
  }
  return out;
}

export function detectVerifyCapabilities(ctx: RepoContext): VerifyCapabilities {
  const classifier = new CommandClassifier(ctx);
  const commands: VerifyCommand[] = [];
  const add = (command: string, kinds: Iterable<VerifyKind>, source: string): void => {
    const sorted = sortKinds(kinds);
    if (sorted.length === 0 || commands.some((c) => c.command === command)) return;
    commands.push({ command, kinds: sorted, source });
  };

  // 1. package.json scripts
  const scripts = ctx.packageJson?.scripts ?? {};
  const run = scriptRunner(ctx);
  // A watcher or a dev server never exits, so it cannot be a verify command.
  const longRunning = (name: string): boolean =>
    /(^|[:._-])(watch|dev|serve|ui|debug|open)($|[:._-])/.test(name) || /--watch\b|\bnodemon\b/.test(scripts[name] ?? '');
  const scriptNames = [
    ...SCRIPT_PRIORITY.filter((n) => n in scripts),
    ...Object.keys(scripts).filter((n) => /^test[:._-]/.test(n) && !longRunning(n)).slice(0, 4),
  ];
  for (const name of scriptNames) add(run(name), classifier.classifyScript(name), 'package.json');

  // 2. Makefile / justfile targets
  for (const tool of ['make', 'just'] as const) {
    const names = classifier.recipeNames(tool);
    for (const target of RECIPE_PRIORITY.filter((n) => names.includes(n))) {
      add(`${tool} ${target}`, classifier.classifyRecipe(tool, target), tool === 'make' ? 'Makefile' : 'justfile');
    }
  }

  // 3. Checked-in verify scripts
  const scriptFiles = ctx.findFiles((f) =>
    /^(scripts?|bin|ci|tools)\/(verify|check|test|tests|lint|ci|preflight|validate|typecheck)([-_][\w-]+)?(\.(sh|bash|zsh))?$/.test(f),
  );
  for (const file of scriptFiles.slice(0, 6)) add(`./${file}`, classifier.classifyFile(file), file);

  // 4. Build tools whose verify commands are conventions rather than scripts
  const gradle = ctx.hasFile('gradlew') ? './gradlew' : undefined;
  const hasGradle = gradle !== undefined || ctx.hasAnyFile(['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) !== undefined;
  if (hasGradle) {
    const g = gradle ?? 'gradle';
    add(`${g} check`, ['test', 'lint', 'typecheck'], 'Gradle');
    add(`${g} test`, ['test', 'typecheck'], 'Gradle');
    add(`${g} assemble`, ['build', 'typecheck'], 'Gradle');
  }
  if (ctx.hasFile('Package.swift')) {
    add('swift build', ['build', 'typecheck'], 'Package.swift');
    if (ctx.testFiles.some((f) => f.endsWith('.swift'))) add('swift test', ['test', 'typecheck'], 'Package.swift');
  }
  if (ctx.hasFile('Cargo.toml')) {
    add('cargo test', ['test', 'typecheck'], 'Cargo.toml');
    add('cargo clippy --all-targets -- -D warnings', ['lint'], 'Cargo.toml');
    add('cargo fmt --check', ['format'], 'Cargo.toml');
    add('cargo build', ['build', 'typecheck'], 'Cargo.toml');
  }
  if (ctx.hasFile('go.mod')) {
    add('go test ./...', ['test', 'typecheck'], 'go.mod');
    add('go vet ./...', ['lint', 'typecheck'], 'go.mod');
    add('go build ./...', ['build', 'typecheck'], 'go.mod');
  }
  const pyproject = ctx.readText('pyproject.toml') ?? '';
  const hasPython = pyproject !== '' || ctx.hasAnyFile(['requirements.txt', 'setup.py', 'tox.ini', 'noxfile.py']) !== undefined;
  if (hasPython) {
    const prefix = ctx.hasFile('uv.lock') || /\[tool\.uv\]/.test(pyproject) ? 'uv run ' : ctx.hasFile('poetry.lock') ? 'poetry run ' : '';
    const pyTests = ctx.testFiles.some((f) => f.endsWith('.py'));
    if (pyTests || /\[tool\.pytest|pytest/.test(pyproject) || ctx.hasFile('pytest.ini')) add(`${prefix}pytest`, ['test'], 'pytest');
    if (/\[tool\.ruff/.test(pyproject) || ctx.hasAnyFile(['ruff.toml', '.ruff.toml'])) add(`${prefix}ruff check .`, ['lint'], 'ruff');
    if (/\[tool\.(pyright|basedpyright)\]/.test(pyproject) || ctx.hasFile('pyrightconfig.json')) add(`${prefix}pyright`, ['typecheck'], 'pyright');
    else if (/\[tool\.mypy\]/.test(pyproject) || ctx.hasAnyFile(['mypy.ini', '.mypy.ini'])) add(`${prefix}mypy .`, ['typecheck'], 'mypy');
  }
  if (ctx.hasFile('pubspec.yaml')) {
    const flutter = /^\s*flutter\s*:/m.test(ctx.readText('pubspec.yaml') ?? '');
    const tool = flutter ? 'flutter' : 'dart';
    add(`${tool} analyze`, ['lint', 'typecheck'], 'pubspec.yaml');
    if (ctx.testFiles.some((f) => f.endsWith('.dart'))) add(`${tool} test`, ['test'], 'pubspec.yaml');
  }
  if (ctx.hasFile('mix.exs')) {
    add('mix test', ['test'], 'mix.exs');
    add('mix format --check-formatted', ['format'], 'mix.exs');
  }
  if (ctx.hasFile('Gemfile')) {
    if (ctx.hasFile('.rspec') || ctx.testFiles.some((f) => f.startsWith('spec/'))) add('bundle exec rspec', ['test'], 'Gemfile');
    if (ctx.hasFile('.rubocop.yml')) add('bundle exec rubocop', ['lint'], '.rubocop.yml');
  }
  if (ctx.findFiles((f) => f.endsWith('.sln') || f.endsWith('.csproj')).length > 0) {
    add('dotnet build', ['build', 'typecheck'], '.NET');
    if (ctx.testFiles.some((f) => f.endsWith('.cs'))) add('dotnet test', ['test', 'typecheck'], '.NET');
  }

  // 5. Commands the root brief tells agents to run
  const documented: VerifyCommand[] = [];
  for (const briefFile of ['AGENTS.md', 'CLAUDE.md']) {
    const text = ctx.readText(briefFile);
    if (!text) continue;
    for (const cmd of quotedCommands(text, (p) => ctx.hasFile(p))) {
      const kinds = sortKinds(classifier.classify(cmd));
      if (kinds.length === 0 || documented.some((d) => d.command === cmd)) continue;
      documented.push({ command: cmd, kinds, source: briefFile });
    }
  }
  // A documented command the tool did not already derive (e.g. an `xcodebuild` line with its scheme).
  for (const doc of documented.slice(0, 8)) add(doc.command, doc.kinds, doc.source);

  const kinds = new Set<VerifyKind>(commands.flatMap((c) => c.kinds));
  const unified =
    commands.find((c) => isUnified(c.kinds) && c.kinds.length >= 3) ?? commands.find((c) => isUnified(c.kinds));

  return { commands, documented, kinds, unified };
}

export function describeCommand(cmd: VerifyCommand): string {
  return `\`${cmd.command}\` → ${cmd.kinds.join(' + ')}`;
}

/**
 * The fewest detected commands that together cover typecheck, lint, test and build: what a brief
 * should quote, what CI should run, what a permission policy should allow.
 */
export function minimalVerifySet(caps: VerifyCapabilities): string[] {
  const chosen = caps.unified ? [caps.unified] : [];
  for (const kind of ['typecheck', 'lint', 'test', 'build'] as const) {
    if (chosen.some((c) => c.kinds.includes(kind))) continue;
    // The most specific command for the kind: `npm run lint` before a broader script that also lints.
    const next = caps.commands.filter((c) => c.kinds.includes(kind)).sort((a, b) => a.kinds.length - b.kinds.length)[0];
    if (next) chosen.push(next);
  }
  return chosen.map((c) => c.command);
}

/**
 * Commands that ship from a local checkout: deploy and publish package scripts (unless the script
 * only refuses, e.g. `echo … && exit 1`) and the platform CLI the repository is configured for.
 */
export function localDeployCommands(ctx: RepoContext): string[] {
  const scripts = ctx.packageJson?.scripts ?? {};
  const run = scriptRunner(ctx);
  const commands = Object.entries(scripts)
    .filter(([name, body]) => /^(deploy|publish)([:._-].*)?$/.test(name) && !/\bexit\s+1\b/.test(body))
    .map(([name]) => run(name));
  if (ctx.hasAnyFile(['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'])) commands.push('npx wrangler deploy');
  if (ctx.hasAnyFile(['vercel.json'])) commands.push('npx vercel --prod');
  if (ctx.hasAnyFile(['fly.toml'])) commands.push('fly deploy');
  if (ctx.hasAnyFile(['netlify.toml'])) commands.push('npx netlify deploy --prod');
  return commands;
}

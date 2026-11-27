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

/**
 * Recognisers for a single shell command (no `&&`). Order is irrelevant: every match counts.
 * A compiled language's build or test run also type-checks, which the last typecheck rows say.
 */
const KIND_PATTERNS: ReadonlyArray<readonly [VerifyKind, RegExp]> = [
  ['test', /\b(vitest|jest|mocha|ava|playwright|cypress|pytest|tox|nox|rspec|phpunit|pest|ctest|karma|nextest)\b/],
  ['test', /\b(?:go|cargo|swift|dotnet|flutter|dart|mix|bun|deno|vp|zig|forge|sbt)\s+test\b/],
  ['test', /\bnode\s+(?:\S+\s+)*--test\b/],
  ['test', /\bpython3?\s+-m\s+(?:pytest|unittest)\b/],
  ['test', /(?:^|[\s/])gradlew?(?:\.bat)?\b.*?(?:^|[\s:])(?:\w*[tT]est\w*|check)\b/],
  ['test', /(?:^|[\s/])mvnw?\b.*\b(?:test|verify|install)\b/],
  ['test', /\bxcodebuild\b.*\btest(?:-without-building)?\b/],
  ['test', /\brake\s+(?:test|spec)\b/],
  ['test', /\bfastlane\s+(?:\S+\s+)?(?:tests?|scan)\b/],
  ['lint', /\b(eslint|oxlint|ruff\s+check|flake8|pylint|golangci-lint|rubocop|swiftlint|ktlint|detekt|shellcheck|stylelint|actionlint|phpcs|phpstan|psalm|clang-tidy|cppcheck|staticcheck|knip)\b/],
  ['lint', /\bbiome\s+(?:lint|check|ci)\b/],
  ['lint', /\b(?:cargo\s+clippy|go\s+vet|mix\s+credo|vp\s+(?:lint|check))\b/],
  ['lint', /\b(?:dart|flutter)\s+analyze\b/],
  ['lint', /(?:^|[\s/])gradlew?(?:\.bat)?\b.*?(?:^|[\s:])(?:lint\w*|detekt\w*|ktlint\w*|spotlessCheck|check)\b/],
  ['typecheck', /\b(tsc|tsgo|vue-tsc|svelte-check|mypy|pyright|basedpyright|steep)\b/],
  ['typecheck', /\b(?:astro|bun|vp|cargo|ty|srb)\s+(?:check|tc)\b/],
  ['typecheck', /\bgo\s+(?:vet|build|test)\b/],
  ['typecheck', /(?:^|[\s/])gradlew?(?:\.bat)?\b.*?(?:^|[\s:])(?:assemble\w*|compile\w*|build|\w*[tT]est\w*|check)\b/],
  ['typecheck', /\b(?:swift\s+(?:build|test)|cargo\s+(?:build|test)|dotnet\s+(?:build|test)|zig\s+build)\b/],
  ['typecheck', /\bxcodebuild\b.*\b(?:build|test|archive|analyze|build-for-testing|test-without-building)\b/],
  ['typecheck', /(?:^|[\s/])mvnw?\b.*\b(?:compile|test|verify|package|install)\b/],
  ['typecheck', /\b(?:flutter\s+(?:build|analyze)|dart\s+(?:analyze|compile))\b/],
  ['build', /\b(?:vite|next|astro|nuxt|webpack|rollup|esbuild|tsup|tsdown|turbo|nx|vp|remix|react-router|expo|docusaurus)\s+(?:run\s+)?(?:build|pack|export)\b/],
  ['build', /\btsc\b(?!.*--noEmit)/],
  ['build', /\b(?:cargo|go|swift|dotnet|zig|flutter|docker|bun)\s+build\b/],
  ['build', /\bxcodebuild\b.*\b(?:build|archive|build-for-testing)\b/],
  ['build', /(?:^|[\s/])gradlew?(?:\.bat)?\b.*?(?:^|[\s:])(?:assemble\w*|build|bundle\w*)\b/],
  ['build', /(?:^|[\s/])mvnw?\b.*\b(?:package|install|verify)\b/],
  ['build', /\bwrangler\s+deploy\s+.*--dry-run\b|\bcmake\s+--build\b/],
  ['format', /\b(prettier|dprint|oxfmt|black|gofmt|goimports|swiftformat|rustfmt)\b/],
  ['format', /\b(?:cargo\s+fmt|ruff\s+format|mix\s+format|dart\s+format|bun\s+fmt|vp\s+(?:fmt|check)|biome\s+(?:format|check|ci))\b/],
  ['format', /spotless(?:Check|Apply)|ktlintFormat/],
];

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

      for (const [kind, pattern] of KIND_PATTERNS) {
        if (pattern.test(cmd)) kinds.add(kind);
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
  const pkg = ctx.packageJson;
  const declared = pkg?.packageManager ?? '';
  if (ctx.hasFile('bun.lock') || ctx.hasFile('bun.lockb') || declared.startsWith('bun')) return (s) => `bun run ${s}`;
  if (ctx.hasFile('pnpm-lock.yaml') || declared.startsWith('pnpm')) return (s) => `pnpm run ${s}`;
  if (ctx.hasFile('yarn.lock') || declared.startsWith('yarn')) return (s) => `yarn ${s}`;
  return (s) => (s === 'test' ? 'npm test' : `npm run ${s}`);
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
  const scriptNames = [
    ...SCRIPT_PRIORITY.filter((n) => n in scripts),
    ...Object.keys(scripts).filter((n) => /^test[:._-]/.test(n)).slice(0, 4),
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

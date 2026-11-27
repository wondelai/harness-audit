import { dirname, join } from 'node:path';
import { describeCommand } from '../capabilities.js';
import { stripJsonComments, type RepoContext } from '../fs-scanner.js';
import type { CheckResult, LocalizedText } from '../types.js';

interface TsConfigShape {
  compilerOptions?: Record<string, unknown>;
  extends?: string | string[];
  references?: Array<{ path?: string }>;
}

/** `set`: a config in the chain wrote `strict` itself, as opposed to nobody mentioning it. */
type StrictVerdict = { strict: boolean; via: string; set?: boolean } | { unresolved: string };

/** Where an installed package's `exports` map sends a spec such as `agents/tsconfig`. */
function packageExportTargets(ctx: RepoContext, spec: string): string[] {
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  const subpath = `./${parts.slice(name.split('/').length).join('/')}`.replace(/\/$/, '');
  const raw = ctx.readUnscannedText(`node_modules/${name}/package.json`);
  if (!raw) return [];
  try {
    const pkg = JSON.parse(raw) as { exports?: Record<string, unknown>; tsconfig?: string };
    const entry = subpath === '.' ? (pkg.tsconfig ?? pkg.exports?.['.']) : pkg.exports?.[subpath];
    const target = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? Object.values(entry).find((v) => typeof v === 'string') : undefined;
    return typeof target === 'string' ? [`node_modules/${name}/${target.replace(/^\.\//, '')}`] : [];
  } catch {
    return [];
  }
}

/**
 * Whether a tsconfig ends up with `strict: true`, following `extends` through local files and
 * installed presets. A preset that is not installed leaves the answer open instead of guessing.
 */
function resolveStrict(ctx: RepoContext, file: string, depth = 0): StrictVerdict {
  const raw = ctx.readText(file) ?? ctx.readUnscannedText(file);
  if (raw === null) return { unresolved: file };
  let config: TsConfigShape;
  try {
    config = JSON.parse(raw) as TsConfigShape;
  } catch {
    try {
      config = JSON.parse(stripJsonComments(raw)) as TsConfigShape;
    } catch {
      return { unresolved: file };
    }
  }

  // `null`, a number, an array: valid JSON, not a tsconfig.
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return { unresolved: file };
  const own = config.compilerOptions?.['strict'];
  if (typeof own === 'boolean') return { strict: own, via: file, set: true };
  if (depth >= 6) return { strict: false, via: file };

  const parents = (config.extends === undefined ? [] : Array.isArray(config.extends) ? config.extends : [config.extends]).filter((p): p is string => typeof p === 'string');
  let open: string | undefined;
  // Later entries override earlier ones, so read them last-first.
  for (const spec of [...parents].reverse()) {
    const candidates = spec.startsWith('.')
      ? [join(dirname(file), spec), join(dirname(file), `${spec}.json`)]
      : [...packageExportTargets(ctx, spec), `node_modules/${spec}`, `node_modules/${spec}.json`, `node_modules/${spec}/tsconfig.json`];
    const target = candidates.map((c) => c.replace(/\\/g, '/')).find((c) => /\.json$/.test(c) && (ctx.readText(c) ?? ctx.readUnscannedText(c)) !== null);
    if (!target) {
      // Presets whose name says it are strict by definition, installed or not.
      if (/strict/i.test(spec)) return { strict: true, via: spec };
      open = spec;
      continue;
    }
    const verdict = resolveStrict(ctx, target, depth + 1);
    // A parent that sets `strict` decides. One that leaves it unset (its verdict names itself, not
    // a config that said `false`) does not shadow an earlier parent that sets it.
    if ('strict' in verdict && (verdict.strict || verdict.set)) return verdict;
    if ('unresolved' in verdict) open = verdict.unresolved;
  }
  return open ? { unresolved: open } : { strict: false, via: file };
}

/**
 * Whether an XcodeGen `packages:` section declares a remote package (`url:` or `github:`). Read
 * line by line: a single pattern over the whole section backtracks exponentially on a long list of
 * local packages.
 */
function xcodegenRemotePackages(projectYml: string): boolean {
  const lines = projectYml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  if (start === -1) return false;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break;
    if (/^\s+(url|github):/.test(line)) return true;
  }
  return false;
}

export function runLoopChecks(ctx: RepoContext): CheckResult[] {
  const results: CheckResult[] = [];
  const stack = ctx.stack;

  // 1. loop.stack-detection
  {
    const hasKnownStack = stack.languages.length > 0 || stack.packageManagers.length > 0;
    const evidence: string[] = [];
    if (stack.languages.length > 0) evidence.push(`Languages: ${stack.languages.join(', ')}`);
    if (stack.frameworks.length > 0) evidence.push(`Frameworks: ${stack.frameworks.join(', ')}`);
    if (stack.packageManagers.length > 0) evidence.push(`Package managers: ${stack.packageManagers.join(', ')}`);
    evidence.push(`Layout: ${stack.monorepo ? 'Monorepo' : 'Single repository'} (${stack.sourceFileCount} source files, ${stack.testFileCount} test files)`);

    results.push({
      id: 'loop.stack-detection',
      station: 'loop',
      weight: 10,
      status: hasKnownStack ? 'pass' : 'warn',
      severity: 'low',
      title: {
        en: 'Recognizable build & package manifest',
        pl: 'Rozpoznawalny manifest budowania i pakietów',
      },
      evidence,
      why: {
        en: 'Standard project manifests let both humans and coding agents bootstrap dependencies and discover tooling deterministically.',
        pl: 'Standardowe manifesty projektu pozwalają ludziom i agentom jednoznacznie zainstalować zależności i rozpoznać narzędzia.',
      },
      fix: {
        en: 'Commit the manifest your toolchain expects at the repo root (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Package.swift`, `build.gradle.kts`, `Makefile`, …) so the install and build steps are discoverable.',
        pl: 'Dodaj w katalogu głównym manifest właściwy dla Twojego toolchainu (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Package.swift`, `build.gradle.kts`, `Makefile`, …), aby instalacja i budowanie były jednoznaczne.',
      },
      docsPath: 'workflows/harness/agent-ready-codebase/',
    });
  }

  // 2. loop.single-command-verify
  {
    const verify = ctx.verify;
    const hasTest = verify.kinds.has('test');
    const hasStatic = verify.kinds.has('lint') || verify.kinds.has('typecheck');
    const hasBrief = ctx.hasFile('AGENTS.md') || ctx.hasFile('CLAUDE.md');
    const documented = verify.documented;

    const evidence: string[] = [];
    if (verify.commands.length > 0) {
      const shown = verify.commands.slice(0, 4);
      evidence.push(`Verify commands: ${shown.map(describeCommand).join(' · ')}${verify.commands.length > shown.length ? ` · +${verify.commands.length - shown.length} more` : ''}`);
    } else {
      evidence.push('No test, lint, typecheck or build command found (package scripts, Makefile/justfile targets, Gradle, SwiftPM, Cargo, Go, pytest, scripts/)');
    }
    if (hasBrief) {
      evidence.push(
        documented.length > 0
          ? documented.every((d) => d.source === 'README.md')
            ? `${ctx.brief.primary} sends agents to README.md, which quotes ${documented.length} verify command(s), e.g. \`${documented[0]!.command}\``
            : `Root instructions quote ${documented.length} verify command(s), e.g. \`${documented[0]!.command}\``
          : 'Root instructions quote no test, lint or type-check command (looked in backticks and code fences; a build command alone does not count)',
      );
    }
    const missing = [!hasTest ? 'tests' : '', !hasStatic ? 'lint or typecheck' : ''].filter(Boolean);
    if (missing.length > 0 && verify.commands.length > 0) evidence.push(`Missing from the loop: ${missing.join(', ')}`);
    if (verify.simulatorTestScheme) {
      evidence.push(
        `Scheme ${verify.simulatorTestScheme} has a test action; its command needs a simulator this audit cannot choose, so quote yours in the brief: \`xcodebuild test -scheme ${verify.simulatorTestScheme} -destination 'platform=iOS Simulator,name=<installed simulator>'\``,
      );
    }

    // Documentation, prompts or configuration only: nothing to verify by running it.
    const noProgram = ctx.sourceFiles.length === 0 && verify.commands.length === 0;
    let status: CheckResult['status'] = 'fail';
    if (hasTest && hasStatic && (documented.length > 0 || !hasBrief)) {
      status = 'pass';
    } else if (hasTest || hasStatic) {
      status = 'warn';
    } else if (noProgram) {
      status = 'info';
      evidence.length = 0;
      evidence.push('No source code detected (documentation / configuration repository) — no verify loop to run');
    }

    const quote = verify.unified ?? verify.commands.find((c) => c.kinds.includes('test')) ?? verify.commands[0];
    const fixEn =
      verify.commands.length === 0
        ? 'Give the repository one command that proves a change: tests plus a static check (lint or typecheck), exiting non-zero on failure. Expose it where your stack expects it (a package script, a Makefile target, a Gradle task, `scripts/verify.sh`) and quote it in `AGENTS.md`.'
        : missing.length > 0
          ? `Add the missing half of the loop (${missing.join(' and ')}) next to \`${quote!.command}\`, ideally behind one \`verify\`/\`check\` command, and quote it in \`AGENTS.md\`.`
          : `Quote the exact commands in \`AGENTS.md\` inside backticks so agents run them before finishing: ${verify.commands.slice(0, 3).map((c) => `\`${c.command}\``).join(', ')}.`;
    const fixPl =
      verify.commands.length === 0
        ? 'Daj repozytorium jedną komendę, która dowodzi poprawności zmiany: testy plus sprawdzenie statyczne (lint lub typecheck), z niezerowym kodem wyjścia przy błędzie. Udostępnij ją tam, gdzie oczekuje tego Twój stos (skrypt pakietu, cel Makefile, zadanie Gradle, `scripts/verify.sh`) i wpisz ją do `AGENTS.md`.'
        : missing.length > 0
          ? `Dodaj brakującą część pętli (${missing.join(' i ')}) obok \`${quote!.command}\`, najlepiej pod jedną komendą \`verify\`/\`check\`, i wpisz ją do \`AGENTS.md\`.`
          : `Wpisz dokładne komendy do \`AGENTS.md\` w backtickach, aby agenci uruchamiali je przed zakończeniem pracy: ${verify.commands.slice(0, 3).map((c) => `\`${c.command}\``).join(', ')}.`;

    results.push({
      id: 'loop.single-command-verify',
      station: 'loop',
      weight: 30,
      status,
      severity: status === 'fail' ? 'critical' : status === 'warn' ? 'high' : 'low',
      title: {
        en: 'Fast deterministic verify loop',
        pl: 'Szybka, deterministyczna pętla weryfikacji',
      },
      evidence,
      why: {
        en: 'Level 3–4 autonomy depends on a machine-checkable stop condition (static checks + tests exiting 0) documented right where agents read it.',
        pl: 'Autonomia Poziomu 3–4 wymaga maszynowo sprawdzalnego warunku stopu (sprawdzenia statyczne + testy kończące się kodem 0), opisanego w instrukcjach agenta.',
      },
      // The brief that exists is the one to edit.
      fix: { en: fixEn.replaceAll('`AGENTS.md`', `\`${ctx.brief.primary}\``), pl: fixPl.replaceAll('`AGENTS.md`', `\`${ctx.brief.primary}\``) },
      docsPath: 'ladder/level-4-write-specs/',
    });
  }

  // 3. loop.static-types
  {
    const evidence: string[] = [];
    let status: CheckResult['status'] = 'fail';

    const nativeTyped = stack.languages.filter((l) => ['Go', 'Rust', 'Java', 'Kotlin', 'C#', 'Swift', 'Dart', 'Scala'].includes(l));
    // The root tsconfig, or in a workspace without one, the first few package configs.
    const tsconfigs = ctx.hasFile('tsconfig.json')
      ? ['tsconfig.json']
      : stack.languages.includes('TypeScript')
        ? ctx.findFiles((f) => /(^|\/)tsconfig\.json$/.test(f) && f.split('/').length <= 4).slice(0, 5)
        : [];
    if (tsconfigs.length > 0) {
      const root = ctx.readJson<TsConfigShape>(tsconfigs[0]!);
      // A solution-style root only points at the real configs.
      const targets =
        tsconfigs.length === 1 && root?.compilerOptions?.['strict'] === undefined && root?.extends === undefined && (root?.references?.length ?? 0) > 0
          ? root!.references!.map((r) => (typeof r?.path === 'string' ? r.path : '').replace(/^\.\//, '')).filter(Boolean).map((p) => (p.endsWith('.json') ? p : `${p}/tsconfig.json`)).slice(0, 5)
          : tsconfigs;
      // References that name no path leave nothing to follow: judge the root itself.
      if (targets.length === 0) targets.push(...tsconfigs);
      const verdicts = targets.map((t) => ({ file: t, verdict: resolveStrict(ctx, t) }));
      const strictOnes = verdicts.filter((v) => 'strict' in v.verdict && v.verdict.strict);
      // A referenced config that covers only build-tool config files (`vite.config.ts`) is not the application's type check.
      const toolingOnly = (file: string): boolean => {
        const include = ctx.readJson<{ include?: string[] }>(file)?.include;
        return Array.isArray(include) && include.length > 0 && include.every((p) => /(^|\/)[\w.*-]*\.config\.[\w*{},]+$|^scripts?\//.test(p));
      };
      const looseOnes = verdicts.filter((v) => 'strict' in v.verdict && !v.verdict.strict && !(strictOnes.length > 0 && toolingOnly(v.file)));
      const openOnes = verdicts.filter((v) => 'unresolved' in v.verdict);

      if (looseOnes.length === 0 && strictOnes.length > 0) {
        status = 'pass';
        const first = strictOnes[0]!;
        const via = (first.verdict as { via: string }).via;
        evidence.push(
          strictOnes.length > 1
            ? `${strictOnes.length} tsconfig files set \`strict: true\` (${strictOnes.slice(0, 3).map((v) => v.file).join(', ')}${strictOnes.length > 3 ? ', …' : ''})`
            : via === first.file
              ? `${first.file} has \`compilerOptions.strict: true\``
              : `${first.file} inherits \`strict: true\` from ${via}`,
        );
        // Plain JavaScript next to the TypeScript is outside the type checker.
        const jsFiles = ctx.sourceFiles.filter((f) => /\.(js|jsx|mjs|cjs)$/.test(f)).length;
        const tsFiles = ctx.sourceFiles.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f)).length;
        if (jsFiles >= 20 && jsFiles > tsFiles * 0.3) {
          evidence.push(`${jsFiles} of ${jsFiles + tsFiles} source files are plain JavaScript, outside the type checker`);
          if (jsFiles > tsFiles) status = 'warn';
        }
      } else if (looseOnes.length > 0) {
        status = 'warn';
        evidence.push(`${looseOnes.map((v) => v.file).join(', ')}: \`compilerOptions.strict\` is not enabled (checked the extends chain)`);
      } else {
        status = 'info';
        const open = (openOnes[0]!.verdict as { unresolved: string }).unresolved;
        evidence.push(`${openOnes[0]!.file} extends \`${open}\`, which is not installed here — run the install step and re-audit to verify strict mode`);
      }
    } else if (stack.languages.includes('TypeScript')) {
      // bun, tsx and Node strip types without checking them: with no tsconfig nothing ever does.
      status = 'warn';
      evidence.push('TypeScript without a tsconfig.json: the files run, but nothing type-checks them');
    } else if (nativeTyped.length > 0) {
      status = 'pass';
      evidence.push(`Statically typed language(s): ${nativeTyped.join(', ')}`);
    } else if (stack.languages.includes('Python')) {
      const pyproject = ctx.readText('pyproject.toml') ?? '';
      const hasPyType =
        /\[tool\.(mypy|pyright|basedpyright|ty)\]/i.test(pyproject) ||
        ctx.hasAnyFile(['mypy.ini', '.mypy.ini', 'pyrightconfig.json']) !== undefined;
      if (hasPyType) {
        status = 'pass';
        evidence.push('Python static type checker configured (mypy/pyright)');
      } else {
        status = 'warn';
        evidence.push('Python codebase without mypy or pyright configuration');
      }
    } else if (stack.languages.includes('PHP')) {
      const hasPhpType = ctx.hasAnyFile(['phpstan.neon', 'phpstan.neon.dist', 'psalm.xml']);
      status = hasPhpType ? 'pass' : 'warn';
      evidence.push(hasPhpType ? `PHP static analyzer: ${hasPhpType}` : 'PHP codebase without PHPStan or Psalm');
    } else if (stack.languages.includes('Ruby')) {
      const hasRubyType = ctx.hasAnyFile(['sorbet/config', 'Steepfile']);
      status = hasRubyType ? 'pass' : 'warn';
      evidence.push(hasRubyType ? `Ruby type checker: ${hasRubyType}` : 'Ruby codebase without Sorbet or Steep');
    } else if (stack.languages.includes('JavaScript')) {
      const hasJsConfig = ctx.hasFile('jsconfig.json');
      status = 'fail';
      evidence.push(
        hasJsConfig
          ? 'Plain JavaScript with jsconfig.json (no strict TypeScript typecheck)'
          : 'Plain JavaScript without TypeScript strict type checking',
      );
    } else {
      status = 'info';
      evidence.push('No recognized application language requiring separate static type config');
    }

    // A strict configuration proves nothing until a command runs the checker.
    if (status === 'pass' && tsconfigs.length > 0 && ctx.verify.commands.length > 0 && !ctx.verify.kinds.has('typecheck')) {
      status = 'warn';
      evidence.push('Strict mode is configured, but none of the verify commands runs the type checker (no `tsc`, `astro check` or similar in the scripts)');
    }

    results.push({
      id: 'loop.static-types',
      station: 'loop',
      weight: 25,
      status,
      severity: status === 'fail' ? 'high' : status === 'warn' ? 'medium' : 'low',
      title: {
        en: 'Strict static type checking',
        pl: 'Ścisłe statyczne typowanie',
      },
      evidence,
      why: {
        en: 'Strict static types catch hallucinated properties, broken refactors, and mismatched contracts in milliseconds — before any human or test sees the diff.',
        pl: 'Ścisłe typy statyczne wyłapują halucynowane pola, zepsute refaktoryzacje i niezgodne kontrakty w milisekundach — zanim diff trafi do człowieka lub testów.',
      },
      // The advice for the language this repository is written in.
      fix:
        tsconfigs.length > 0
          ? {
              en: 'Set `"strict": true` in the tsconfig named above (fix what it surfaces one area at a time) and run the type check in your verify command and CI.',
              pl: 'Ustaw `"strict": true` we wskazanym wyżej tsconfig (poprawiaj zgłoszone błędy obszar po obszarze) i uruchamiaj sprawdzanie typów w komendzie weryfikacji oraz w CI.',
            }
          : stack.languages.includes('TypeScript')
            ? {
                en: 'Add a `tsconfig.json` with `"strict": true` and `"noEmit": true`, and run `tsc --noEmit` in your verify command and CI.',
                pl: 'Dodaj `tsconfig.json` z `"strict": true` i `"noEmit": true` oraz uruchamiaj `tsc --noEmit` w komendzie weryfikacji i w CI.',
              }
          : stack.languages.includes('Python')
            ? {
                en: 'Configure `pyright` or `mypy` in `pyproject.toml` (strict for new code) and run it in your verify command and CI.',
                pl: 'Skonfiguruj `pyright` lub `mypy` w `pyproject.toml` (tryb strict dla nowego kodu) i uruchamiaj go w komendzie weryfikacji oraz w CI.',
              }
            : stack.languages.includes('JavaScript')
              ? {
                  en: 'Type-check the JavaScript as it is: add a `jsconfig.json` with `"checkJs": true` and `"strict": true` (JSDoc carries the types) and run `tsc --noEmit -p jsconfig.json` in your verify command and CI.',
                  pl: 'Sprawdzaj typy w istniejącym JavaScripcie: dodaj `jsconfig.json` z `"checkJs": true` i `"strict": true` (typy niesie JSDoc) i uruchamiaj `tsc --noEmit -p jsconfig.json` w komendzie weryfikacji oraz w CI.',
                }
              : {
                  en: 'Enable strict typechecking (`strict: true` in `tsconfig.json`, `pyright`/`mypy` for Python, `phpstan` for PHP) and wire it into your verify command and CI.',
                  pl: 'Włącz ścisłe typowanie (`strict: true` w `tsconfig.json`, `pyright`/`mypy` w Pythonie, `phpstan` w PHP) i podepnij je do komendy weryfikacji oraz CI.',
                },
      docsPath: 'workflows/test/',
    });
  }

  // 4. loop.formatter-linter
  {
    const toolsFound: string[] = [];
    const found = (label: string): void => {
      if (!toolsFound.includes(label)) toolsFound.push(label);
    };
    const configFiles: Array<[string[], string]> = [
      [['biome.json', 'biome.jsonc'], 'Biome'],
      [['dprint.json', '.dprint.json', 'dprint.jsonc'], 'dprint'],
      [['.oxlintrc.json', 'oxlint.json'], 'oxlint'],
      [['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs', '.eslintrc.yml', '.eslintrc.yaml'], 'ESLint'],
      [['.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.yml', '.prettierrc.yaml', 'prettier.config.js', 'prettier.config.mjs', 'prettier.config.cjs'], 'Prettier'],
      [['deno.json', 'deno.jsonc'], 'deno lint / fmt'],
      [['ruff.toml', '.ruff.toml'], 'Ruff'],
      [['.flake8', '.pylintrc'], 'flake8 / pylint'],
      [['.golangci.yml', '.golangci.yaml', '.golangci.toml'], 'golangci-lint'],
      [['rustfmt.toml', '.rustfmt.toml', 'clippy.toml'], 'rustfmt / clippy'],
      [['.rubocop.yml'], 'RuboCop'],
      [['.swiftlint.yml', '.swiftlint.yaml'], 'SwiftLint'],
      [['.swiftformat', '.swift-format'], 'SwiftFormat'],
      [['detekt.yml', 'config/detekt/detekt.yml', 'detekt-config.yml'], 'detekt'],
      [['analysis_options.yaml'], 'Dart analyzer'],
      [['.clang-format', '.clang-tidy'], 'clang-format / clang-tidy'],
      [['.credo.exs', '.formatter.exs'], 'mix format / credo'],
      [['phpcs.xml', 'phpcs.xml.dist', 'pint.json', '.php-cs-fixer.php', '.php-cs-fixer.dist.php'], 'PHP_CodeSniffer / Pint'],
      [['.pre-commit-config.yaml'], 'pre-commit hooks'],
    ];
    for (const [files, label] of configFiles) {
      if (ctx.hasAnyFile(files)) found(label);
    }

    const pkg = ctx.packageJson;
    if (pkg) {
      if (ctx.hasDependency('vite-plus')) found('vite-plus (oxlint/vp lint)');
      if (ctx.hasDependency('oxlint')) found('oxlint');
      if (ctx.hasDependency('@biomejs/biome')) found('Biome');
      if (ctx.hasDependency('eslint')) found('ESLint');
      if (ctx.hasDependency('prettier')) found('Prettier');
      if (ctx.hasDependency('dprint')) found('dprint');
      if (ctx.hasDependency('oxfmt')) found('oxfmt');
    }

    const pyproject = ctx.readText('pyproject.toml') ?? '';
    if (/\[tool\.ruff/i.test(pyproject)) found('Ruff');
    if (/\[tool\.black\]/i.test(pyproject)) found('Black');
    if (ctx.hasFile('Cargo.toml')) found('cargo fmt / clippy');
    if (ctx.hasFile('go.mod')) found('gofmt / go vet');

    const gradleText = ctx
      .findFiles((f) => /(^|\/)(build\.gradle(\.kts)?|libs\.versions\.toml)$/.test(f) && f.split('/').length <= 3)
      .slice(0, 12)
      .map((f) => ctx.readText(f) ?? '')
      .join('\n');
    if (gradleText) {
      if (/detekt/i.test(gradleText)) found('detekt');
      if (/ktlint/i.test(gradleText)) found('ktlint');
      if (/spotless/i.test(gradleText)) found('Spotless');
      if (/checkstyle/i.test(gradleText)) found('Checkstyle');
      if (stack.frameworks.includes('Android')) found('Android Lint (`./gradlew lint`)');
    }

    // Biome with its linter switched off is a formatter.
    const biome = ctx.readJson<{ linter?: { enabled?: boolean } }>('biome.json') ?? ctx.readJson<{ linter?: { enabled?: boolean } }>('biome.jsonc');
    const biomeLintOff = biome?.linter?.enabled === false;
    const FORMAT_ONLY = /^(Prettier|dprint|oxfmt|Black|SwiftFormat|Spotless|rustfmt \/ clippy)$/;
    const linters = toolsFound.filter((tool) => !FORMAT_ONLY.test(tool) && !(tool === 'Biome' && biomeLintOff) && !tool.startsWith('Android Lint') && tool !== 'pre-commit hooks');
    const formatterOnly = toolsFound.length > 0 && linters.length === 0 && !toolsFound.some((tool) => tool.startsWith('Android Lint'));

    // A `lint` command that runs only the repository's own programs is a check, not a linter.
    const lintCommand = ctx.verify.commands
      .filter((c) => c.kinds.includes('lint') || c.kinds.includes('format'))
      .sort((a, b) => a.kinds.length - b.kinds.length)[0];
    const customLintOnly = toolsFound.length === 0 && lintCommand !== undefined;
    const lintBody = customLintOnly && pkg?.scripts ? pkg.scripts[lintCommand.command.split(' ').pop()!] : undefined;

    // Android Lint ships with the Android Gradle plugin: on its own it formats nothing and knows no Kotlin style.
    const androidLintOnly = toolsFound.length === 1 && toolsFound[0]!.startsWith('Android Lint');
    const noCode = toolsFound.length === 0 && !customLintOnly && ctx.sourceFiles.length === 0;
    const status: CheckResult['status'] = noCode ? 'info' : androidLintOnly || formatterOnly ? 'warn' : toolsFound.length > 0 ? 'pass' : customLintOnly ? 'warn' : 'fail';

    results.push({
      id: 'loop.formatter-linter',
      station: 'loop',
      weight: 20,
      status,
      severity: status === 'fail' ? 'high' : status === 'warn' ? 'medium' : 'low',
      title: {
        en: 'Deterministic formatter & linter',
        pl: 'Deterministyczny formatter i linter',
      },
      evidence:
        androidLintOnly
          ? ['Android Lint is available through the Android Gradle plugin; no formatter or Kotlin linter (ktlint, detekt, Spotless) is configured']
          : formatterOnly
            ? [`Formatter only: ${toolsFound.map((tool) => (tool === 'Biome' && biomeLintOff ? 'Biome (linter disabled in biome.json)' : tool)).join(', ')} — nothing lints the code`]
            : toolsFound.length > 0
            ? [`Configured: ${toolsFound.join(', ')}`]
          : customLintOnly
            ? [`\`${lintCommand.command}\` exists${lintBody ? ` (${lintBody.length > 90 ? `${lintBody.slice(0, 90)}…` : lintBody})` : ''}, but no general-purpose linter or formatter is configured`]
            : noCode
              ? ['No source code detected — nothing to lint']
              : ['No formatter or linter configured (looked for oxlint, Biome, ESLint, Prettier, dprint, Ruff, golangci-lint, SwiftLint, detekt/ktlint, clang-format and similar)'],
      why: {
        en: 'Fast deterministic linters and formatters remove style arguments from agent prompts and catch dead code, unsafe patterns, and formatting noise automatically.',
        pl: 'Szybkie deterministyczne lintery i formattery eliminują dyskusje o stylu z promptów i automatycznie wyłapują martwy kod oraz ryzykowne wzorce.',
      },
      fix: {
        en: `Configure a fast linter and formatter for ${stack.languages[0] ?? 'your stack'} (${linterSuggestion(stack.languages)}) and run them in the verify command and in CI.`,
        pl: `Skonfiguruj szybki linter i formatter dla ${stack.languages[0] ?? 'swojego stosu'} (${linterSuggestion(stack.languages)}) i uruchamiaj je w komendzie weryfikacji oraz w CI.`,
      },
      docsPath: 'workflows/test/',
    });
  }

  // 5. loop.lockfile-reproducibility
  {
    const lockNames = new Set([
      'package-lock.json',
      'npm-shrinkwrap.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      'bun.lockb',
      'deno.lock',
      'uv.lock',
      'poetry.lock',
      'Pipfile.lock',
      'Cargo.lock',
      'go.sum',
      'Gemfile.lock',
      'composer.lock',
      'gradle.lockfile',
      'packages.lock.json',
      'pubspec.lock',
      'mix.lock',
      'Package.resolved',
      'Podfile.lock',
      'flake.lock',
    ]);
    const isLock = (f: string): boolean => lockNames.has(f.split('/').pop()!) && f.split('/').length <= 6;
    // A lockfile that is on disk but not committed pins nothing for a teammate or for CI.
    const lockfiles = ctx.findFiles((f) => isLock(f) && ctx.isTracked(f) !== false).slice(0, 4);
    const uncommittedLocks = ctx.findFiles((f) => isLock(f) && ctx.isTracked(f) === false).slice(0, 3);
    const versionCatalog = ctx.hasFile('gradle/libs.versions.toml');
    const gitignoredResolved =
      lockfiles.length === 0 &&
      stack.languages.includes('Swift') &&
      ctx.ignoredPaths(['Package.resolved', 'App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved']).size > 0;

    const runtimePins: string[] = [];
    for (const f of [
      '.node-version',
      '.nvmrc',
      '.bun-version',
      '.python-version',
      'rust-toolchain.toml',
      'rust-toolchain',
      '.tool-versions',
      'mise.toml',
      '.mise.toml',
      '.ruby-version',
      'global.json',
      '.xcode-version',
      '.swift-version',
      '.java-version',
      '.sdkmanrc',
      'gradle/wrapper/gradle-wrapper.properties',
    ]) {
      if (ctx.hasFile(f)) runtimePins.push(f);
    }
    const pkg = ctx.packageJson;
    if (pkg?.packageManager) runtimePins.push(`package.json packageManager (${pkg.packageManager.split('+')[0]})`);
    // `>=22` admits every later major: a floor, not a pin.
    const engineRanges: string[] = [];
    for (const engine of ['node', 'bun']) {
      const wanted = pkg?.engines?.[engine];
      if (typeof wanted !== 'string') continue;
      if (/^[=v]?\d+(\.\d+){0,2}$/.test(wanted.trim())) runtimePins.push(`package.json engines.${engine} (${wanted})`);
      else engineRanges.push(`engines.${engine} ${wanted}`);
    }
    const goMod = ctx.readText('go.mod');
    if (goMod && /^go\s+\d+\.\d+/m.test(goMod)) runtimePins.push('go.mod go directive');
    if (/^\s*requires-python\s*=/m.test(ctx.readText('pyproject.toml') ?? '')) runtimePins.push('pyproject.toml requires-python');
    if (/swift-tools-version/.test(ctx.readText('Package.swift') ?? '')) runtimePins.push('Package.swift swift-tools-version');
    if (/^\s*sdk\s*:/m.test(ctx.readText('pubspec.yaml') ?? '')) runtimePins.push('pubspec.yaml environment.sdk');
    const ciPins = [...new Set(ctx.ci.workflows.flatMap((w) => w.toolchainPins))].slice(0, 3);
    if (ciPins.length > 0) runtimePins.push(`CI pins ${ciPins.join(', ')}`);

    // make, cmake and xcodebuild build the project; they do not resolve dependencies to lock.
    const resolvesPackages = stack.packageManagers.some((pm) => !['make', 'cmake', 'xcodebuild'].includes(pm));
    // Two JavaScript package managers' lockfiles at the root: each install resolves a different tree.
    const jsLockOwners: Record<string, string> = { 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' };
    const rootJsManagers = [...new Set(lockfiles.filter((f) => f in jsLockOwners).map((f) => jsLockOwners[f]!))];
    const ciInstaller = ctx.ci.workflows
      .map((w) => /\b(npm ci|npm install|pnpm install|yarn install|bun install)\b/.exec(ctx.readText(w.path) ?? '')?.[1])
      .find(Boolean);
    const competingLocks = rootJsManagers.length > 1;
    // Swift packages that declare no external dependency have nothing to resolve.
    const swiftManifests = ctx.findFiles((f) => /(^|\/)Package\.swift$/.test(f) && f.split('/').length <= 4);
    // Remote Swift packages: in Package.swift, in an XcodeGen project.yml, or in the Xcode project itself.
    const projectYml = ctx.readText('project.yml') ?? '';
    const xcodeProjectFile = ctx.findFiles((f) => /\.xcodeproj\/project\.pbxproj$/.test(f))[0];
    const swiftHasDeps =
      swiftManifests.some((f) => /\.package\(\s*(url|id)\s*:/.test(ctx.readText(f) ?? '')) ||
      xcodegenRemotePackages(projectYml) ||
      (xcodeProjectFile !== undefined && /XCRemoteSwiftPackageReference/.test(ctx.readText(xcodeProjectFile) ?? ''));
    // An Xcode project that pulls remote packages resolves dependencies too.
    const hasManager = resolvesPackages || swiftHasDeps;
    const swiftFloating = /^\s+(from|majorVersion|minorVersion|branch):/m.test(projectYml) || swiftManifests.some((f) => /from:\s*"|branch:\s*"|\.upToNext/.test(ctx.readText(f) ?? ''));

    // Each ecosystem with a root manifest needs its own lock: an npm lockfile in a demo folder
    // does not pin the Python core next to it.
    const pyManifest = ctx.hasAnyFile(['pyproject.toml', 'requirements.txt', 'setup.py']);
    const pyLocked =
      ctx.hasAnyFile(['uv.lock', 'poetry.lock', 'Pipfile.lock', 'requirements.lock', 'pdm.lock']) !== undefined ||
      (ctx.hasFile('requirements.txt') &&
        (ctx.readText('requirements.txt') ?? '')
          .split(/\r?\n/)
          .filter((l) => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('-'))
          .every((l) => /==/.test(l)));
    const pythonFloats = pyManifest !== undefined && !pyLocked;
    const rootJsManifest = ctx.packageJson !== null;
    const rootJsLock = lockfiles.some((f) => f in jsLockOwners);
    const jsFloats = rootJsManifest && !rootJsLock && Object.keys({ ...ctx.packageJson?.dependencies, ...ctx.packageJson?.devDependencies }).length > 0;
    const evidence: string[] = [];
    if (lockfiles.length > 0) evidence.push(`Lockfile(s): ${lockfiles.join(', ')}`);
    else if (versionCatalog) evidence.push('Gradle version catalog pins direct dependencies (gradle/libs.versions.toml); transitive versions are not locked (no gradle.lockfile)');
    else if (hasManager) evidence.push('No committed dependency lockfile found');
    if (uncommittedLocks.length > 0) evidence.push(`On disk but not committed: ${uncommittedLocks.join(', ')}`);
    if (pythonFloats) evidence.push(`Python dependencies are not locked: ${pyManifest} without uv.lock / poetry.lock / pinned requirements`);
    if (jsFloats && lockfiles.length > 0) evidence.push('package.json at the root has dependencies but no lockfile next to it');
    if (swiftHasDeps && swiftFloating && lockfiles.every((f) => !f.endsWith('Package.resolved'))) {
      evidence.push('Remote Swift packages use version ranges (`from:` / branch) and no Package.resolved is committed');
    }
    if (competingLocks) {
      evidence.push(`Lockfiles from ${rootJsManagers.length} package managers at the root (${rootJsManagers.join(', ')})${ciInstaller ? `; CI installs with \`${ciInstaller}\`` : ''} — keep one`);
    }
    if (gitignoredResolved) evidence.push('.gitignore excludes Package.resolved — Swift package versions float between machines and CI');
    evidence.push(
      runtimePins.length > 0
        ? `Toolchain pin(s): ${runtimePins.slice(0, 5).join(', ')}`
        : `No pinned toolchain version (.node-version, packageManager, engines, .python-version, rust-toolchain.toml, Gradle wrapper, .xcode-version, mise.toml)${engineRanges.length > 0 ? `; ${engineRanges.join(', ')} is a range, not a pin` : ''}`,
    );

    const locked = lockfiles.length > 0 || versionCatalog;
    let status: CheckResult['status'];
    const nothingToLock = swiftManifests.length > 0 && !swiftHasDeps && !locked && !stack.packageManagers.some((pm) => !['swiftpm', 'xcodebuild'].includes(pm));
    const ecosystemFloats = pythonFloats || (jsFloats && lockfiles.length > 0);
    if (nothingToLock) {
      // The answer does not depend on a lockfile; a pinned toolchain is still worth having.
      status = runtimePins.length > 0 ? 'pass' : 'warn';
      evidence[0] = `${swiftManifests.slice(0, 2).join(', ')} declare no external dependencies — nothing to lock`;
    } else if (!hasManager && !locked && runtimePins.length === 0) {
      status = 'info';
      evidence.length = 0;
      evidence.push('No dependency manifest detected — nothing to lock');
    } else if (locked && runtimePins.length > 0) {
      status = competingLocks || ecosystemFloats ? 'warn' : 'pass';
    } else if (locked || runtimePins.length > 0) {
      status = 'warn';
    } else {
      status = 'fail';
    }

    // Dependencies committed as source: the lockfile no longer decides what runs, and every bump
    // rewrites thousands of files an agent then has to read past.
    if (ctx.committedNodeModules > 0) {
      evidence.push(`node_modules/ is committed (${ctx.committedNodeModules} tracked files): add it to .gitignore and \`git rm -r --cached node_modules\``);
      if (status === 'pass' || status === 'info') status = 'warn';
    }

    const lockAdvice: LocalizedText = stack.languages.includes('Swift')
      ? { en: 'commit `Package.resolved`', pl: 'zacommituj `Package.resolved`' }
      : stack.packageManagers.includes('gradle')
        ? {
            en: 'keep the Gradle wrapper and version catalog committed (add `gradle.lockfile` if transitive drift bites)',
            pl: 'trzymaj w repozytorium wrapper Gradle i katalog wersji (dodaj `gradle.lockfile`, jeśli doskwiera dryf zależności przechodnich)',
          }
        : { en: 'commit the lockfile your package manager writes', pl: 'zacommituj plik blokady tworzony przez menedżer pakietów' };
    const pinAdvice: LocalizedText = stack.languages.includes('Swift')
      ? { en: '`.xcode-version`', pl: '`.xcode-version`' }
      : stack.packageManagers.includes('gradle')
        ? {
            en: 'the Gradle wrapper plus a JDK toolchain (`.java-version` or `jvmToolchain`)',
            pl: 'wrapper Gradle oraz toolchain JDK (`.java-version` lub `jvmToolchain`)',
          }
        : pkg
          ? {
              en: '`packageManager` in package.json plus `.node-version` / `.bun-version`',
              pl: '`packageManager` w package.json oraz `.node-version` / `.bun-version`',
            }
          : {
              en: 'the file your toolchain reads (`.python-version`, `rust-toolchain.toml`, `mise.toml`)',
              pl: 'plik czytany przez Twój toolchain (`.python-version`, `rust-toolchain.toml`, `mise.toml`)',
            };

    results.push({
      id: 'loop.lockfile-reproducibility',
      station: 'loop',
      weight: 15,
      status,
      severity: status === 'fail' ? 'high' : status === 'warn' ? 'medium' : 'low',
      title: {
        en: 'Lockfile & runtime reproducibility',
        pl: 'Plik blokady zależności i przypięta wersja runtime',
      },
      evidence,
      why: {
        en: 'Unpinned dependencies and runtimes cause "works on my laptop, red in agent sandbox/CI" drift that wastes agent retry budgets.',
        pl: 'Nieprzypięte zależności i wersje runtime powodują błędy „działa u mnie, pada w piaskownicy/CI", które marnują budżet prób agenta.',
      },
      fix: {
        en: pythonFloats
          ? 'Lock the Python dependencies: `uv lock` (or `pip-compile` to a pinned requirements file) and commit the result; pin the interpreter with `.python-version`.'
          : competingLocks
            ? `Keep one package manager: delete the lockfile CI does not install from${ciInstaller ? ` (CI runs \`${ciInstaller}\`)` : ''} and declare the manager in \`packageManager\`.`
            : `Make a fresh checkout reproducible: ${lockAdvice.en}, and pin the toolchain with ${pinAdvice.en}.`,
        pl: pythonFloats
          ? 'Zablokuj zależności Pythona: `uv lock` (lub `pip-compile` do przypiętego pliku requirements) i zacommituj wynik; przypnij interpreter przez `.python-version`.'
          : competingLocks
            ? `Zostaw jeden menedżer pakietów: usuń lockfile, z którego CI nie instaluje${ciInstaller ? ` (CI uruchamia \`${ciInstaller}\`)` : ''}, i zadeklaruj menedżer w \`packageManager\`.`
            : `Zadbaj o powtarzalność świeżego checkoutu: ${lockAdvice.pl} i przypnij toolchain przez ${pinAdvice.pl}.`,
      },
      docsPath: 'workflows/harness/ephemeral-environments/',
    });
  }

  return results;
}

function linterSuggestion(languages: string[]): string {
  const lang = languages[0];
  switch (lang) {
    case 'TypeScript':
    case 'JavaScript':
      return 'Biome, or oxlint with dprint/Prettier';
    case 'Python':
      return 'Ruff';
    case 'Go':
      return 'golangci-lint with gofmt';
    case 'Rust':
      return 'clippy with rustfmt';
    case 'Swift':
      return 'SwiftLint with SwiftFormat';
    case 'Kotlin':
    case 'Java':
      return 'detekt or ktlint, with Spotless';
    case 'Ruby':
      return 'RuboCop';
    case 'PHP':
      return 'Pint or PHP_CodeSniffer with PHPStan';
    case 'Dart':
      return '`dart analyze` with `dart format`';
    case 'C/C++':
      return 'clang-tidy with clang-format';
    case 'Elixir':
      return 'Credo with `mix format`';
    case 'C#':
      return '`dotnet format` with analyzers';
    default:
      return 'the standard linter and formatter for the language';
  }
}

import type { RepoContext } from '../fs-scanner.js';
import type { CheckResult } from '../types.js';

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
        en: 'Commit a standard project manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, etc.) at the repo root.',
        pl: 'Dodaj standardowy manifest projektu (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml` itp.) w katalogu głównym repozytorium.',
      },
      docsPath: 'workflows/harness/agent-ready-codebase/',
    });
  }

  // 2. loop.single-command-verify
  {
    const scripts = stack.verifyScripts;
    const hasUnified = scripts.some((s) => /^(check|verify|ci|make check|make verify|just check|just verify)$/.test(s));
    const hasTest = scripts.some((s) => /\btest\b/.test(s)) || ctx.hasFile('Cargo.toml') || ctx.hasFile('go.mod') || ctx.hasFile('pyproject.toml');
    const hasLintOrType = scripts.some((s) => /\b(lint|typecheck|type-check|check|verify)\b/.test(s));
    const hasBuild = scripts.some((s) => /\bbuild\b/.test(s)) || ctx.hasFile('Cargo.toml') || ctx.hasFile('go.mod');

    // Check whether root brief documents verify commands
    const brief = `${ctx.readText('AGENTS.md') ?? ''}\n${ctx.readText('CLAUDE.md') ?? ''}`;
    const briefMentionsVerify = /\b(npm run |pnpm |yarn |bun |vp |pytest|cargo test|go test|make |just )/i.test(brief);

    const evidence: string[] = [];
    if (scripts.length > 0) evidence.push(`Detected verify scripts: ${scripts.join(', ')}`);
    else evidence.push('No standard verify/test/lint/typecheck/build scripts detected in package.json, Makefile, or justfile');
    if (brief.trim().length > 0) {
      evidence.push(
        briefMentionsVerify
          ? 'Root instructions document runnable verification commands'
          : 'Root instructions do NOT list exact verification commands',
      );
    }

    let status: CheckResult['status'] = 'fail';
    if ((hasUnified || (hasTest && hasLintOrType && hasBuild)) && (briefMentionsVerify || brief.trim().length === 0)) {
      status = 'pass';
    } else if (hasTest || hasLintOrType || scripts.length >= 2) {
      status = 'warn';
    }

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
        en: 'Level 3–4 autonomy depends on a machine-checkable stop condition (typecheck + lint + test + build exiting 0) documented right where agents read it.',
        pl: 'Autonomia Poziomu 3–4 wymaga maszynowo sprawdzalnego warunku stopu (typecheck + lint + test + build kończące się kodem 0), opisanego w instrukcjach agenta.',
      },
      fix: {
        en: 'Expose unified `typecheck`, `lint`, `test`, and `build` (or a single `verify`/`check`) command in `package.json`/`Makefile`/`justfile` and copy those exact commands into `AGENTS.md`.',
        pl: 'Udostępnij ujednolicone komendy `typecheck`, `lint`, `test` i `build` (lub jedną komendę `verify`/`check`) w `package.json`/`Makefile`/`justfile` i wpisz je dokładnie do `AGENTS.md`.',
      },
      docsPath: 'ladder/level-4-write-specs/',
    });
  }

  // 3. loop.static-types
  {
    const evidence: string[] = [];
    let status: CheckResult['status'] = 'fail';

    const nativeTyped = stack.languages.filter((l) => ['Go', 'Rust', 'Java', 'Kotlin', 'C#', 'Swift'].includes(l));
    if (ctx.hasFile('tsconfig.json')) {
      const tsconfig = ctx.readJson<{ compilerOptions?: Record<string, unknown>; extends?: string }>('tsconfig.json');
      const strict = tsconfig?.compilerOptions?.['strict'] === true;
      const extendsConfig = tsconfig?.extends;
      const impliesStrict = typeof extendsConfig === 'string' && /strict/i.test(extendsConfig);
      if (strict || impliesStrict) {
        status = 'pass';
        evidence.push(
          strict
            ? 'tsconfig.json has `compilerOptions.strict: true`'
            : `tsconfig.json extends strict preset (${extendsConfig})`,
        );
      } else {
        status = 'warn';
        evidence.push('tsconfig.json exists, but `compilerOptions.strict` is not enabled');
      }
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
      fix: {
        en: 'Enable strict typechecking (`strict: true` in `tsconfig.json`, `pyright`/`mypy` for Python, `phpstan` for PHP) and wire it into your verify command and CI.',
        pl: 'Włącz ścisłe typowanie (`strict: true` w `tsconfig.json`, `pyright`/`mypy` w Pythonie, `phpstan` w PHP) i podepnij je do komendy weryfikacji oraz CI.',
      },
      docsPath: 'workflows/test/',
    });
  }

  // 4. loop.formatter-linter
  {
    const toolsFound: string[] = [];
    const configFiles: Array<[string[], string]> = [
      [['biome.json', 'biome.jsonc'], 'Biome'],
      [['dprint.json', '.dprint.json'], 'dprint'],
      [['.oxlintrc.json', 'oxlint.json'], 'oxlint'],
      [['eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs', '.eslintrc.yml'], 'ESLint'],
      [['.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.yml', 'prettier.config.js', 'prettier.config.mjs'], 'Prettier'],
      [['ruff.toml', '.ruff.toml'], 'Ruff'],
      [['.golangci.yml', '.golangci.yaml'], 'golangci-lint'],
      [['rustfmt.toml', '.rustfmt.toml'], 'rustfmt'],
      [['.rubocop.yml'], 'RuboCop'],
    ];

    for (const [files, label] of configFiles) {
      if (ctx.hasAnyFile(files)) toolsFound.push(label);
    }

    const pkg = ctx.packageJson;
    if (pkg) {
      if (ctx.hasDependency('vite-plus')) toolsFound.push('vite-plus (oxlint/vp lint)');
      if (ctx.hasDependency('oxlint') && !toolsFound.includes('oxlint')) toolsFound.push('oxlint');
      if (ctx.hasDependency('@biomejs/biome') && !toolsFound.includes('Biome')) toolsFound.push('Biome');
      if (ctx.hasDependency('eslint') && !toolsFound.includes('ESLint')) toolsFound.push('ESLint');
      if (ctx.hasDependency('prettier') && !toolsFound.includes('Prettier')) toolsFound.push('Prettier');
      if (ctx.hasDependency('dprint') && !toolsFound.includes('dprint')) toolsFound.push('dprint');
    }

    const pyproject = ctx.readText('pyproject.toml') ?? '';
    if (/\[tool\.ruff\]/i.test(pyproject) && !toolsFound.includes('Ruff')) toolsFound.push('Ruff');
    if (/\[tool\.black\]/i.test(pyproject)) toolsFound.push('Black');
    if (ctx.hasFile('Cargo.toml')) toolsFound.push('cargo fmt / clippy');
    if (ctx.hasFile('go.mod')) toolsFound.push('gofmt / go vet');

    const status: CheckResult['status'] = toolsFound.length > 0 ? 'pass' : 'fail';

    results.push({
      id: 'loop.formatter-linter',
      station: 'loop',
      weight: 20,
      status,
      severity: status === 'fail' ? 'high' : 'low',
      title: {
        en: 'Deterministic formatter & linter',
        pl: 'Deterministyczny formatter i linter',
      },
      evidence:
        toolsFound.length > 0
          ? [`Configured: ${[...new Set(toolsFound)].join(', ')}`]
          : ['No formatter or linter config detected (oxlint, Biome, ESLint, Prettier, dprint, Ruff, golangci-lint, etc.)'],
      why: {
        en: 'Fast deterministic linters and formatters remove style arguments from agent prompts and catch dead code, unsafe patterns, and formatting noise automatically.',
        pl: 'Szybkie deterministyczne lintery i formattery eliminują dyskusje o stylu z promptów i automatycznie wyłapują martwy kod oraz ryzykowne wzorce.',
      },
      fix: {
        en: 'Configure a fast linter and formatter (e.g., Biome, oxlint + dprint/Prettier, Ruff, golangci-lint) and run them in your local verify script and CI.',
        pl: 'Skonfiguruj szybki linter i formatter (np. Biome, oxlint + dprint/Prettier, Ruff, golangci-lint) i uruchamiaj je w lokalnym skrypcie weryfikacji oraz CI.',
      },
      docsPath: 'workflows/test/',
    });
  }

  // 5. loop.lockfile-reproducibility
  {
    const lockfiles = [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      'bun.lockb',
      'uv.lock',
      'poetry.lock',
      'Pipfile.lock',
      'Cargo.lock',
      'go.sum',
      'Gemfile.lock',
      'composer.lock',
      'gradle.lockfile',
      'packages.lock.json',
    ].filter((f) => ctx.hasFile(f));

    const runtimePins: string[] = [];
    for (const f of [
      '.node-version',
      '.nvmrc',
      '.python-version',
      'rust-toolchain.toml',
      'rust-toolchain',
      '.tool-versions',
      'mise.toml',
      '.ruby-version',
      'global.json',
    ]) {
      if (ctx.hasFile(f)) runtimePins.push(f);
    }
    if (ctx.packageJson?.engines?.['node']) {
      runtimePins.push(`package.json engines.node (${ctx.packageJson.engines['node']})`);
    }
    const goMod = ctx.readText('go.mod');
    if (goMod && /^go\s+\d+\.\d+/m.test(goMod)) {
      runtimePins.push('go.mod go directive');
    }

    const evidence: string[] = [];
    evidence.push(
      lockfiles.length > 0 ? `Lockfile(s): ${lockfiles.join(', ')}` : 'No committed dependency lockfile found',
    );
    evidence.push(
      runtimePins.length > 0
        ? `Runtime pin(s): ${runtimePins.join(', ')}`
        : 'No pinned runtime version (.node-version, .nvmrc, engines, .python-version, rust-toolchain.toml, mise.toml)',
    );

    const status: CheckResult['status'] =
      lockfiles.length > 0 && runtimePins.length > 0
        ? 'pass'
        : lockfiles.length > 0 || runtimePins.length > 0
          ? 'warn'
          : 'fail';

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
        en: 'Commit your lockfile and pin the runtime version (e.g., `.node-version` + `engines`, `.python-version`, `rust-toolchain.toml`, or `mise.toml`).',
        pl: 'Zacommituj plik blokady zależności (lockfile) i przypnij wersję środowiska uruchomieniowego (np. `.node-version` + `engines`, `.python-version`, `rust-toolchain.toml` lub `mise.toml`).',
      },
      docsPath: 'workflows/harness/ephemeral-environments/',
    });
  }

  return results;
}

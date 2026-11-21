import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runDeepReview } from './deep.js';
import { RepoContext } from './fs-scanner.js';
import { TOOL_VERSION, UI } from './i18n.js';
import { auditRepo } from './index.js';
import { initHarness } from './init.js';
import { runInteractiveInterview } from './interview.js';
import { generateFixPrompt } from './prompt-gen.js';
import { renderReport } from './renderers/index.js';
import type { InterviewRole, Lang, OutputFormat, SupportedTool } from './types.js';

interface ParsedArgs {
  command: 'audit' | 'init';
  targetPath: string;
  format: OutputFormat;
  out?: string;
  lang: Lang;
  ci: boolean;
  minScore?: number;
  noPromo: boolean;
  interview: boolean;
  role: InterviewRole;
  deep: boolean;
  prompt: boolean;
  dryRun: boolean;
  force: boolean;
  tools?: SupportedTool[];
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'audit',
    targetPath: '.',
    format: 'terminal',
    lang: 'en',
    ci: false,
    noPromo: false,
    interview: false,
    role: 'dev',
    deep: false,
    prompt: false,
    dryRun: false,
    force: false,
    help: false,
    version: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--version' || token === '-v') {
      args.version = true;
    } else if (token === '--ci') {
      args.ci = true;
    } else if (token === '--no-promo') {
      args.noPromo = true;
    } else if (token === '--interview') {
      args.interview = true;
    } else if (token === '--deep') {
      args.deep = true;
    } else if (token === '--prompt') {
      args.prompt = true;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token === '--force') {
      args.force = true;
    } else if (token === '--format' || token.startsWith('--format=')) {
      const val = token.includes('=') ? token.split('=')[1] : argv[++i];
      if (val === 'terminal' || val === 'md' || val === 'html' || val === 'json') {
        args.format = val;
      } else {
        throw new Error(`Invalid --format value: ${val}. Expected terminal | md | html | json.`);
      }
    } else if (token === '--out' || token.startsWith('--out=')) {
      const val = token.includes('=') ? token.split('=')[1] : argv[++i];
      if (!val) throw new Error('Missing value for --out');
      args.out = val;
    } else if (token === '--lang' || token.startsWith('--lang=')) {
      const val = token.includes('=') ? token.split('=')[1] : argv[++i];
      if (val === 'en' || val === 'pl') {
        args.lang = val;
      } else {
        throw new Error(`Invalid --lang value: ${val}. Expected en | pl.`);
      }
    } else if (token === '--min-score' || token.startsWith('--min-score=')) {
      const val = token.includes('=') ? token.split('=')[1] : argv[++i];
      const num = Number(val);
      if (!Number.isFinite(num) || num < 0 || num > 100) {
        throw new Error(`Invalid --min-score value: ${val}. Expected number 0–100.`);
      }
      args.minScore = num;
    } else if (token === '--role' || token.startsWith('--role=')) {
      const val = token.includes('=') ? token.split('=')[1] : argv[++i];
      if (val === 'dev' || val === 'lead' || val === 'cto') {
        args.role = val;
      } else {
        throw new Error(`Invalid --role value: ${val}. Expected dev | lead | cto.`);
      }
    } else if (token === '--tools' || token.startsWith('--tools=')) {
      const val = token.includes('=') ? token.split('=')[1] : argv[++i];
      if (!val) throw new Error('Missing value for --tools');
      const list = val.split(',').map((s) => s.trim()).filter(Boolean);
      const valid: SupportedTool[] = [];
      for (const item of list) {
        if (item === 'claude-code' || item === 'cursor' || item === 'codex') {
          valid.push(item);
        } else {
          throw new Error(`Invalid tool in --tools: ${item}. Expected claude-code, cursor, codex.`);
        }
      }
      args.tools = valid;
    } else if (token.startsWith('-')) {
      throw new Error(`Unknown flag: ${token}`);
    } else {
      positional.push(token);
    }
  }

  if (positional[0] === 'init') {
    args.command = 'init';
    args.targetPath = positional[1] ?? '.';
  } else if (positional[0]) {
    args.targetPath = positional[0];
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return;
  }
  if (args.help) {
    process.stdout.write(UI.cliHelp[args.lang]);
    return;
  }

  if (args.command === 'init') {
    const result = initHarness(args.targetPath, {
      dryRun: args.dryRun,
      force: args.force,
      tools: args.tools,
      lang: args.lang,
    });

    const header = result.dryRun
      ? `[dry-run] Planned harness scaffold for ${result.repoPath} (tools: ${result.tools.join(', ')})`
      : `Scaffolded harness files in ${result.repoPath} (tools: ${result.tools.join(', ')})`;
    process.stdout.write(`${header}\n`);
    for (const a of result.actions) {
      const sym = a.action === 'skip' ? 'SKIP' : a.action === 'overwrite' ? 'OVERWRITE' : 'CREATE';
      process.stdout.write(`  [${sym}] ${a.path} — ${a.reason}\n`);
    }
    return;
  }

  // Default: audit command
  const interviewResult = args.interview
    ? await runInteractiveInterview(args.role, args.lang)
    : undefined;

  let report = auditRepo(args.targetPath, {
    lang: args.lang,
    role: args.role,
    interview: interviewResult,
  });

  if (args.deep) {
    const ctx = new RepoContext(args.targetPath);
    const deepResult = await runDeepReview(ctx, report.checks, args.lang);
    report = { ...report, deepReview: deepResult };
  }

  const output = args.prompt
    ? generateFixPrompt(report, args.lang)
    : renderReport(report, args.format, {
        lang: args.lang,
        ci: args.ci,
        noPromo: args.noPromo,
      });

  if (args.out) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, output, 'utf8');
    if (!args.ci) {
      process.stderr.write(`Wrote report to ${outPath}\n`);
    }
  } else {
    process.stdout.write(output);
  }

  if (args.minScore !== undefined && report.overallScore < args.minScore) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`harness-audit error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
});

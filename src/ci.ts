import { CommandClassifier, sortKinds, type VerifyKind } from './capabilities.js';
import type { RepoContext } from './fs-scanner.js';

export interface WorkflowFacts {
  path: string;
  /** Runs for pull requests / merge requests, directly or because a PR workflow calls it. */
  onPullRequest: boolean;
  /** Verify commands the workflow runs on any trigger. */
  commands: string[];
  kinds: Set<VerifyKind>;
  /** Commands that publish or deploy for real (`--dry-run` invocations are not deploys). */
  deployCommands: string[];
  /** A deploy job waits for other jobs, an environment approval, or a manual/branch trigger. */
  deployGated: boolean;
  /** Toolchain versions the workflow pins, e.g. `java-version: 17`. */
  toolchainPins: string[];
}

export interface CiFacts {
  files: string[];
  workflows: WorkflowFacts[];
  /** What a pull request has to pass before merge, across every PR-triggered workflow. */
  prKinds: Set<VerifyKind>;
  /** The PR-triggered commands that provide `prKinds`, for evidence. */
  prCommands: Array<{ path: string; command: string; kinds: VerifyKind[] }>;
}

const DEPLOY_COMMAND =
  /\b(?:wrangler\s+(?:deploy|publish|pages\s+deploy)|vercel\s+(?:deploy|--prod)|netlify\s+deploy|flyctl\s+deploy|fly\s+deploy|kubectl\s+apply|helm\s+upgrade|terraform\s+apply|npm\s+publish|pnpm\s+publish|bun\s+publish|cargo\s+publish|twine\s+upload|gh\s+release\s+create|fastlane\s+(?:\S+\s+)?(?:release|deploy|beta|upload\w*)|firebase\s+deploy|aws\s+s3\s+sync|docker\s+push|eas\s+submit)\b/;

const DEPLOY_ACTION =
  /uses:\s*(?:cloudflare\/wrangler-action|cloudflare\/pages-action|amondnet\/vercel-action|superfly\/flyctl-actions|docker\/build-push-action|softprops\/action-gh-release|pypa\/gh-action-pypi-publish|JamesIves\/github-pages-deploy-action|actions\/deploy-pages)/i;

const TOOLCHAIN_PIN = /^\s*(java-version|node-version|python-version|go-version|xcode-version|bun-version|ruby-version|dotnet-version|flutter-version|swift-version)\s*:\s*['"]?([^'"#\s]+)/;

const PR_TRIGGER = /(^|\n)\s*(?:-\s*)?pull_request(?:_target)?\s*:?|on:\s*\[?[^\n]*\bpull_request\b|merge_request_event|\bmerge_requests\b/;

/** `uses:` actions that are a check in themselves. */
const ACTION_KINDS: ReadonlyArray<readonly [RegExp, VerifyKind[]]> = [
  [/golangci\/golangci-lint-action|super-linter|reviewdog\/|oxsecurity\/megalinter|norio-nomura\/action-swiftlint/i, ['lint']],
  [/pre-commit\/action/i, ['lint', 'format']],
  [/cypress-io\/github-action/i, ['test']],
];

function stripComments(yaml: string): string {
  return yaml
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

interface Step {
  command: string;
  /** The command as a pull request runs it: empty when the step is guarded off PRs. */
  prCommand: string;
}

/** `run:` bodies of a GitHub Actions workflow, single-line and block scalars alike. */
function extractRunSteps(yaml: string): Step[] {
  const lines = yaml.split(/\r?\n/);
  const steps: Step[] = [];
  let pendingIfOffPr = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const stepStart = /^\s*-\s+\w/.test(line);
    if (stepStart) pendingIfOffPr = false;
    if (/^\s*(?:-\s+)?if:.*github\.event_name\s*!=\s*'pull_request'/.test(line)) pendingIfOffPr = true;

    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length + (/^\s*-\s+run:/.test(line) ? 2 : 0);
    let body = m[2]!.trim();
    if (/^[|>][+-]?\d*$/.test(body)) {
      const block: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() !== '' && next.length - next.trimStart().length <= indent) break;
        block.push(next.trim());
        i++;
      }
      body = block.join('\n');
    } else {
      body = body.replace(/^(['"])(.*)\1$/, '$2');
    }
    // An inline `${{ event != 'pull_request' && 'lint' || '' }}` adds its argument only off PRs.
    const offPrExpr = /\$\{\{[^}]*github\.event_name\s*!=\s*'pull_request'[^}]*\}\}/g;
    // Off a PR the expression yields its quoted argument; keep that word so the full command reads right.
    const full = body.replace(offPrExpr, (expr) => /&&\s*'([^']*)'/.exec(expr)?.[1] ?? '');
    steps.push({ command: full, prCommand: pendingIfOffPr ? '' : body.replace(offPrExpr, '') });
  }
  return steps;
}

/** Commands from CI systems that are not GitHub Actions: every line that could be a command. */
function extractLooseCommands(text: string): Step[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^-\s+/, '').replace(/^(?:run|script|command|bash|sh)\s*:?\s*/, '').replace(/^['"]|['"]\)?$/g, ''))
    .filter((l) => l.length > 2 && l.length < 300)
    .map((command) => ({ command, prCommand: command }));
}

export function analyzeCi(ctx: RepoContext): CiFacts {
  const classifier = new CommandClassifier(ctx);
  const ghWorkflows = ctx.findFiles((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const otherCi = ['.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml', '.buildkite/pipeline.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml', '.woodpecker.yml'].filter(
    (f) => ctx.hasFile(f),
  );
  const files = [...ghWorkflows, ...otherCi];

  const raw = new Map<string, { text: string; steps: Step[]; calls: string[]; prTriggered: boolean }>();
  for (const path of files) {
    const text = stripComments(ctx.readText(path) ?? '');
    const isGh = path.startsWith('.github/workflows/');
    const steps = isGh ? extractRunSteps(text) : extractLooseCommands(text);
    const calls: string[] = [];
    for (const m of text.matchAll(/uses:\s*\.\/(\.github\/(?:workflows\/[^\s@'"]+|actions\/[^\s@'"]+))/g)) {
      const target = m[1]!;
      calls.push(/\.ya?ml$/.test(target) ? target : `${target.replace(/\/$/, '')}/action.yml`);
    }
    // GitLab, CircleCI and friends run their pipeline for merge requests unless told otherwise.
    raw.set(path, { text, steps, calls, prTriggered: isGh ? PR_TRIGGER.test(text) : true });
  }

  // Composite actions a workflow calls contribute their steps to the caller.
  const calledSteps = (path: string, seen: Set<string>): Step[] => {
    if (seen.has(path)) return [];
    seen.add(path);
    const known = raw.get(path);
    if (known) return [...known.steps, ...known.calls.flatMap((c) => calledSteps(c, seen))];
    const text = ctx.readText(path) ?? ctx.readText(path.replace(/\.yml$/, '.yaml'));
    return text ? extractRunSteps(stripComments(text)) : [];
  };

  const calledByPr = new Set<string>();
  for (const [path, wf] of raw) {
    if (!wf.prTriggered) continue;
    const stack = [...wf.calls];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (calledByPr.has(next)) continue;
      calledByPr.add(next);
      stack.push(...(raw.get(next)?.calls ?? []));
    }
    void path;
  }

  const workflows: WorkflowFacts[] = [];
  const prKinds = new Set<VerifyKind>();
  const prCommands: CiFacts['prCommands'] = [];

  for (const [path, wf] of raw) {
    const onPullRequest = wf.prTriggered || calledByPr.has(path);
    const steps = [...wf.steps, ...wf.calls.flatMap((c) => calledSteps(c, new Set([path])))];
    const kinds = new Set<VerifyKind>();
    const commands: string[] = [];
    const deployCommands: string[] = [];

    const splitLines = (body: string): string[] => body.split(/\n|&&/).map((l) => l.trim()).filter(Boolean);
    for (const step of steps) {
      for (const cmd of splitLines(step.command)) {
        if (DEPLOY_COMMAND.test(cmd) && !/--dry-run\b|--dry\b/.test(cmd)) deployCommands.push(cmd);
        const cmdKinds = sortKinds(classifier.classify(cmd));
        if (cmdKinds.length === 0) continue;
        commands.push(cmd);
        for (const k of cmdKinds) kinds.add(k);
      }
      if (!onPullRequest) continue;
      for (const cmd of splitLines(step.prCommand)) {
        const cmdKinds = sortKinds(classifier.classify(cmd));
        if (cmdKinds.length === 0) continue;
        prCommands.push({ path, command: cmd.replace(/\s{2,}/g, ' '), kinds: cmdKinds });
        for (const k of cmdKinds) prKinds.add(k);
      }
    }
    for (const [pattern, actionKinds] of ACTION_KINDS) {
      if (!pattern.test(wf.text)) continue;
      for (const k of actionKinds) {
        kinds.add(k);
        if (onPullRequest) prKinds.add(k);
      }
    }
    if (DEPLOY_ACTION.test(wf.text)) deployCommands.push(DEPLOY_ACTION.exec(wf.text)![0].replace(/^uses:\s*/, ''));

    const toolchainPins: string[] = [];
    for (const line of wf.text.split(/\r?\n/)) {
      const pin = TOOLCHAIN_PIN.exec(line);
      if (pin && !pin[2]!.includes('${{') && !toolchainPins.includes(`${pin[1]} ${pin[2]}`)) {
        toolchainPins.push(`${pin[1]} ${pin[2]}`);
      }
    }

    workflows.push({
      path,
      onPullRequest,
      commands,
      kinds,
      deployCommands,
      deployGated: /\bneeds\s*:|\benvironment\s*:|workflow_dispatch|workflow_run|if:\s*[^\n]*github\.ref\b|\bon:\s*\n\s+push:\s*\n\s+(?:branches|tags)\s*:|\brelease\s*:\s*\n\s+types/.test(wf.text),
      toolchainPins,
    });
  }

  return { files, workflows, prKinds, prCommands };
}

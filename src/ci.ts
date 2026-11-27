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
  /** Branches the workflow is filtered to when none of them is the default branch: nothing done there starts it. */
  deadBranches: string[] | undefined;
}

export interface CiFacts {
  files: string[];
  workflows: WorkflowFacts[];
  /** What a pull request has to pass before merge, across every PR-triggered workflow. */
  prKinds: Set<VerifyKind>;
  /** The PR-triggered commands that provide `prKinds`, for evidence. */
  prCommands: Array<{ path: string; command: string; kinds: VerifyKind[] }>;
}

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

/** A condition that is false for a pull request: the step or job runs for pushes, schedules or releases only. */
const OFF_PR = /github\.event_name\s*(?:!=\s*'pull_request'|==\s*'(?:push|schedule|workflow_dispatch|release)')|github\.ref\s*==\s*'refs\/heads\//;

/**
 * `run:` bodies of a GitHub Actions workflow, single-line and block scalars alike. A step or job
 * marked `continue-on-error: true` cannot fail the run, so its commands gate nothing; one whose
 * `if:` excludes pull requests is not part of what a pull request has to pass.
 */
function extractRunSteps(yaml: string): Step[] {
  const lines = yaml.split(/\r?\n/);
  const indentOf = (line: string): number => line.length - line.trimStart().length;
  const offPr = new Array<boolean>(lines.length).fill(false);
  const nonBlocking = new Array<boolean>(lines.length).fill(false);

  // Job level: `if:` and `continue-on-error:` written as direct keys of a job cover all its steps.
  let jobsAt = -1;
  let jobIndent = -1;
  let keyIndent = -1;
  let jobOffPr = false;
  let jobNonBlocking = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const indent = indentOf(line);
    if (/^jobs:\s*$/.test(line)) {
      jobsAt = i;
      jobIndent = -1;
      continue;
    }
    if (jobsAt === -1) continue;
    if (jobIndent === -1) jobIndent = indent;
    if (indent === jobIndent && /^\s*[\w.-]+:\s*$/.test(line)) {
      keyIndent = -1;
      jobOffPr = false;
      jobNonBlocking = false;
      continue;
    }
    if (keyIndent === -1 && indent > jobIndent) keyIndent = indent;
    if (indent === keyIndent) {
      if (/^\s*if:/.test(line) && OFF_PR.test(line)) jobOffPr = true;
      if (/^\s*continue-on-error:\s*true\b/.test(line)) jobNonBlocking = true;
    }
    offPr[i] = jobOffPr;
    nonBlocking[i] = jobNonBlocking;
  }

  // Step level: the keys of one step, wherever they stand relative to its `run:`.
  for (let start = 0; start < lines.length; start++) {
    const dash = /^(\s*)-\s+\w/.exec(lines[start]!);
    if (!dash) continue;
    let end = start + 1;
    while (end < lines.length && (!lines[end]!.trim() || indentOf(lines[end]!) > dash[1]!.length)) end++;
    const block = lines.slice(start, end);
    const stepOffPr = block.some((l) => /^\s*(?:-\s+)?if:/.test(l) && OFF_PR.test(l));
    const stepNonBlocking = block.some((l) => /^\s*(?:-\s+)?continue-on-error:\s*true\b/.test(l));
    for (let i = start; i < end; i++) {
      offPr[i] ||= stepOffPr;
      nonBlocking[i] ||= stepNonBlocking;
    }
  }

  const steps: Step[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!m) continue;
    const runAt = i;
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
    if (nonBlocking[runAt]) continue;
    // An inline `${{ event != 'pull_request' && 'lint' || '' }}` adds its argument only off PRs.
    const offPrExpr = /\$\{\{[^}]*github\.event_name\s*!=\s*'pull_request'[^}]*\}\}/g;
    // Off a PR the expression yields its quoted argument; keep that word so the full command reads right.
    const full = body.replace(offPrExpr, (expr) => /&&\s*'([^']*)'/.exec(expr)?.[1] ?? '');
    steps.push({ command: full, prCommand: offPr[runAt] ? '' : body.replace(offPrExpr, '') });
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

/**
 * The `branches:` filter of each trigger that has one, by event. A workflow can filter pushes to a
 * release branch and still run for every pull request: the two are separate questions.
 */
function branchFiltersByEvent(yaml: string): Map<string, string[]> {
  const filters = new Map<string, string[]>();
  const lines = yaml.split(/\r?\n/);
  const unquote = (b: string): string => b.trim().replace(/^['"]|['"]$/g, '');
  let event: string | undefined;
  let eventIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const header = /^\s*(push|pull_request|pull_request_target)\s*:/.exec(line);
    if (header) {
      event = header[1]!;
      eventIndent = indent;
      continue;
    }
    if (event && indent <= eventIndent) event = undefined;
    if (!event) continue;
    const found: string[] = [];
    const inline = /^\s*branches\s*:\s*\[([^\]]*)\]/.exec(line);
    if (inline) found.push(...inline[1]!.split(',').map(unquote).filter(Boolean));
    else if (/^\s*branches\s*:\s*$/.test(line)) {
      for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]!); j++) found.push(unquote(lines[j]!.trim().replace(/^-\s+/, '')));
    }
    if (found.length > 0) filters.set(event, [...new Set([...(filters.get(event) ?? []), ...found])]);
  }
  return filters;
}

function branchMatches(pattern: string, branch: string): boolean {
  const rx = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+^$()|[\]{}?\\]/g, '\\$&')).join('.*')}$`);
  return rx.test(branch);
}

export function analyzeCi(ctx: RepoContext): CiFacts {
  const classifier = new CommandClassifier(ctx);
  const ghWorkflows = ctx.findFiles((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const otherCi = ['.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml', '.buildkite/pipeline.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml', '.woodpecker.yml'].filter(
    (f) => ctx.hasFile(f),
  );
  const files = [...ghWorkflows, ...otherCi];

  const raw = new Map<string, { text: string; steps: Step[]; calls: string[]; prTriggered: boolean }>();
  const deadBranches = new Map<string, string[]>();
  for (const path of files) {
    const text = stripComments(ctx.readText(path) ?? '');
    const isGh = path.startsWith('.github/workflows/');
    const steps = isGh ? extractRunSteps(text) : extractLooseCommands(text);
    const calls: string[] = [];
    for (const m of text.matchAll(/uses:\s*\.\/(\.github\/(?:workflows\/[^\s@'"]+|actions\/[^\s@'"]+))/g)) {
      const target = m[1]!;
      calls.push(/\.ya?ml$/.test(target) ? target : `${target.replace(/\/$/, '')}/action.yml`);
    }
    // Branch filters, per trigger. Pull requests into the default branch do not start a workflow
    // whose `pull_request` filter leaves that branch out; when its pushes are filtered away too (or
    // it has no push trigger), nothing done on the default branch ever starts it.
    const byEvent = isGh ? branchFiltersByEvent(text) : new Map<string, string[]>();
    const defaultBranch = ctx.git.defaultBranch;
    const excludes = (event: string): boolean => {
      const filter = byEvent.get(event);
      return filter !== undefined && defaultBranch !== undefined && !filter.some((f) => branchMatches(f, defaultBranch));
    };
    // GitLab, CircleCI and friends run their pipeline for merge requests unless told otherwise.
    const prTrigger = isGh ? PR_TRIGGER.test(text) : true;
    const deadForPr = prTrigger && (excludes('pull_request') || excludes('pull_request_target'));
    const hasPush = /(^|\n)\s*push\s*:|\bon:\s*\[?[^\n]*\bpush\b/.test(text);
    const dead = deadForPr && (!hasPush || excludes('push'));
    if (dead) deadBranches.set(path, [...new Set([...(byEvent.get('pull_request') ?? byEvent.get('pull_request_target') ?? []), ...(byEvent.get('push') ?? [])])]);
    raw.set(path, { text, steps, calls, prTriggered: !deadForPr && prTrigger });
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
    // A workflow that never runs proves nothing, on a pull request or anywhere else.
    for (const step of deadBranches.has(path) ? [] : steps) {
      for (const cmd of splitLines(step.command)) {
        // Through the script it calls, too: `npm run ship` deploys when `ship` does.
        if (classifier.deploys(cmd)) deployCommands.push(cmd);
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
      deadBranches: deadBranches.get(path),
    });
  }

  return { files, workflows, prKinds, prCommands };
}

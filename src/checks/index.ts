import type { RepoContext } from '../fs-scanner.js';
import type { CheckResult } from '../types.js';
import { runGraphChecks } from './graph.js';
import { runHarnessChecks } from './harness.js';
import { runIntentChecks } from './intent.js';
import { runLoopChecks } from './loop.js';
import { runReleaseChecks } from './release.js';
import { runVerificationChecks } from './verification.js';

export function runAllChecks(ctx: RepoContext): Array<CheckResult> {
  return [
    ...runIntentChecks(ctx),
    ...runHarnessChecks(ctx),
    ...runLoopChecks(ctx),
    ...runGraphChecks(ctx),
    ...runVerificationChecks(ctx),
    ...runReleaseChecks(ctx),
  ];
}

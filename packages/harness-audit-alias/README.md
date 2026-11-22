# `@wondelai/harness-audit`

[![License: MIT](https://img.shields.io/badge/License-MIT-15803d.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node-%3E%3D20-17151a.svg)](https://nodejs.org/)
[![Zero Runtime Deps](https://img.shields.io/badge/runtime%20deps-0-ff4d00.svg)](#installation--quick-start)

Audit any repository's AI coding agent harness across the **6 Software Factory Stations** and place it on the **Autonomy Ladder (Level 0–5)**. Works with **Claude Code**, **OpenAI Codex**, and **Cursor** — deterministic by default, zero runtime dependencies, zero telemetry, runs in under a second.

Grounded in the open methodology at [developertoolkit.ai](https://developertoolkit.ai/en/ladder/).

---

## Installation & Quick Start

Run directly against the current repository (no install required):

```bash
npx @wondelai/harness-audit
```

Common workflows:

```bash
# Generate a standalone Schematic HTML report to share with your team or CTO
npx @wondelai/harness-audit --format html --out harness-audit.html

# Run in Polish (full native EN + PL copy)
npx @wondelai/harness-audit --lang pl

# Gate CI on a minimum harness score
npx @wondelai/harness-audit --ci --min-score 70 --format json

# Generate a repo-specific remediation prompt for Claude Code, Codex, or Cursor
npx @wondelai/harness-audit --prompt --out HARNESS-FIX-PROMPT.md

# Safely scaffold missing starter files (never overwrites existing files without --force)
npx @wondelai/harness-audit init --dry-run --tools claude-code,cursor,codex

# Add an interactive 7-question Org & Workflow assessment (dev | lead | cto)
npx @wondelai/harness-audit --interview --role lead

# Optional hybrid LLM qualitative pass (uses local claude/codex CLI or API key)
npx @wondelai/harness-audit --deep
```

---

## The 6 Software Factory Stations (30 Deterministic Checks)

Every check inspects real files on disk, emits exact paths/measurements as evidence, and maps to a canonical guide on [developertoolkit.ai](https://developertoolkit.ai/en/ladder/one-map/).

| # | Station | Weight | Decision It Owns | Key Checks |
| --- | --- | --- | --- | --- |
| 1 | **Intent** | 20% | What the agent knows before it starts | `intent.instructions-file`, `intent.single-source`, `intent.instruction-budget`, `intent.scoped-rules`, `intent.skills-and-specs` |
| 2 | **Harness** | 18% | What the agent may run, read, and reach | `harness.permissions-policy`, `harness.hooks`, `harness.mcp-hygiene`, `harness.secret-hygiene`, `harness.sandbox-readiness` |
| 3 | **Loop** | 18% | How fast the agent verifies and when it stops | `loop.stack-detection`, `loop.single-command-verify`, `loop.static-types`, `loop.formatter-linter`, `loop.lockfile-reproducibility` |
| 4 | **Graph** | 10% | How multiple agents run without colliding | `graph.worktree-isolation`, `graph.port-and-state-isolation`, `graph.subagent-definitions`, `graph.workspace-boundaries` |
| 5 | **Verification** | 20% | What counts as proof the agent cannot fake | `verification.unit-tests`, `verification.e2e-tests`, `verification.oracle-protection`, `verification.test-quality-scan`, `verification.automated-pr-review`, `verification.fitness-functions` |
| 6 | **Release** | 14% | How verified work leaves the repository safely | `release.ci-pipeline`, `release.evidence-pr-template`, `release.dependency-automation`, `release.observability-and-safety`, `release.deploy-safety` |

### High-Signal Failure Modes Caught Out of the Box

- **Policy by duplication:** Separate long `AGENTS.md` and `CLAUDE.md` files without a bare `@AGENTS.md` import — and backticked `` `@AGENTS.md` `` lines that Claude Code silently ignores.
- **Retired & dangerous harness configs:** Retired Codex `approval_policy = "untrusted"` (removed in Codex 0.149.0), `bypassPermissions` defaults, and Claude Code `Stop` hooks missing a `stop_hook_active` infinite-loop guard.
- **Broken & leaky MCP configs:** Archived/non-existent npm packages (`@modelcontextprotocol/server-postgres`, `-sqlite`, `-mysql`, `-slack`, `-git`, `-puppeteer`), misplaced `.claude/mcp.json`, deprecated `/sse` endpoints, and hardcoded `Authorization: Bearer` tokens or plaintext API keys.
- **Fake test oracles:** `.only()`, empty test blocks, `expect(true).toBe(true)` tautologies, and `@ts-ignore` / `eslint-disable` sprawl.

---

## Autonomy Ladder (Level 0–5) & Honest Gating Caps

Raw weighted scores map to Levels 0–5 (Dan Shapiro's Autonomy Ladder), **capped by hard safety gates** so a repo with polished markdown instructions but no tests or CI cannot falsely claim Level 4:

| Level | Name | Gating Requirement |
| --- | --- | --- |
| **L0** | By hand | `< 25` |
| **L1** | Assisted | `25–44` (capped at L1 if missing both instructions and verify loop) |
| **L2** | Paired | `45–62` (capped at L2 if missing tests, missing CI, hardcoded secrets, or broken permission config) |
| **L3** | Review manager | `63–77` (capped at L3 if Verification < 70, Loop < 70, CI not passing on PRs, or test quality scan fails) |
| **L4** | Spec manager | `78–89` (capped at L4 unless oracle protection passes, Graph >= 70, Harness >= 75, Release >= 80, Verification >= 85) |
| **L5** | Dark factory | `90–100` with all gating requirements met |

Every triggered cap is printed explicitly in terminal, Markdown, HTML, and JSON outputs.

---

## CLI Reference

```text
harness-audit [path] [options]
  --format terminal|md|html|json   Output format (default: terminal)
  --out <file>                     Write report to file instead of stdout
  --lang en|pl                     Language (default: en)
  --ci                             Suppress decorative banners & next-steps footer
  --min-score <N>                  Exit with code 1 if overallScore < N
  --no-promo                       Hide book & team-services footer
  --interview                      Run 7-question Org & Workflow interview
  --role dev|lead|cto              Tailor interview & guidance (default: dev)
  --deep                           Optional qualitative LLM pass (local CLI or API key)
  --prompt                         Emit tailored HARNESS-FIX-PROMPT.md

harness-audit init [path] [options]
  --dry-run                        Show planned files without writing
  --force                          Overwrite existing files
  --tools claude-code,cursor,codex Tools to scaffold for (default: all)
```

---

## Programmatic Usage

```ts
import { auditRepo, renderMarkdown, generateFixPrompt } from '@wondelai/harness-audit';

const report = auditRepo('/path/to/repo', { lang: 'en', role: 'lead' });
console.log(report.overallScore, report.level, report.levelCaps);
const md = renderMarkdown(report, { noPromo: true });
const fixPrompt = generateFixPrompt(report);
```

---

## Further Reading & Team Support

- **Open methodology & docs:** [The Autonomy Ladder](https://developertoolkit.ai/en/ladder/) · [One Map (Ladder × Lifecycle × Stations)](https://developertoolkit.ai/en/ladder/one-map/) · [Protecting the Test Oracle](https://developertoolkit.ai/en/workflows/test/protect-the-oracle/)
- **Books:** [The AI Engineering Handbook & Role Books (Developer / Tech Lead / CTO)](https://developertoolkit.ai/en/books/)
- **For engineering teams:** [Fixed-price Repo Diagnostic & Team Working Day — Wondel.ai](https://developertoolkit.ai/en/services/)

---

## License

MIT © 2026 Michal Jaskolski / Wondel.ai

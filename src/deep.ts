import { execFileSync } from 'node:child_process';
import type { RepoContext } from './fs-scanner.js';
import { isJsonObject, parseJson } from './json.js';
import type { JsonValue } from './json.js';
import type { CheckResult, DeepFinding, DeepReviewResult, Lang } from './types.js';

const MAX_EXCERPT_CHARS = 5000;

function commandExists(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: 'ignore',
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

export interface DeepPromptPayload {
  prompt: string;
  filesInspected: Array<string>;
}

export function buildDeepPromptPayload(ctx: RepoContext, checks: Array<CheckResult>, lang: Lang): DeepPromptPayload {
  const filesInspected: Array<string> = [];
  const excerpts: Array<string> = [];

  const addExcerpt = (relPath: string, limit = MAX_EXCERPT_CHARS): void => {
    const content = ctx.readText(relPath);
    if (!content) {return;}
    filesInspected.push(relPath);
    const trimmed = content.length > limit ? `${content.slice(0, limit)}\n... [truncated]` : content;
    excerpts.push(`### FILE: ${relPath}\n\`\`\`\n${trimmed}\n\`\`\``);
  };

  if (ctx.hasFile('AGENTS.md')) {addExcerpt('AGENTS.md', 4500);}
  if (ctx.hasFile('CLAUDE.md')) {addExcerpt('CLAUDE.md', 2500);}
  if (ctx.hasFile('.claude/settings.json')) {addExcerpt('.claude/settings.json', 2000);}
  if (ctx.hasFile('.codex/config.toml')) {addExcerpt('.codex/config.toml', 1500);}

  // Sample up to 2 test files
  for (const tf of ctx.testFiles.slice(0, 2)) {
    addExcerpt(tf, 2500);
  }

  const failingSummary = checks
    .flatMap((c) => (c.status === 'fail' || c.status === 'warn' ? [`- [${c.status.toUpperCase()}] ${c.id}: ${c.evidence.join(' | ')}`] : []))
    .join('\n');

  const languageInstruction =
    lang === 'pl'
      ? 'Respond in crisp Polish (engineering register).'
      : 'Respond in crisp English (senior-engineer register).';

  const prompt = `You are reviewing a repository's AI coding agent harness.
${languageInstruction}
Evaluate ONLY what is shown below across three dimensions:
1. Instruction signal-to-noise (contradictions, filler, missing invariants or commands).
2. Test quality in the sampled tests (tautological tests, over-mocking, weak assertions).
3. Architectural legibility & harness blind spots not caught by deterministic file checks.

Return STRICT JSON with this exact shape and NO markdown code fences:
{
  "summary": "2-3 sentence executive synthesis",
  "findings": [
    {
      "area": "instructions" | "tests" | "architecture" | "harness",
      "severity": "high" | "medium" | "low",
      "title": "short concrete title",
      "detail": "specific observation grounded in the excerpts",
      "suggestion": "concrete change to make"
    }
  ]
}
Provide 2 to 5 high-signal findings. Never invent files or commands you did not see.

## Deterministic findings already detected
${failingSummary || '(none)'}

## Bounded repository excerpts
${excerpts.join('\n\n') || '(no instruction or test files present)'}`;

  return { prompt, filesInspected };
}

function field(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return isJsonObject(value) ? value[key] : undefined;
}

function textOf(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** The `text` of every element of a provider's content array, one per line. */
function joinTexts(items: JsonValue | undefined): string {
  return Array.isArray(items) ? items.map((item) => textOf(field(item, 'text'))).join('\n') : '';
}

async function readJsonBody(res: Response): Promise<JsonValue | undefined> {
  const body = parseJson(await res.text());
  if (body === undefined) {throw new Error('Response was not JSON');}
  return body;
}

function parseDeepJson(raw: string): { summary: string; findings: Array<DeepFinding> } | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {return null;}
  const parsed = parseJson(cleaned.slice(start, end + 1));
  if (!isJsonObject(parsed)) {return null;}
  const { summary, findings: rawFindings } = parsed;
  if (typeof summary !== 'string' || !Array.isArray(rawFindings)) {return null;}
  const findings: Array<DeepFinding> = rawFindings
    .filter(isJsonObject)
    .map((f) => ({
      area:
        f['area'] === 'instructions' ||
        f['area'] === 'tests' ||
        f['area'] === 'architecture' ||
        f['area'] === 'harness'
          ? f['area']
          : 'harness',
      severity:
        f['severity'] === 'high' || f['severity'] === 'medium' || f['severity'] === 'low'
          ? f['severity']
          : 'medium',
      title: String(f['title'] ?? 'Qualitative observation'),
      detail: String(f['detail'] ?? ''),
      suggestion: String(f['suggestion'] ?? ''),
    }));
  return { summary, findings };
}

export async function runDeepReview(
  ctx: RepoContext,
  checks: Array<CheckResult>,
  lang: Lang,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeepReviewResult> {
  const { prompt, filesInspected } = buildDeepPromptPayload(ctx, checks, lang);

  // 1. Prefer Anthropic API if key set
  if (env['ANTHROPIC_API_KEY']) {
    try {
      const model = env['HARNESS_AUDIT_MODEL'] || 'claude-sonnet-4-20250514';
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env['ANTHROPIC_API_KEY'],
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1400,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
      const json = await readJsonBody(res);
      const text = joinTexts(field(json, 'content'));
      const parsed = parseDeepJson(text);
      if (parsed) {
        return { provider: 'Anthropic API', model, filesInspected, ...parsed };
      }
      return {
        provider: 'Anthropic API',
        model,
        filesInspected,
        summary: text.slice(0, 600),
        findings: [],
      };
    } catch (error) {
      return {
        provider: 'Anthropic API',
        filesInspected,
        summary: '',
        findings: [],
        error: `Anthropic API call failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // 2. OpenAI API if key set
  if (env['OPENAI_API_KEY']) {
    try {
      const model = env['HARNESS_AUDIT_MODEL'] || 'gpt-4.1-mini';
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env['OPENAI_API_KEY']}`,
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
      const json = await readJsonBody(res);
      const choices = field(json, 'choices');
      const text = Array.isArray(choices) ? textOf(field(field(choices[0], 'message'), 'content')) : '';
      const parsed = parseDeepJson(text);
      if (parsed) {
        return { provider: 'OpenAI API', model, filesInspected, ...parsed };
      }
      return {
        provider: 'OpenAI API',
        model,
        filesInspected,
        summary: text.slice(0, 600),
        findings: [],
      };
    } catch (error) {
      return {
        provider: 'OpenAI API',
        filesInspected,
        summary: '',
        findings: [],
        error: `OpenAI API call failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // 3. Gemini API if key set
  if (env['GEMINI_API_KEY']) {
    try {
      const model = env['HARNESS_AUDIT_MODEL'] || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env['GEMINI_API_KEY'])}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      });
      if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
      const json = await readJsonBody(res);
      const candidates = field(json, 'candidates');
      const text = Array.isArray(candidates) ? joinTexts(field(field(candidates[0], 'content'), 'parts')) : '';
      const parsed = parseDeepJson(text);
      if (parsed) {
        return { provider: 'Gemini API', model, filesInspected, ...parsed };
      }
      return {
        provider: 'Gemini API',
        model,
        filesInspected,
        summary: text.slice(0, 600),
        findings: [],
      };
    } catch (error) {
      return {
        provider: 'Gemini API',
        filesInspected,
        summary: '',
        findings: [],
        error: `Gemini API call failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // 4. Local `claude` CLI (unless explicitly disabled for testing)
  if (!env['HARNESS_AUDIT_NO_LOCAL_CLI'] && commandExists('claude')) {
    try {
      const out = execFileSync('claude', ['-p', prompt, '--tools', ''], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      const parsed = parseDeepJson(out);
      if (parsed) {
        return { provider: 'local claude CLI', filesInspected, ...parsed };
      }
      return {
        provider: 'local claude CLI',
        filesInspected,
        summary: out.trim().slice(0, 600),
        findings: [],
      };
    } catch (error) {
      return {
        provider: 'local claude CLI',
        filesInspected,
        summary: '',
        findings: [],
        error: `Local claude CLI failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // 5. Local `codex` CLI
  if (!env['HARNESS_AUDIT_NO_LOCAL_CLI'] && commandExists('codex')) {
    try {
      const out = execFileSync('codex', ['exec', '--sandbox', 'read-only', prompt], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      const parsed = parseDeepJson(out);
      if (parsed) {
        return { provider: 'local codex CLI', filesInspected, ...parsed };
      }
      return {
        provider: 'local codex CLI',
        filesInspected,
        summary: out.trim().slice(0, 600),
        findings: [],
      };
    } catch (error) {
      return {
        provider: 'local codex CLI',
        filesInspected,
        summary: '',
        findings: [],
        error: `Local codex CLI failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    provider: 'unavailable',
    filesInspected,
    summary: '',
    findings: [],
    error:
      lang === 'pl'
        ? 'Nie znaleziono lokalnego CLI `claude` ani `codex`, ani zmiennych ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY. Pominięto analizę --deep; raport deterministyczny jest kompletny.'
        : 'No local `claude` or `codex` CLI found, and none of ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY is set. Skipping --deep review; the deterministic audit above is complete.',
  };
}

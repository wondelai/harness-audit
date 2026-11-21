import { execFileSync } from 'node:child_process';
import type { RepoContext } from './fs-scanner.js';
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

export function buildDeepPromptPayload(
  ctx: RepoContext,
  checks: CheckResult[],
  lang: Lang,
): { prompt: string; filesInspected: string[] } {
  const filesInspected: string[] = [];
  const excerpts: string[] = [];

  const addExcerpt = (relPath: string, limit = MAX_EXCERPT_CHARS): void => {
    const content = ctx.readText(relPath);
    if (!content) return;
    filesInspected.push(relPath);
    const trimmed = content.length > limit ? `${content.slice(0, limit)}\n... [truncated]` : content;
    excerpts.push(`### FILE: ${relPath}\n\`\`\`\n${trimmed}\n\`\`\``);
  };

  if (ctx.hasFile('AGENTS.md')) addExcerpt('AGENTS.md', 4500);
  if (ctx.hasFile('CLAUDE.md')) addExcerpt('CLAUDE.md', 2500);
  if (ctx.hasFile('.claude/settings.json')) addExcerpt('.claude/settings.json', 2000);
  if (ctx.hasFile('.codex/config.toml')) addExcerpt('.codex/config.toml', 1500);

  // Sample up to 2 test files
  for (const tf of ctx.testFiles.slice(0, 2)) {
    addExcerpt(tf, 2500);
  }

  const failingSummary = checks
    .filter((c) => c.status === 'fail' || c.status === 'warn')
    .map((c) => `- [${c.status.toUpperCase()}] ${c.id}: ${c.evidence.join(' | ')}`)
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

function parseDeepJson(raw: string): { summary: string; findings: DeepFinding[] } | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      summary?: unknown;
      findings?: unknown;
    };
    if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.findings)) return null;
    const findings: DeepFinding[] = parsed.findings
      .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === 'object'))
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
    return { summary: parsed.summary, findings };
  } catch {
    return null;
  }
}

export async function runDeepReview(
  ctx: RepoContext,
  checks: CheckResult[],
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { content?: Array<{ text?: string }> };
      const text = json.content?.map((c) => c.text ?? '').join('\n') ?? '';
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
    } catch (err) {
      return {
        provider: 'Anthropic API',
        filesInspected,
        summary: '',
        findings: [],
        error: `Anthropic API call failed: ${err instanceof Error ? err.message : String(err)}`,
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = json.choices?.[0]?.message?.content ?? '';
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
    } catch (err) {
      return {
        provider: 'OpenAI API',
        filesInspected,
        summary: '',
        findings: [],
        error: `OpenAI API call failed: ${err instanceof Error ? err.message : String(err)}`,
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('\n') ?? '';
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
    } catch (err) {
      return {
        provider: 'Gemini API',
        filesInspected,
        summary: '',
        findings: [],
        error: `Gemini API call failed: ${err instanceof Error ? err.message : String(err)}`,
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
    } catch (err) {
      return {
        provider: 'local claude CLI',
        filesInspected,
        summary: '',
        findings: [],
        error: `Local claude CLI failed: ${err instanceof Error ? err.message : String(err)}`,
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
    } catch (err) {
      return {
        provider: 'local codex CLI',
        filesInspected,
        summary: '',
        findings: [],
        error: `Local codex CLI failed: ${err instanceof Error ? err.message : String(err)}`,
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

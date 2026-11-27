import { afterEach, describe, expect, it } from 'vitest';
import { auditRepo, renderHtml, renderJson, renderMarkdown, renderTerminal } from '../src/index.js';
import { createAntiPatternRepo, createTempRepo, createWellHarnessedRepo, type TempRepo } from './fixtures.js';

const repos: TempRepo[] = [];
const track = (r: TempRepo): TempRepo => {
  repos.push(r);
  return r;
};

afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
});

describe('renderers (terminal, markdown, html, json)', () => {
  it('emits schema v1.1.0 JSON with zero promo content and localized strings', () => {
    const repo = track(createWellHarnessedRepo());
    const reportEn = auditRepo(repo.dir, { lang: 'en' });
    const rawEn = renderJson(reportEn);
    const parsedEn = JSON.parse(rawEn) as Record<string, unknown>;

    expect(parsedEn['schemaVersion']).toBe('1.1.0');
    expect(parsedEn['level']).toBe(5);
    expect(Array.isArray(parsedEn['stations'])).toBe(true);
    expect((parsedEn['stations'] as unknown[]).length).toBe(6);
    expect((parsedEn['checks'] as unknown[]).length).toBe(30);
    expect(rawEn).not.toContain('services/');
    expect(rawEn).not.toContain('books/');

    const reportPl = auditRepo(repo.dir, { lang: 'pl' });
    const parsedPl = JSON.parse(renderJson(reportPl)) as {
      lang: string;
      levelName: string;
      checks: Array<{ docsUrl: string }>;
    };
    expect(parsedPl.lang).toBe('pl');
    expect(parsedPl.levelName).toBe('Ciemna fabryka');
    expect(parsedPl.checks[0]!.docsUrl.startsWith('https://developertoolkit.ai/pl/')).toBe(true);
  });

  it('renders standalone Schematic HTML with brand tokens, print CSS, and escapes untrusted characters', () => {
    const repo = track(createTempRepo('ha-xss-'));
    repo.write('AGENTS.md', '# <script>alert(1)</script>\nRun `npm test`.\n');
    const report = auditRepo(repo.dir);
    // Inject a malicious repoName check to verify escaping
    const poisoned = { ...report, repoName: 'evil<script>alert("x")</script>' };

    const html = renderHtml(poisoned);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('#fafaf9'); // Schematic warm paper
    expect(html).toContain('#ff4d00'); // Schematic signal fill
    expect(html).toContain('#c2410c'); // Schematic signal text
    expect(html).toContain('@media print');
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');

    const htmlNoPromo = renderHtml(report, { noPromo: true });
    expect(htmlNoPromo).not.toContain('<section class="ink-band">');
    expect(htmlNoPromo).not.toContain('developertoolkit.ai/en/books/');
  });

  it('hides decorative banner & promo footer in CI and --no-promo modes for terminal and markdown', () => {
    const repo = track(createAntiPatternRepo());
    const report = auditRepo(repo.dir, { lang: 'en', role: 'lead' });

    const termDefault = renderTerminal(report, { noColor: true });
    expect(termDefault).toContain('Next Steps');
    expect(termDefault).toContain('developertoolkit.ai/en/books/');
    expect(termDefault).toContain('developertoolkit.ai/en/services/');

    const termCi = renderTerminal(report, { ci: true });
    expect(termCi).not.toContain('━━━');
    expect(termCi).not.toContain('Next Steps');
    expect(termCi).not.toContain('developertoolkit.ai/en/services/');

    const mdDefault = renderMarkdown(report);
    expect(mdDefault).toContain('## Next Steps');
    const mdNoPromo = renderMarkdown(report, { noPromo: true });
    expect(mdNoPromo).not.toContain('## Next Steps');
  });
});

import type { AuditReport, OutputFormat, RenderOptions } from '../types.js';
import { renderHtml } from './html.js';
import { renderJson } from './json.js';
import { renderMarkdown } from './markdown.js';
import { renderTerminal } from './terminal.js';

export { renderHtml, renderJson, renderMarkdown, renderTerminal };

export function renderReport(
  report: AuditReport,
  format: OutputFormat,
  options: RenderOptions = {},
): string {
  switch (format) {
    case 'terminal':
      return renderTerminal(report, options);
    case 'md':
      return renderMarkdown(report, options);
    case 'html':
      return renderHtml(report, options);
    case 'json':
      return renderJson(report, options);
  }
}

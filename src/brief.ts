import type { RepoContext } from './fs-scanner.js';

/** What the root agent instructions say, read once and shared by every check that asks. */
export interface BriefFacts {
  /** Root brief files that exist, in reading order: AGENTS.md, CLAUDE.md. */
  files: string[];
  /** The file a fix should name: the brief the repository has, or AGENTS.md when it has none. */
  primary: string;
  text: string;
  /** Docs inside the repository that the brief sends agents to. */
  routedDocs: string[];
  /** AGENTS.md / CLAUDE.md files below the root, outside vendored skill and plugin folders. */
  nestedBriefs: string[];
  /** Lines that forbid something on production or shared resources, verbatim. */
  boundaryRules: string[];
  /** A section or table that maps areas of the codebase to rules or docs. */
  hasModuleMap: boolean;
}

const PROHIBITION = /\b(never|do not|don't|must not|mustn't|forbidden|off-limits|not allowed|only path|only way|is the only)\b/i;
const SHARED_TARGET = /\b(production|prod|deploy\w*|--remote|live|shared|secrets?|credentials?|migrat\w+|force[- ]push|publish\w*|customer data)\b/i;
const MAP_HEADING = /^#{2,4}\s+(architecture|directory|structure|project structure|layout|modules?|key paths|where things live|read before (you )?touch(ing)?|ownership)\b/im;

export function repoDocLinks(markdown: string, exists: (path: string) => boolean): string[] {
  const paths = [...markdown.matchAll(/[`(]((?:[\w.@-]+\/)+[\w.@-]+\.mdx?)[`)#]/g)].map((m) => m[1]!);
  return [...new Set(paths)].filter(exists);
}

export function readBrief(ctx: RepoContext): BriefFacts {
  const files = ['AGENTS.md', 'CLAUDE.md'].filter((f) => ctx.hasFile(f));
  const text = files.map((f) => ctx.readText(f) ?? '').join('\n');
  const lines = text.split(/\r?\n/);

  const boundaryRules = lines
    .map((l) => l.trim().replace(/^[-*>\d.\s]+/, ''))
    .filter((l) => l.length > 0 && PROHIBITION.test(l) && SHARED_TARGET.test(l))
    .map((l) => (l.length > 110 ? `${l.slice(0, 110)}…` : l));

  const routedDocs = repoDocLinks(text, (p) => ctx.hasFile(p));
  // A table whose rows pair a path with something: three rows make it a map.
  const tableRowsWithPaths = lines.filter((l) => /^\s*\|.*`[^`]*\/[^`]*`.*\|/.test(l)).length;

  return {
    files,
    primary: files[0] ?? 'AGENTS.md',
    text,
    routedDocs,
    nestedBriefs: ctx.findFiles((f) => /\/(AGENTS|CLAUDE)\.md$/.test(f) && !f.startsWith('.')),
    boundaryRules,
    hasModuleMap: MAP_HEADING.test(text) || routedDocs.length >= 3 || tableRowsWithPaths >= 3,
  };
}

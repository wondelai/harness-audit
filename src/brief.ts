import type { RepoContext } from './fs-scanner.js';

export interface BriefLine {
  file: string;
  line: number;
  text: string;
}

/** What the root agent instructions say, read once and shared by every check that asks. */
export interface BriefFacts {
  /** Root brief files that exist, in reading order: AGENTS.md, CLAUDE.md. */
  files: string[];
  /** The file that holds the brief's substance: where a fix should be written and what a budget measures. */
  primary: string;
  /** A short AGENTS.md (or CLAUDE.md) whose job is to send the reader to the other file. */
  pointer: { from: string; to: string } | undefined;
  /**
   * A short file that neither points to the other nor repeats it (a framework template, a
   * tool-managed block), next to a file that holds the real brief.
   */
  stub: { file: string; lines: number; real: string } | undefined;
  text: string;
  /** Docs inside the repository that the brief sends agents to. */
  routedDocs: string[];
  /** AGENTS.md / CLAUDE.md files below the root, outside vendored skill and plugin folders. */
  nestedBriefs: string[];
  /** Sentences that forbid or reserve an action on a production or shared resource. */
  boundaryRules: BriefLine[];
  /** Sentences that say local work reaches production (`wrangler dev --remote`, "talks to production"). */
  productionReach: BriefLine[];
  /** A section or table that maps areas of the codebase to rules or docs. */
  hasModuleMap: boolean;
}

// A boundary is one sentence that forbids or reserves an action on production: the production
// word and the prohibition or reservation within reach of each other, in either order ("never run
// `wrangler deploy`", "PRODUCTION DEPLOYS — ONE WAY ONLY … never an agent's", "`bun run deploy` —
// debug only", "write to it only when the write is the task"). Words that merely share a long line,
// "publish" as domain vocabulary, or a rule about where tests live are not.
const TARGET = String.raw`(?:\bproduction\b|\bprod\b|--remote\b|\bdeploy(?:s|ed|ing|ment|ments)?\b|\bnpm publish\b|\bforce[- ]push(?:es|ing)?\b|\bcustomer data\b|\breal (?:users|customers|data|e-?mail)\b|\blive (?:data|database|db|site|webhooks?|customers|users|api)\b)`;
const LIMIT = String.raw`(?:\bnever\b|\bdo not\b|\bdon't\b|\bmust not\b|\bmustn't\b|\bnot allowed\b|\bforbidden\b|\boff-limits\b|\bbelongs? to\b|\breserved for\b|\b(?:is|are) the only (?:path|way)\b|\bone way only\b|\bonly (?:from|via|through|when)\b|\b(?:debug|emergency|manual(?:ly)?) only\b|\bbypass(?:es)? the pipeline\b|\bsay so first\b)`;
const BOUNDARY = new RegExp(`${TARGET}[\\s\\S]{0,110}?${LIMIT}|${LIMIT}[\\s\\S]{0,110}?${TARGET}`, 'i');
const REMOTE_IS_PRODUCTION = /--remote\b[\s\S]{0,110}\bproduction\b|\bproduction\b[\s\S]{0,110}--remote\b/i;
// Local work that reaches production by default: a local or dev subject, a verb, then production.
const REACHES_PRODUCTION = /\b(?:local\w*|dev(?:elopment)?|wrangler dev)\b[\s\S]{0,70}?\b(?:talks? to|reach(?:es)?|hits?|connects? to|writes? to|binds?|runs? against|points? at)\b[\s\S]{0,40}?(?:production|prod)\b/i;
/** Markdown and emoji carry no meaning for a rule: "🚨 **PRODUCTION DEPLOYS — ONE WAY ONLY**" reads as its words. */
const plain = (text: string): string => text.replace(/[*_~]|[^\x00-\x7F\u00A0-\u024F\u2010-\u2015]/g, '').replace(/\s+/g, ' ').trim();
const MAP_HEADING = /^#{2,4}\s+(architecture|directory|structure|project structure|layout|modules?|key paths|where things live|read before (you )?touch(ing)?|ownership)\b/im;

export function repoDocLinks(markdown: string, exists: (path: string) => boolean): string[] {
  const paths = [...markdown.matchAll(/[`(]((?:[\w.@-]+\/)+[\w.@-]+\.mdx?)[`)#]/g)].map((m) => m[1]!.replace(/^(?:\.\/)+/, ''));
  return [...new Set(paths)].filter(exists);
}

function clip(text: string): string {
  const clean = text.trim().replace(/^[-*>\d.\s]+/, '').replace(/\*\*/g, '');
  return clean.length > 110 ? `${clean.slice(0, 110)}…` : clean;
}

export function readBrief(ctx: RepoContext): BriefFacts {
  const files = ['AGENTS.md', 'CLAUDE.md'].filter((f) => ctx.hasFile(f));
  const contents = new Map(files.map((f) => [f, ctx.readText(f) ?? '']));
  const text = files.map((f) => contents.get(f)!).join('\n');

  // "See CLAUDE.md" in a few lines: the other file is the brief.
  let pointer: BriefFacts['pointer'];
  if (files.length === 2) {
    for (const [from, to] of [['AGENTS.md', 'CLAUDE.md'], ['CLAUDE.md', 'AGENTS.md']] as const) {
      const body = contents.get(from)!;
      const lineCount = body.split(/\r?\n/).filter((l) => l.trim()).length;
      if (lineCount <= 8 && body.includes(to) && contents.get(to)!.length > body.length * 2) pointer = { from, to };
    }
  }
  let stub: BriefFacts['stub'];
  if (files.length === 2 && !pointer) {
    for (const [small, big] of [['AGENTS.md', 'CLAUDE.md'], ['CLAUDE.md', 'AGENTS.md']] as const) {
      const smallLines = contents.get(small)!.split(/\r?\n/).filter((l) => l.trim()).length;
      const importsBig = small === 'CLAUDE.md' && /^@AGENTS\.md\s*$/m.test(contents.get(small)!);
      if (smallLines <= 20 && !importsBig && contents.get(big)!.length > contents.get(small)!.length * 4) stub = { file: small, lines: smallLines, real: big };
    }
  }
  const primary = pointer?.to ?? stub?.real ?? files[0] ?? 'AGENTS.md';

  const boundaryRules: BriefLine[] = [];
  const productionReach: BriefLine[] = [];
  for (const file of files) {
    let inFence = false;
    contents.get(file)!.split(/\r?\n/).forEach((raw, index) => {
      if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
      if (inFence || !raw.trim() || /^\s*#/.test(raw)) return;
      // Sentence by sentence: two unrelated words at opposite ends of a long line are not a rule.
      for (const sentence of plain(raw).split(/(?<=[.!?;])\s+(?=[A-Z`("'-])/)) {
        const limits = BOUNDARY.test(sentence);
        if (REACHES_PRODUCTION.test(sentence) && !limits) {
          productionReach.push({ file, line: index + 1, text: clip(sentence) });
          return;
        }
        if (limits || REMOTE_IS_PRODUCTION.test(sentence)) {
          boundaryRules.push({ file, line: index + 1, text: clip(sentence) });
          return;
        }
      }
    });
  }

  const routedDocs = repoDocLinks(text, (p) => ctx.hasFile(p));
  // A table whose rows pair a path with something: three rows make it a map.
  const tableRowsWithPaths = text.split(/\r?\n/).filter((l) => /^\s*\|.*`[^`]*\/[^`]*`.*\|/.test(l)).length;

  return {
    files,
    primary,
    pointer,
    stub,
    text,
    routedDocs,
    nestedBriefs: ctx.findFiles((f) => /\/(AGENTS|CLAUDE)\.md$/.test(f) && !f.startsWith('.')),
    boundaryRules,
    productionReach,
    hasModuleMap: MAP_HEADING.test(text) || routedDocs.length >= 3 || tableRowsWithPaths >= 3,
  };
}

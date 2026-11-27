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
  /** Commands the brief tells agents not to run ("Never run `npm test` from the root"), as quoted. */
  forbiddenCommands: string[];
}

// A boundary is one sentence that forbids or reserves an action on production: the production
// word and the prohibition or reservation within reach of each other, in either order ("never run
// `wrangler deploy`", "PRODUCTION DEPLOYS — ONE WAY ONLY … never an agent's", "`bun run deploy` —
// debug only", "write to it only when the write is the task"). Words that merely share a long line,
// "publish" as domain vocabulary, or a rule about where tests live are not.
const LETTER = String.raw`\p{L}`;
const TARGET_EN = String.raw`\bproduction\b|\bprod\b|--remote\b|\bdeploy(?:s|ed|ing|ment|ments)?\b|\bnpm publish\b|\bforce[- ]push(?:es|ing)?\b|\bcustomer data\b|\breal (?:users|customers|data|e-?mail)\b|\blive (?:data|database|db|site|webhooks?|customers|users|api)\b`;
const LIMIT_EN = String.raw`\bnever\b|\bdo not\b|\bdon't\b|\bmust not\b|\bmustn't\b|\bnot allowed\b|\bforbidden\b|\boff-limits\b|\bbelongs? to\b|\breserved for\b|\b(?:is|are) the only (?:path|way)\b|\bone way only\b|\bonly (?:from|via|through|when)\b|\b(?:debug|emergency|manual(?:ly)?) only\b|\bbypass(?:es)? the pipeline\b|\bsay so first\b`;
// The same vocabulary in Polish, the tool's second language ("Wdrożenie wyłącznie z czystego main").
// `\b` knows ASCII letters only, so these stems are fenced with letter lookarounds.
const TARGET_PL = String.raw`(?<!${LETTER})(?:produkcj${LETTER}*|produkcyjn${LETTER}*|wdro[żz]${LETTER}*|wdra[żz]${LETTER}*|prodzie|prawdziw${LETTER}+ (?:dan|użytkownik|klient)${LETTER}*|dan${LETTER}+ klient${LETTER}+)`;
const LIMIT_PL = String.raw`(?<!${LETTER})(?:nigdy|nie wolno|zabronion${LETTER}*|zakaz${LETTER}*|wyłącznie|tylko (?:z|ze|przez|po|gdy|kiedy|w|na|za)(?!${LETTER})|nie (?:uruchamiaj|wdrażaj|dotykaj|rób|używaj|zmieniaj|kasuj|usuwaj|wykonuj|odpalaj|pushuj|deployuj|ruszaj|modyfikuj|nadpisuj)${LETTER}*|bez (?:zgody|pytania|potwierdzenia|akceptacji)|nie mo(?:że|gą|żesz|żna)(?!${LETTER})|zarezerwowan${LETTER}*)`;
const TARGET = `(?:${TARGET_EN}|${TARGET_PL})`;
const LIMIT = `(?:${LIMIT_EN}|${LIMIT_PL})`;
const BOUNDARY = new RegExp(`${TARGET}[\\s\\S]{0,170}?${LIMIT}|${LIMIT}[\\s\\S]{0,170}?${TARGET}`, 'iu');
const REMOTE_IS_PRODUCTION = /--remote\b[\s\S]{0,110}(?:\bproduction\b|produkcj)|(?:\bproduction\b|produkcj)[\s\S]{0,110}--remote\b/i;
// Local work that reaches production by default: a local or dev subject, a verb, then production.
const REACHES_PRODUCTION = /\b(?:local\w*|dev(?:elopment)?|wrangler dev)\b[\s\S]{0,70}?\b(?:talks? to|reach(?:es)?|hits?|connects? to|writes? to|binds?|runs? against|points? at)\b[\s\S]{0,40}?(?:production|prod)\b/i;
// "An example that was never deployed" reports the past; it forbids nothing.
const PAST_STATE = /\b(?:was|were|had|has|have|hasn't|haven't)\s+(?:\w+\s+)?never\s+(?:been\s+)?\w+/gi;
/** Markdown and emoji carry no meaning for a rule: "🚨 **PRODUCTION DEPLOYS — ONE WAY ONLY**" reads as its words. */
const plain = (text: string): string => text.replace(/\*+|~~|(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])|[^\x00-\x7F -ɏ‐-―]/g, '').replace(/\s+/g, ' ').trim();
const MAP_HEADING = /^#{2,4}\s+(architecture|directory|structure|project structure|layout|modules?|key paths|where things live|read before (you )?touch(ing)?|ownership|architektura|struktura(?: projektu| katalog[óo]w)?|modu[łl]y)(?![\p{L}])/imu;

/** Whether a document has a section that maps the code: "Architecture", "Project structure", "Struktura". */
export function hasMapSection(markdown: string): boolean {
  // By heading, or by shape: a drawn directory tree maps the code under any heading, in any language.
  return MAP_HEADING.test(markdown) || (markdown.match(/^\s*[│|]?\s*[├└]──\s+\S/gm)?.length ?? 0) >= 3;
}

/** How plainly a rule forbids, and whether it names production: the clearest rule is the one to quote. */
export function ruleStrength(text: string): number {
  // An instruction: "Never …" / "Do not …" opening a sentence, or a modal prohibition anywhere.
  const words = text.replace(/[*_`>]/g, '');
  const forbids =
    /(?:^|[.:;!?—–]\s+|^[-\d.\s]+)(?:never|do not|don't)\b/im.test(words) ||
    /\b(?:must not|mustn't|must never|should never|may not|forbidden|not allowed|off-limits)\b|nigdy|nie wolno|zabronion|zakaz/i.test(words);
  const names = /\bproduction\b|\bprod\b|--remote\b|\blive\b|\bcustomer|\breal (?:data|users|customers)\b|produkc/i.test(text);
  return (forbids ? 2 : 0) + (names ? 1 : 0);
}

/**
 * Sentences in a document that forbid or reserve an action on production (`rules`), and sentences
 * that say local work reaches production (`reach`). Rules come strongest first.
 */
export function scanBoundaries(file: string, markdown: string): { rules: BriefLine[]; reach: BriefLine[] } {
  const rules: BriefLine[] = [];
  const reach: BriefLine[] = [];
  let inFence = false;
  markdown.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
    if (inFence || !raw.trim() || /^\s*#/.test(raw)) return;
    // Sentence by sentence: two unrelated words at opposite ends of a long line are not a rule.
    // Matching ignores markdown and emoji; the quote is the line as its author wrote it.
    for (const sentence of plain(raw).split(/(?<=[.!?;])\s+(?=[\p{Lu}`("'-])/u)) {
      const claim = sentence.replace(PAST_STATE, '');
      const limits = BOUNDARY.test(claim);
      if (REACHES_PRODUCTION.test(claim) && !limits) {
        reach.push({ file, line: index + 1, text: quote(raw) });
        return;
      }
      if (limits || REMOTE_IS_PRODUCTION.test(claim)) {
        rules.push({ file, line: index + 1, text: quote(raw) });
        return;
      }
    }
  });
  // Stable: among equally clear rules the first one written stays first.
  rules.sort((a, b) => ruleStrength(b.text) - ruleStrength(a.text));
  return { rules, reach };
}

/** Whether the text names at least one path (a file or a directory with a slash) that exists in the repository. */
export function repoPathsIn(text: string, exists: (path: string) => boolean): boolean {
  const candidates = [...text.matchAll(/(?:^|[\s`("'])((?:\.?[\w@-]+\/)+[\w.@-]*)/g)].map((m) => m[1]!.replace(/^\.\//, ''));
  return [...new Set(candidates)].slice(0, 200).some((p) => p.length > 3 && exists(p));
}

export function repoDocLinks(markdown: string, exists: (path: string) => boolean): string[] {
  const paths = [...markdown.matchAll(/[`(]((?:[\w.@-]+\/)+[\w.@-]+\.mdx?)[`)#]/g)].map((m) => m[1]!.replace(/^(?:\.\/)+/, ''));
  return [...new Set(paths)].filter(exists);
}

/** The line verbatim, without its list marker, cut at a word boundary. */
function quote(text: string): string {
  const clean = text.trim().replace(/^(?:[-*>]|\d+\.)\s+/, '');
  return clean.length > 120 ? `${clean.slice(0, clean.lastIndexOf(' ', 120))}…` : clean;
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
    const found = scanBoundaries(file, contents.get(file)!);
    boundaryRules.push(...found.rules);
    productionReach.push(...found.reach);
  }
  boundaryRules.sort((a, b) => ruleStrength(b.text) - ruleStrength(a.text));

  // "Never run `npm run build`", "Do NOT run `npm test` unless asked": the backticked commands of
  // a sentence that forbids running something.
  const forbiddenCommands: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      if (!/\b(?:never|do not|don't|must not)\b[^`.]{0,30}\b(?:run|execute|invoke|call|use)\b/i.test(sentence)) continue;
      for (const m of sentence.matchAll(/`([^`\n]{3,80})`/g)) forbiddenCommands.push(m[1]!.trim());
    }
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
    hasModuleMap: hasMapSection(text) || routedDocs.length >= 3 || tableRowsWithPaths >= 3,
    forbiddenCommands: [...new Set(forbiddenCommands)],
  };
}

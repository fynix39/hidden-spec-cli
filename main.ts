// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** Surrounding spaces removed (SPEC.md sections 6 and 8 say "spaces", not whitespace). */
const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a move edit made, as [old, new] pairs, for the R lines of section 2. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /**
   * The path is taken: a file in the tree, or (when no earlier edit touched it) anything on disk,
   * file or directory. A directory at the path makes a creation or a move there `exists`.
   */
  occupied(p: string): boolean {
    if (this.get(p) !== null) return true;
    if (this.now.has(p)) return false;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.occupied(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 3: a file's lines, its line break, and whether it ends with one.
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

/** One body line of a unified hunk or a V4A chunk. `noNL` marks a `\` line after it (unified only). */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNL: boolean;
}

function keyAt(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position i >= from where O matches lines at the given tier (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const ok = o.map((l) => keyAt(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < o.length; j++) {
      if (keyAt(lines[i + j]!, tier) !== ok[j]) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

/**
 * The first tier (0..2, or 0 only when strict) at which O occurs at or after `from`, and its positions;
 * when endAnchored, only occurrences ending at the file's last line count. Null when O occurs at no tier.
 */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
  endAnchored: boolean,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrences(lines, o, t, from);
    if (endAnchored) pos = pos.filter((i) => i + o.length === lines.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Tier-2 re-indentation of one new line: its leading P replaced by F, when it is not blank and starts with P. */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/**
 * The lines that replace O's match at `at`, from the chunk's ops: a context line is the file's own matched
 * line, never the patch's; added lines are the patch's, re-indented at tier 2 (section 5).
 */
function replacement(ops: Op[], file: string[], at: number, tier: number): string[] {
  const o: string[] = [];
  for (const op of ops) if (op.kind !== 'add') o.push(op.text);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = /^[ \t]*/.exec(file[at]!)![0];
    p = /^[ \t]*/.exec(o[0]!)![0];
  }
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(file[at + oi]!);
      oi += 1;
    } else if (op.kind === 'del') {
      oi += 1;
    } else {
      out.push(tier === 2 ? reindent(op.text, f, p) : op.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  ops: Op[];
}

/**
 * One section. A path is `undefined` when no line named it, `null` when /dev/null named "no file".
 * Precedence per path: the ---/+++ pair, then rename from/to, then the diff --git paths.
 */
interface Section {
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/([^ ]*) b\/(.*)$/;

/** A ---/+++ path: the text after the four characters, up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return trimSpaces(tab < 0 ? t : t.slice(0, tab));
}

/** A leading a/ or b/ is removed from a unified path. */
function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function headerNamed(p: string): string | null {
  return p === '/dev/null' ? null : stripPrefix(p);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHunk: Hunk | null = null;
  const endBody = (): void => {
    if (curHunk === null) return;
    // Empty lines at the end of a body are not part of it.
    while (curHunk.ops.length > 0) {
      const last = curHunk.ops[curHunk.ops.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') curHunk.ops.pop();
      else break;
    }
    curHunk = null;
  };
  const newSection = (s: Section): void => {
    endBody();
    sections.push(s);
    cur = s;
  };
  const blankSection = (): Section => ({
    dashOld: undefined,
    dashNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    gitOld: undefined,
    gitNew: undefined,
    create: false,
    remove: false,
    hunks: [],
  });
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (curHunk !== null) {
      // A diff --git line or a --- line followed by a +++ line ends the body, before the body-line test
      // (a --- line starts with -, so it would otherwise read as a deletion).
      const endsBody = l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
      if (!endsBody && (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\')) {
        if (l === '') curHunk.ops.push({ kind: 'ctx', text: '', noNL: false });
        else if (l[0] === ' ') curHunk.ops.push({ kind: 'ctx', text: l.slice(1), noNL: false });
        else if (l[0] === '-') curHunk.ops.push({ kind: 'del', text: l.slice(1), noNL: false });
        else if (l[0] === '+') curHunk.ops.push({ kind: 'add', text: l.slice(1), noNL: false });
        else {
          // A \ line refers to the body line before it.
          const last = curHunk.ops[curHunk.ops.length - 1];
          if (last !== undefined) last.noNL = true;
        }
        continue;
      }
      endBody();
    }
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      newSection(s);
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const h: Hunk = { a: parseInt(m[1]!, 10), ops: [] };
      cur.hunks.push(h);
      curHunk = h;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0) {
          cur.dashOld = headerNamed(headerPath(l));
          cur.dashNew = headerNamed(headerPath(next));
        } else {
          const s = blankSection();
          s.dashOld = headerNamed(headerPath(l));
          s.dashNew = headerNamed(headerPath(next));
          newSection(s);
        }
        i += 1;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Section header lines; anything else is ignored.
      if (l.startsWith('+++ ')) cur.dashNew = headerNamed(headerPath(l));
      else if (l.startsWith('rename from ')) cur.renameOld = trimSpaces(l.slice('rename from '.length).split('\t')[0]!);
      else if (l.startsWith('rename to ')) cur.renameNew = trimSpaces(l.slice('rename to '.length).split('\t')[0]!);
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.remove = true;
    }
    // Outside bodies and headers, lines are ignored (prose, code fences).
  }
  endBody();
  return sections.map((s) => sectionEdit(s, strict));
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoNL(h: Hunk): boolean {
  for (let k = h.ops.length - 1; k >= 0; k--) {
    const op = h.ops[k]!;
    if (op.kind === 'ctx' || op.kind === 'add') return op.noNL;
  }
  return false;
}

/** Apply one hunk to the file state; d is the drift of this section's hunks applied so far. */
function applyHunk(st: FileState, h: Hunk, d: number, strict: boolean, path: string): void {
  const o: string[] = [];
  for (const op of h.ops) if (op.kind !== 'add') o.push(op.text);
  if (o.length === 0) {
    const n = h.ops.filter((op) => op.kind === 'add').map((op) => op.text);
    const at = Math.min(Math.max(h.a + d, 0), st.lines.length);
    const atEnd = at === st.lines.length;
    st.lines.splice(at, 0, ...n);
    if (atEnd) st.final = !hunkNoNL(h);
    return;
  }
  const found = findTier(st.lines, o, strict, 0, false);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const rep = replacement(h.ops, st.lines, best, found.tier);
  const touchesEnd = best + o.length === st.lines.length;
  st.lines.splice(best, o.length, ...rep);
  if (touchesEnd) st.final = !hunkNoNL(h);
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld;
    const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew;
    if (oldP !== undefined && oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== undefined && newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null || sec.create) {
      // A creation: the new path does not exist; the file is the + lines of all its hunks, in order.
      if (newP === undefined || newP === null) return;
      if (tree.occupied(newP)) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastNoNL = false;
      for (const h of sec.hunks) {
        for (const op of h.ops) {
          if (op.kind === 'add') {
            plus.push(op.text);
            lastNoNL = op.noNL;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastNoNL ? '' : '\n'));
      return;
    }
    if (newP === null || sec.remove) {
      // A deletion: the old path exists; it is deleted, and its hunks are not read.
      if (oldP === undefined || oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === undefined || newP === undefined) return;
    const isMove = oldP !== newP;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.occupied(newP)) throw new Fail('exists', newP);
    const st = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      applyHunk(st, h, d, strict, oldP);
      const oLen = h.ops.filter((op) => op.kind !== 'add').length;
      const nLen = h.ops.filter((op) => op.kind !== 'del').length;
      d += nLen - oLen;
    }
    const out = joinFile(st);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    // The path is the nearest line before the SEARCH line, after the previous block's REPLACE line,
    // that is not blank and does not start with three backticks; else the previous block's path.
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.occupied(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const found = findTier(st.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const ops: Op[] = [
      ...oldLines.map((t): Op => ({ kind: 'del', text: t, noNL: false })),
      ...newLines.map((t): Op => ({ kind: 'add', text: t, noNL: false })),
    ];
    const rep = replacement(ops, st.lines, at, found.tier);
    st.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, joinFile(st));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface RawSection {
  type: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  raw: Array<{ text: string; no: number }>;
}

interface Chunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  for (let j = first + 1; j < last; j++) {
    const l = lines[j]!;
    const no = j + 1;
    if (l.startsWith('*** Add File: ')) {
      cur = { type: 'add', path: trimSpaces(l.slice('*** Add File: '.length)), lineNo: no, raw: [] };
      sections.push(cur);
    } else if (l.startsWith('*** Delete File: ')) {
      cur = { type: 'delete', path: trimSpaces(l.slice('*** Delete File: '.length)), lineNo: no, raw: [] };
      sections.push(cur);
    } else if (l.startsWith('*** Update File: ')) {
      cur = { type: 'update', path: trimSpaces(l.slice('*** Update File: '.length)), lineNo: no, raw: [] };
      sections.push(cur);
    } else if (cur === null) {
      if (!blank(l)) throw new Exit2(`error: parse ${no}`);
    } else {
      cur.raw.push({ text: l, no });
    }
  }
  const edits: Edit[] = [];
  for (const sec of sections) {
    // Blank lines at the end of a section are not part of it.
    while (sec.raw.length > 0 && blank(sec.raw[sec.raw.length - 1]!.text)) sec.raw.pop();
    if (sec.type === 'add') {
      const fileLines: string[] = [];
      for (const r of sec.raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      const path = sec.path;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.occupied(path)) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (sec.type === 'delete') {
      if (sec.raw.length > 0) throw new Exit2(`error: parse ${sec.raw[0]!.no}`);
      const path = sec.path;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      edits.push(updateEdit(sec, strict));
    }
  }
  return edits;
}

function updateEdit(sec: RawSection, strict: boolean): Edit {
  const raw = sec.raw;
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = trimSpaces(raw[0]!.text.slice('*** Move to: '.length));
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  const closeChunk = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      closeChunk();
      const anchor = trimSpaces(l.slice(2));
      cur = { anchor: anchor === '' ? null : anchor, ops: [], eof: false };
    } else if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.no}`);
      cur.eof = true;
      closeChunk();
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
        cur = { anchor: null, ops: [], eof: false };
      }
      if (l === '') cur.ops.push({ kind: 'ctx', text: '', noNL: false });
      else if (l[0] === ' ') cur.ops.push({ kind: 'ctx', text: l.slice(1), noNL: false });
      else if (l[0] === '-') cur.ops.push({ kind: 'del', text: l.slice(1), noNL: false });
      else cur.ops.push({ kind: 'add', text: l.slice(1), noNL: false });
    } else {
      throw new Exit2(`error: parse ${r.no}`);
    }
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
  const path = sec.path;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.occupied(moveTo)) throw new Fail('exists', moveTo);
    const st = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(st.lines, [ch.anchor], strict, cursor, false);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      const o: string[] = [];
      for (const op of ch.ops) if (op.kind !== 'add') o.push(op.text);
      if (o.length === 0) {
        const n = ch.ops.filter((op) => op.kind === 'add').map((op) => op.text);
        const at = ch.eof ? st.lines.length : cursor;
        st.lines.splice(at, 0, ...n);
        cursor = at + n.length;
        continue;
      }
      const found = findTier(st.lines, o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const at = found.pos[0]!;
      const rep = replacement(ch.ops, st.lines, at, found.tier);
      st.lines.splice(at, o.length, ...rep);
      cursor = at + rep.length;
    }
    const out = joinFile(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the output and exit codes, order and atomicity.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // R lines (section 2): a move whose old path existed before the patch and not after it, and whose new
  // path did not exist before it and does after it, replaces that pair's D and A lines and sorts by <new>.
  const consumed = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

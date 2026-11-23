// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`. Implements all of SPEC.md:
// the command line, output and exit codes, safe paths, format detection,
// line matching at three tiers (section 5), unified diffs (6), SEARCH/REPLACE (7),
// V4A patches (8), JSON edits (9) and the all-or-nothing write (10).
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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---- File line model (SPEC section 3) ----

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** A created file's text: LF breaks, ending with a line break unless told otherwise. */
function createdText(lines: string[], finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (finalBreak ? '\n' : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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

// ---- Line matching (SPEC section 5) ----

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** All 0-based positions where O occurs in lines at the tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (tier 0 only when strict). */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

type OpKind = 'ctx' | 'del' | 'add' | 'noeol';
interface Op {
  kind: OpKind;
  text: string;
}

const oLines = (ops: Op[]): string[] => ops.filter((o) => o.kind === 'ctx' || o.kind === 'del').map((o) => o.text);
const nLines = (ops: Op[]): string[] => ops.filter((o) => o.kind === 'ctx' || o.kind === 'add').map((o) => o.text);

/** Whether a `\` line follows the ops' last context or `+` line. */
function lastNoEol(ops: Op[]): boolean {
  let last = -1;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === 'ctx' || ops[i]!.kind === 'add') last = i;
  }
  return last >= 0 && ops[last + 1] !== undefined && ops[last + 1]!.kind === 'noeol';
}

/**
 * The replacement lines for ops matched at `pos` in `fileLines` at `tier`:
 * context lines are written as the file's own matched lines; at tier 2 every
 * other new line is re-indented from O's first line to the file's first matched line.
 */
function buildReplacement(ops: Op[], fileLines: string[], pos: number, tier: number): string[] {
  const first = ops.find((o) => o.kind === 'ctx' || o.kind === 'del');
  const p = first ? leadingWs(first.text) : '';
  const f = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi++;
    } else if (op.kind === 'del') {
      oi++;
    } else if (op.kind === 'add') {
      let t = op.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

// ---- Unified diffs (SPEC section 6) ----

interface Hunk {
  a: number;
  ops: Op[];
}

interface USection {
  pairOld: string | null;
  pairNew: string | null;
  pairPresent: boolean;
  renOld: string | null;
  renNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** The path named by a `--- ` or `+++ ` line, or null for /dev/null. */
function diffPathLine(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t === '/dev/null' ? null : t;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  const fresh = (): USection => ({
    pairOld: null, pairNew: null, pairPresent: false,
    renOld: null, renNew: null, gitOld: null, gitNew: null,
    create: false, del: false, hunks: [],
  });
  let cur: USection | null = null;
  let state: 'header' | 'between' = 'header';
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      state = 'header';
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), ops: [] };
      cur.hunks.push(hunk);
      i++;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('@@')) break;
        if (bl === '') {
          hunk.ops.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ') {
          hunk.ops.push({ kind: 'ctx', text: bl.slice(1) });
          i++;
          continue;
        }
        if (c === '-') {
          hunk.ops.push({ kind: 'del', text: bl.slice(1) });
          i++;
          continue;
        }
        if (c === '+') {
          hunk.ops.push({ kind: 'add', text: bl.slice(1) });
          i++;
          continue;
        }
        if (c === '\\') {
          hunk.ops.push({ kind: 'noeol', text: '' });
          i++;
          continue;
        }
        break;
      }
      while (hunk.ops.length > 0) {
        const last = hunk.ops[hunk.ops.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.ops.pop();
        else break;
      }
      state = 'between';
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = fresh();
        cur.pairOld = diffPathLine(line);
        cur.pairNew = diffPathLine(lines[i + 1]!);
        cur.pairPresent = true;
        sections.push(cur);
        state = 'header';
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (state === 'between') {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = fresh();
        cur.pairOld = diffPathLine(line);
        cur.pairNew = diffPathLine(lines[i + 1]!);
        cur.pairPresent = true;
        sections.push(cur);
        state = 'header';
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // In a section header (before its first hunk).
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        cur.pairOld = diffPathLine(line);
        cur.pairNew = diffPathLine(lines[i + 1]!);
        cur.pairPresent = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('rename from ')) {
      cur.renOld = line.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur.renNew = line.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      cur.create = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur.del = true;
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

/** Resolve a section's old/new path: `---`/`+++` pair, then rename, then `diff --git`. */
function sectionPaths(sec: USection): [string | null, string | null] {
  if (sec.pairPresent) return [sec.pairOld, sec.pairNew];
  if (sec.renOld !== null || sec.renNew !== null) return [sec.renOld, sec.renNew];
  return [sec.gitOld, sec.gitNew];
}

/** Apply a section's hunks to a file model (SPEC section 6), failing with no-match on the path. */
function applyUnifiedHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  let lines = [...model.lines];
  let final = model.final;
  let d = 0;
  for (const h of hunks) {
    const o = oLines(h.ops);
    const n = nLines(h.ops);
    if (o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = pos === lines.length;
      const rep = buildReplacement(h.ops, lines, pos, 0);
      lines.splice(pos, 0, ...rep);
      if (atEnd) final = !lastNoEol(h.ops);
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + o.length === lines.length;
    const rep = buildReplacement(h.ops, lines, best, found.tier);
    lines.splice(best, o.length, ...rep);
    if (atEnd) final = !lastNoEol(h.ops);
    d += n.length - o.length;
  }
  return { br: model.br, lines, final };
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const [oldP, newP] = sectionPaths(sec);
    if ((sec.create || oldP === null) && newP !== null) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const addLines: string[] = [];
      for (const h of sec.hunks) {
        for (const op of h.ops) if (op.kind === 'add') addLines.push(op.text);
      }
      let noEol = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        let hasAdd = false;
        for (const op of h.ops) if (op.kind === 'add') hasAdd = true;
        if (hasAdd) {
          noEol = lastNoEol(h.ops);
          break;
        }
      }
      tree.now.set(newP, createdText(addLines, !noEol));
      return;
    }
    if (sec.del || newP === null) {
      const op = oldP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const oldPath = oldP!;
    const newPath = newP!;
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const result = applyUnifiedHunks(splitFile(before), sec.hunks, strict, oldPath);
      tree.now.set(newPath, joinFile(result));
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const result = applyUnifiedHunks(splitFile(before), sec.hunks, strict, oldPath);
    tree.now.set(oldPath, joinFile(result));
  };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let gt = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        gt = j;
        break;
      }
    }
    if (gt < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, gt) });
    prevPath = path;
    prevEnd = gt;
    i = gt + 1;
  }
  return blocks;
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, createdText(b.newLines, true));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = splitFile(before);
    const found = findTier(model.lines, b.oldLines, strict);
    if (!found) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.pos[0]!;
    const ops: Op[] = [
      ...b.oldLines.map((t): Op => ({ kind: 'del', text: t })),
      ...b.newLines.map((t): Op => ({ kind: 'add', text: t })),
    ];
    const rep = buildReplacement(ops, model.lines, pos, found.tier);
    const lines = [...model.lines];
    lines.splice(pos, b.oldLines.length, ...rep);
    tree.now.set(b.path, joinFile({ ...model, lines }));
  };
}

// ---- V4A patches (SPEC section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: VChunk[];
  line: number;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = (l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null => {
    if (l.startsWith('*** Add File:')) return { kind: 'add', path: l.slice('*** Add File:'.length).trim() };
    if (l.startsWith('*** Delete File:')) return { kind: 'delete', path: l.slice('*** Delete File:'.length).trim() };
    if (l.startsWith('*** Update File:')) return { kind: 'update', path: l.slice('*** Update File:'.length).trim() };
    return null;
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const s = sectionStart(line);
    if (!s) throw new Exit2(`error: parse ${i + 1}`);
    if (s.kind === 'add') {
      const sec: VSection = { kind: 'add', path: s.path, moveTo: null, chunks: [], line: i + 1 };
      i++;
      const bodyLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (sectionStart(l) || l.trim() === '*** End Patch') break;
        if (blank(l)) {
          bodyLines.push('');
          i++;
          continue;
        }
        if (l.startsWith('+')) {
          bodyLines.push(l.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
      sec.chunks = [{ anchor: null, eof: false, ops: bodyLines.map((t): Op => ({ kind: 'add', text: t })) }];
      sections.push(sec);
      continue;
    }
    if (s.kind === 'delete') {
      const sec: VSection = { kind: 'delete', path: s.path, moveTo: null, chunks: [], line: i + 1 };
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (sectionStart(l) || l.trim() === '*** End Patch') break;
        if (blank(l)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push(sec);
      continue;
    }
    const sec: VSection = { kind: 'update', path: s.path, moveTo: null, chunks: [], line: i + 1 };
    i++;
    if (i < last && lines[i]!.startsWith('*** Move to:')) {
      sec.moveTo = lines[i]!.slice('*** Move to:'.length).trim();
      i++;
    }
    let cur: VChunk | null = null;
    const endChunk = (): void => {
      if (cur) {
        sec.chunks.push(cur);
        cur = null;
      }
    };
    while (i < last) {
      const l = lines[i]!;
      if (sectionStart(l) || l.trim() === '*** End Patch') break;
      if (l.startsWith('@@')) {
        endChunk();
        const anchor = l.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
        i++;
        continue;
      }
      if (l.trim() === '*** End of File') {
        if (!cur) throw new Exit2(`error: parse ${i + 1}`);
        cur.eof = true;
        endChunk();
        i++;
        continue;
      }
      if (l === '') {
        if (!cur) cur = { anchor: null, eof: false, ops: [] };
        cur.ops.push({ kind: 'ctx', text: '' });
        i++;
        continue;
      }
      const c = l[0]!;
      if (c === ' ' || c === '-' || c === '+') {
        if (!cur) cur = { anchor: null, eof: false, ops: [] };
        cur.ops.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: l.slice(1) });
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    endChunk();
    // Blank lines at the end of the section are not part of it.
    while (sec.chunks.length > 0) {
      const lastChunk = sec.chunks[sec.chunks.length - 1]!;
      if (lastChunk.eof) break;
      while (lastChunk.ops.length > 0) {
        const lastOp = lastChunk.ops[lastChunk.ops.length - 1]!;
        if (lastOp.kind === 'ctx' && lastOp.text === '') lastChunk.ops.pop();
        else break;
      }
      break;
    }
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    sections.push(sec);
  }
  return sections;
}

function vEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      const lines = sec.chunks[0]!.ops.map((o) => o.text);
      tree.now.set(sec.path, createdText(lines, true));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null) {
      if (!safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    }
    const model = splitFile(before);
    let lines = [...model.lines];
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let foundAt: number | null = null;
        const max = strict ? 0 : 2;
        for (let t = 0; t <= max && foundAt === null; t++) {
          const occ = occurrences(lines, [ch.anchor], t, cursor);
          if (occ.length > 0) foundAt = occ[0]!;
        }
        if (foundAt === null) throw new Fail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      const o = oLines(ch.ops);
      if (o.length === 0) {
        const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
        const rep = buildReplacement(ch.ops, lines, pos, 0);
        lines.splice(pos, 0, ...rep);
        cursor = pos + rep.length;
        continue;
      }
      let chosen: { tier: number; pos: number } | null = null;
      const max = strict ? 0 : 2;
      for (let t = 0; t <= max && !chosen; t++) {
        const occ = occurrences(lines, o, t, cursor);
        for (const p of occ) {
          if (ch.eof && p + o.length !== lines.length) continue;
          chosen = { tier: t, pos: p };
          break;
        }
      }
      if (!chosen) throw new Fail('no-match', sec.path);
      const rep = buildReplacement(ch.ops, lines, chosen.pos, chosen.tier);
      lines.splice(chosen.pos, o.length, ...rep);
      cursor = chosen.pos + rep.length;
    }
    const out = joinFile({ ...model, lines });
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

// ---- JSON edits (SPEC section 9) ----

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
      if (tree.get(p) !== null) throw new Fail('exists', p);
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

// ---- Run (SPEC sections 1, 2, 10) ----

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => srEdit(b, strict));
    else edits = parseV4a(lines).map((s) => vEdit(s, strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const di = rows.findIndex((r) => r.text === `D ${oldP}`);
    const ai = rows.findIndex((r) => r.text === `A ${newP}`);
    if (di >= 0 && ai >= 0) {
      rows.splice(Math.max(di, ai), 1);
      rows.splice(Math.min(di, ai), 1);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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

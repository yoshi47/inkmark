import type { MarkKind, Span } from './types.js';

const OPENERS: Record<string, MarkKind> = {
  '{>>': 'comment',
  '{==': 'highlight',
  '{++': 'insertion',
  '{--': 'deletion',
  '{~~': 'substitution',
};

const CLOSERS: Record<MarkKind, string> = {
  comment: '<<}',
  highlight: '==}',
  insertion: '++}',
  deletion: '--}',
  substitution: '~~}',
};

const ID_RE = /^\{#([a-zA-Z]+\d+)\}/;

function fencedRanges(body: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /^`{3}[^\n]*\n[\s\S]*?^`{3}[ \t]*(?:\n|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

export function tokenize(body: string): Span[] {
  const skip = fencedRanges(body);
  const inSkip = (i: number): boolean => skip.some(([a, b]) => i >= a && i < b);
  const spans: Span[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch !== '{' || inSkip(i)) {
      i++;
      continue;
    }
    const opener = body.slice(i, i + 3);
    const kind: MarkKind | undefined = OPENERS[opener];
    if (kind === undefined) {
      i++;
      continue;
    }
    const closer = CLOSERS[kind];
    const closeAt = body.indexOf(closer, i + 3);
    if (closeAt === -1) {
      i++;
      continue;
    }
    const inner = body.slice(i + 3, closeAt);
    // If the inner content already contains the same opener, the closer was meant
    // for a later marker; treat this opener as unterminated and skip it.
    if (inner.includes(opener)) {
      i++;
      continue;
    }
    let end = closeAt + closer.length;
    let id: string | undefined;
    const idMatch: RegExpExecArray | null = ID_RE.exec(body.slice(end));
    if (idMatch !== null) {
      id = idMatch[1];
      end += idMatch[0].length;
    }
    const span: Span = { kind, start: i, end, inner };
    if (kind === 'substitution') {
      const arrow = inner.indexOf('~>');
      span.oldText = arrow === -1 ? inner : inner.slice(0, arrow);
      span.newText = arrow === -1 ? '' : inner.slice(arrow + 2);
    }
    if (id !== undefined) {
      span.id = id;
    }
    spans.push(span);
    i = end;
  }
  return spans;
}

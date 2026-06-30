import type { ParsedDoc } from './types.js';
import { parseEndmatter, splitEndmatter } from './endmatter.js';
import { tokenize } from './tokenize.js';

export function parse(md: string): ParsedDoc {
  const { body, endmatterRaw } = splitEndmatter(md);
  const spans = tokenize(body);
  const endmatter = parseEndmatter(endmatterRaw);
  return { body, endmatterRaw, spans, endmatter };
}

export function nextId(doc: ParsedDoc, prefix: 'c' | 's'): string {
  const seen = new Set<string>();
  for (const s of doc.spans) {
    if (s.id !== undefined) {
      seen.add(s.id);
    }
  }
  for (const id of Object.keys(doc.endmatter.comments)) {
    seen.add(id);
  }
  for (const id of Object.keys(doc.endmatter.suggestions)) {
    seen.add(id);
  }
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of seen) {
    const m = re.exec(id);
    if (m !== null) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return `${prefix}${String(max + 1)}`;
}

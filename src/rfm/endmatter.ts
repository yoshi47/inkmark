import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { CommentMeta, Endmatter, SuggestionMeta } from './types.js';

function fenceIndices(md: string): number[] {
  return [...md.matchAll(/\n---[ \t]*\n/g)].map((m) => m.index);
}

/**
 * The block a fence opens, or null when what follows it is not endmatter.
 *
 * The trailing `---` is optional: the file format documents a closed block, but
 * a hand-edited file, or one written before this module closed its own, runs to
 * the end of the file unclosed.
 *
 * Blank lines after the closing fence come off with it. An editor that leaves a
 * newline at the end of the file would otherwise put the whole block back into
 * the body, and the next save would write a second one after it.
 */
function isTable(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function blockAt(md: string, fenceIdx: number): string | null {
  const after = md
    .slice(fenceIdx)
    .replace(/^\n---[ \t]*\n/, '')
    .replace(/\n---[ \t]*(\n[ \t]*)*\n?$/, '\n');
  let obj: unknown;
  try {
    obj = parseYaml(after);
  } catch {
    return null;
  }
  if (!isTable(obj)) return null;
  // The key alone is not enough. A document ending in a list under a `comments:`
  // heading parses as one too, and claiming it would move the author's own text
  // into the endmatter, to come back rewritten as a comment table on the next save.
  const rec = obj;
  const claims = ['comments', 'suggestions'].filter((k) => k in rec);
  return claims.length > 0 && claims.every((k) => isTable(rec[k])) ? after : null;
}

/**
 * Peel every endmatter block off the end of the document, oldest first.
 *
 * More than one block is a document some writer appended to rather than
 * rewrote; reading them all is what lets the next save fold them back into one.
 * Only the last two fences of each pass are candidates — a block's own closing
 * `---` is the last fence, its opener the one before, and `serializeEndmatter`
 * never emits a column-0 `---` in between.
 */
export function splitEndmatter(md: string): { body: string; endmatterRaws: string[] } {
  const raws: string[] = [];
  let rest = md;
  for (;;) {
    let peeled = false;
    for (const idx of fenceIndices(rest).slice(-2).reverse()) {
      const raw = blockAt(rest, idx);
      if (raw === null) continue;
      raws.unshift(raw);
      rest = rest.slice(0, idx);
      peeled = true;
      break;
    }
    if (!peeled) return { body: rest, endmatterRaws: raws };
  }
}

export function parseEndmatter(raws: string[]): Endmatter {
  const merged: Endmatter = { comments: {}, suggestions: {}, extra: {} };
  for (const raw of raws) {
    let obj: unknown;
    try {
      obj = parseYaml(raw);
    } catch {
      continue;
    }
    if (!isTable(obj)) continue;
    // Merged per entry, not per block: a later block holding only suggestions
    // would otherwise drop every comment an earlier one carried. An id in two
    // blocks keeps the later entry — neither is safe when two marks were minted
    // as the same id, and the later one is what the last save meant.
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'comments' && isTable(value)) {
        Object.assign(merged.comments, value as Record<string, CommentMeta>);
      } else if (key === 'suggestions' && isTable(value)) {
        Object.assign(merged.suggestions, value as Record<string, SuggestionMeta>);
      } else {
        // A key this module knows nothing about is still the author's. Dropping
        // it here would delete it from the file the next time anything is saved.
        merged.extra[key] = value;
      }
    }
  }
  return merged;
}

export function serializeEndmatter(e: Endmatter): string {
  const out: Record<string, unknown> = { ...e.extra };
  if (Object.keys(e.comments).length > 0) out['comments'] = e.comments;
  if (Object.keys(e.suggestions).length > 0) out['suggestions'] = e.suggestions;
  return Object.keys(out).length > 0 ? stringifyYaml(out) : '';
}

/** A body and its endmatter back into one document — always a single closed block. */
export function rebuild(body: string, endmatter: Endmatter): string {
  const trimmedBody = body.replace(/\n+$/, '\n');
  const serialized = serializeEndmatter(endmatter);
  return serialized.length > 0 ? `${trimmedBody}\n---\n${serialized}---\n` : trimmedBody;
}

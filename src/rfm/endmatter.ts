import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { CommentMeta, Endmatter, SuggestionMeta } from './types.js';

function fenceIndices(md: string): number[] {
  return [...md.matchAll(/\n---[ \t]*\n/g)].map((m) => m.index);
}

function isTable(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Why a fence did not open a block. `not-endmatter` is the ordinary answer — a closing
 * fence with nothing after it, or an author's own `---` — and stays silent. `bad-yaml` is
 * the one worth saying out loud: the text claimed to be endmatter and could not be read,
 * so the block and everything before it stays in the body as prose.
 */
type BlockResult =
  | { ok: true; raw: string }
  | { ok: false; reason: 'not-endmatter' }
  | { ok: false; reason: 'bad-yaml'; message: string };

/**
 * Whether a slice is claiming to be endmatter at all, asked of the raw text because the
 * question only comes up once YAML has already refused to parse it.
 *
 * Prose after an author's own `---` is invalid YAML far more often than not — a backtick,
 * an `@`, a colon mid-sentence, a leading tab all throw — so reporting every parse failure
 * would light the warning on documents where nothing is wrong, and a badge that is always
 * on is a badge nobody reads when it finally matters.
 */
function claimsEndmatter(after: string): boolean {
  return /^(comments|suggestions):/m.test(after);
}

/**
 * The block a fence opens, or why it opens none.
 *
 * The trailing `---` is optional: the file format documents a closed block, but
 * a hand-edited file, or one written before this module closed its own, runs to
 * the end of the file unclosed.
 *
 * Blank lines after the closing fence come off with it. An editor that leaves a
 * newline at the end of the file would otherwise put the whole block back into
 * the body, and the next save would write a second one after it.
 */
function blockAt(md: string, fenceIdx: number): BlockResult {
  const after = md
    .slice(fenceIdx)
    .replace(/^\n---[ \t]*\n/, '')
    .replace(/\n---[ \t]*(\n[ \t]*)*\n?$/, '\n');
  let obj: unknown;
  try {
    obj = parseYaml(after);
  } catch (err: unknown) {
    return claimsEndmatter(after)
      ? { ok: false, reason: 'bad-yaml', message: err instanceof Error ? err.message : String(err) }
      : { ok: false, reason: 'not-endmatter' };
  }
  if (!isTable(obj)) return { ok: false, reason: 'not-endmatter' };
  // The key alone is not enough. A document ending in a list under a `comments:`
  // heading parses as one too, and claiming it would move the author's own text
  // into the endmatter, to come back rewritten as a comment table on the next save.
  const rec = obj;
  const claims = ['comments', 'suggestions'].filter((k) => k in rec);
  return claims.length > 0 && claims.every((k) => isTable(rec[k]))
    ? { ok: true, raw: after }
    : { ok: false, reason: 'not-endmatter' };
}

/**
 * Peel every endmatter block off the end of the document, oldest first.
 *
 * More than one block is a document some writer appended to rather than
 * rewrote; reading them all is what lets the next save fold them back into one.
 * Only the last two fences of each pass are candidates — a block's own closing
 * `---` is the last fence, its opener the one before, and `serializeEndmatter`
 * never emits a column-0 `---` in between.
 *
 * `unreadable` is one message or none, not a list: peeling ends at the tail-most block
 * that could not be read, so there is never a second one to report. That block and every earlier one
 * stay in the body, their ids invisible to `nextId`. Saying so is the point — the
 * alternative is a document that quietly shows its own comment table as prose.
 */
export function splitEndmatter(md: string): {
  body: string;
  endmatterRaws: string[];
  unreadable: string | null;
} {
  const raws: string[] = [];
  let rest = md;
  for (;;) {
    let peeled = false;
    // The candidate nearest the end. An earlier fence's slice swallows the same broken
    // YAML, so reporting that one would name a block the reader cannot find.
    let stopper: string | undefined;
    for (const idx of fenceIndices(rest).slice(-2).reverse()) {
      const result = blockAt(rest, idx);
      if (!result.ok) {
        if (result.reason === 'bad-yaml' && stopper === undefined) stopper = result.message;
        continue;
      }
      raws.unshift(result.raw);
      rest = rest.slice(0, idx);
      peeled = true;
      break;
    }
    if (!peeled) {
      return { body: rest, endmatterRaws: raws, unreadable: stopper ?? null };
    }
  }
}

export function parseEndmatter(raws: string[]): Endmatter {
  const merged: Endmatter = { comments: {}, suggestions: {}, extra: {} };
  for (const raw of raws) {
    let obj: unknown;
    try {
      // Unreachable for raws that came from `splitEndmatter`, which already parsed them.
      // Kept because `parseEndmatter` is exported: a caller with its own raws needs it.
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

/**
 * A body and its endmatter back into one document — always a single closed block.
 *
 * `eol` is required rather than defaulting to LF: a caller that forgot it would rewrite
 * every line of a CRLF file, and a whole-file diff is exactly the kind of damage that
 * arrives without anyone noticing. Pass `doc.eol`.
 */
export function rebuild(body: string, endmatter: Endmatter, eol: '\n' | '\r\n'): string {
  const trimmedBody = body.replace(/\n+$/, '\n');
  const serialized = serializeEndmatter(endmatter);
  const out = serialized.length > 0 ? `${trimmedBody}\n---\n${serialized}---\n` : trimmedBody;
  // `\r?\n`, not `\n`: this is exported, so a caller may hand it a body it never normalised,
  // and doubling a `\r` would corrupt the file rather than merely mis-end its lines.
  return eol === '\r\n' ? out.replace(/\r?\n/g, '\r\n') : out;
}

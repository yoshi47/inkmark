import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { CommentMeta, Endmatter, SuggestionMeta } from './types.js';

export function splitEndmatter(md: string): {
  body: string;
  bodyEnd: number;
  endmatterRaw: string | null;
} {
  const fence = /\n---[ \t]*\n/g;
  let lastIdx = -1;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(md)) !== null) lastIdx = match.index;
  if (lastIdx === -1) return { body: md, bodyEnd: md.length, endmatterRaw: null };

  const after = md.slice(lastIdx).replace(/^\n---[ \t]*\n/, '');
  try {
    const obj: unknown = parseYaml(after);
    if (obj !== null && typeof obj === 'object' && ('comments' in obj || 'suggestions' in obj)) {
      return { body: md.slice(0, lastIdx), bodyEnd: lastIdx, endmatterRaw: after };
    }
  } catch {
    // fall through to return full doc as body
  }
  return { body: md, bodyEnd: md.length, endmatterRaw: null };
}

export function parseEndmatter(raw: string | null): Endmatter {
  const empty: Endmatter = { comments: {}, suggestions: {} };
  if (raw === null || raw.length === 0) return empty;
  try {
    const obj: unknown = parseYaml(raw);
    if (obj === null || typeof obj !== 'object') return empty;
    const rec = obj as Record<string, unknown>;
    const rawComments: unknown = rec['comments'];
    const rawSuggestions: unknown = rec['suggestions'];
    return {
      comments:
        rawComments !== null && typeof rawComments === 'object'
          ? (rawComments as Record<string, CommentMeta>)
          : {},
      suggestions:
        rawSuggestions !== null && typeof rawSuggestions === 'object'
          ? (rawSuggestions as Record<string, SuggestionMeta>)
          : {},
    };
  } catch {
    return empty;
  }
}

export function serializeEndmatter(e: Endmatter): string {
  const hasComments = Object.keys(e.comments).length > 0;
  const hasSuggestions = Object.keys(e.suggestions).length > 0;
  if (!hasComments && !hasSuggestions) return '';
  const out: Record<string, unknown> = {};
  if (hasComments) out['comments'] = e.comments;
  if (hasSuggestions) out['suggestions'] = e.suggestions;
  return stringifyYaml(out);
}

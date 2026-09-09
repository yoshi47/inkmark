import type { Span } from './types.js';
import { rebuild } from './endmatter.js';
import { parse } from './parse.js';

type SuggestionKind = 'insertion' | 'deletion' | 'substitution';
export type SuggestionSpan = Span & { kind: SuggestionKind };

/**
 * Only the three kinds that propose a change can be accepted or rejected. The other two
 * resolve to their own inner text, so applying one splices a note's prose into the body,
 * or quietly unwraps a highlight; either way the endmatter entry goes with it. Exported
 * because the sidebar has to make the same call when it decides whether to offer the
 * buttons, and two copies of this list would drift.
 */
export function isSuggestion(span: Span): span is SuggestionSpan {
  return span.kind === 'insertion' || span.kind === 'deletion' || span.kind === 'substitution';
}

function resolvedText(span: SuggestionSpan, action: 'accept' | 'reject'): string {
  switch (span.kind) {
    case 'insertion':
      return action === 'accept' ? span.inner : '';
    case 'deletion':
      return action === 'accept' ? '' : span.inner;
    case 'substitution':
      return action === 'accept' ? (span.newText ?? '') : (span.oldText ?? '');
  }
}

export function applySuggestion(md: string, id: string, action: 'accept' | 'reject'): string {
  const doc = parse(md);
  const span = doc.spans.find((s) => s.id === id);
  // Declining by returning the input is the convention every other transform here keeps
  // (editComment, removeComment): App.save() reads an unchanged document as "the mark was
  // not what the sidebar took it for" and says so, which is all a throw could achieve.
  if (span === undefined || !isSuggestion(span)) return md;
  const replacement = resolvedText(span, action);
  const newBody = doc.body.slice(0, span.start) + replacement + doc.body.slice(span.end);
  const { [id]: _removedS, ...suggestions } = doc.endmatter.suggestions;
  const { [id]: _removedC, ...comments } = doc.endmatter.comments;
  return rebuild(newBody, { ...doc.endmatter, comments, suggestions }, doc.eol);
}

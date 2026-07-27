import type { Span } from './types.js';
import { rebuild } from './endmatter.js';
import { parse } from './parse.js';

function resolvedText(span: Span, action: 'accept' | 'reject'): string {
  switch (span.kind) {
    case 'insertion':
      return action === 'accept' ? span.inner : '';
    case 'deletion':
      return action === 'accept' ? '' : span.inner;
    case 'substitution':
      return action === 'accept' ? (span.newText ?? '') : (span.oldText ?? '');
    case 'highlight':
    case 'comment':
      return span.inner;
  }
}

export function applySuggestion(md: string, id: string, action: 'accept' | 'reject'): string {
  const doc = parse(md);
  const span = doc.spans.find((s) => s.id === id);
  if (span === undefined) return md;
  const replacement = resolvedText(span, action);
  const newBody = doc.body.slice(0, span.start) + replacement + doc.body.slice(span.end);
  const { [id]: _removedS, ...suggestions } = doc.endmatter.suggestions;
  const { [id]: _removedC, ...comments } = doc.endmatter.comments;
  return rebuild(newBody, { ...doc.endmatter, comments, suggestions });
}

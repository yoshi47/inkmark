// `splitEndmatter` is deliberately not re-exported: its fence regexes are LF-only, so a
// caller reaching it directly with a CRLF file gets "no endmatter" as a success. `parse`
// is the entry that normalises.
export { parseEndmatter, rebuild, serializeEndmatter } from './endmatter.js';
export {
  addReply,
  editComment,
  insertComment,
  insertHighlight,
  removeComment,
  removeHighlight,
  setResolved,
} from './insert.js';
export { nextId, noteFor, noteFreeHighlight, noteSpan, parse, threadIds } from './parse.js';
export { applySuggestion, isSuggestion } from './suggest.js';
export { tokenize } from './tokenize.js';
export * from './types.js';

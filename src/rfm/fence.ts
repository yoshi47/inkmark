const OPENER = /^(`{3,}|~{3,})/;

/**
 * A fenced code block that opens, closes, and occupies whole lines of its own — the one selection
 * CriticMarkup can only mark from the outside. Inside the fence its delimiters would be code
 * (`tokenize` skips fenced ranges); on the fence's own lines they would stop it from being a
 * fence. So a mark takes a line on each side, and only a range that leaves those lines free
 * qualifies.
 *
 * The closing fence is what makes the shape safe, not decoration: an unterminated fence runs to
 * the end of the document, so a closing delimiter written after it lands INSIDE the code, leaving
 * the note as visible code text and no mark at all. Commonmark also lets the closer be longer than
 * the opener and indented up to three spaces, so it is matched by shape rather than by equality.
 */
export function isFencedBlock(body: string, start: number, end: number): boolean {
  if (!(start === 0 || body[start - 1] === '\n')) return false;
  if (!(end === body.length || body[end] === '\n')) return false;
  const src = body.slice(start, end);
  const open = OPENER.exec(src)?.[1];
  if (open === undefined) return false;
  return new RegExp(`\\n {0,3}${open[0] ?? ''}{${String(open.length)},}[ \\t]*$`).test(src);
}

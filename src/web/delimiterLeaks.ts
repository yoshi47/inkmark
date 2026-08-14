// The delimiters a reader should never see. Not `{#c1}`: an id leaks only
// alongside the delimiters that carried it, while `{#anchor}` is a heading-id
// syntax other markdown dialects write on purpose.
const LEAK = /\{==|==\}|\{>>|<<\}|\{\+\+|\+\+\}|\{--|--\}|\{~~|~~\}/g;

const CONTEXT = 20;

/**
 * The delimiters in a run of text, each with what surrounds it.
 *
 * Deliberately blind to where the text came from — a code fence is a caller's
 * idea, not this function's, and the two callers exclude it differently.
 */
export function leakedDelimiters(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LEAK)) {
    const at = m.index;
    const from = Math.max(0, at - CONTEXT);
    out.push(
      text
        .slice(from, at + m[0].length + CONTEXT)
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  return out;
}

/**
 * The delimiters a reader can actually see: same set, but code excluded and
 * the text read from the rendered DOM.
 *
 * The symptom, not the cause. A span that built no mark and a span an element
 * boundary cut in half both end here, while a document that only *documents*
 * the syntax inside a fence does not — which counting marks against spans
 * cannot tell apart. Reading the committed DOM also catches a leak the plugin
 * never saw: `MarkdownView` runs `rehypeSourceSpans` after it.
 */
export function leakedDelimitersIn(root: HTMLElement): string[] {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    // Delimiters typed in code are the author's literal text — showing them is
    // the whole point there.
    const inCode = node.parentElement?.closest('code, pre') ?? null;
    if (inCode !== null) continue;
    parts.push((node as Text).data);
  }
  // Newline, not empty string: skipping a <code> would otherwise weld the text
  // on either side of it together and manufacture a delimiter that is on no
  // screen. The cost is a delimiter split across two text nodes, which needs
  // markup inside the delimiter itself to happen and is nobody's markdown.
  return leakedDelimiters(parts.join('\n'));
}

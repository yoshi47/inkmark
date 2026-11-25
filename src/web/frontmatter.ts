import { parse as parseYaml } from 'yaml';

export interface Frontmatter {
  /** The text between the two fences, without them. */
  yaml: string;
  /** Offset just past the closing fence's line, newline included when there is one. */
  end: number;
}

const FENCE = /^---[ \t]*$/;
// The server reads the file as utf8 without stripping a BOM, so an editor that writes one would
// otherwise push the opening fence off column 0 and the block would render as prose again.
const OPENER = /^\uFEFF?---[ \t]*$/;

/**
 * Whether the text between the fences is metadata at all. A document may open with a plain rule
 * and draw another one further down; without this the prose between the two would vanish into
 * the collapsed block. Empty counts — `---\n---` is how a tool writes frontmatter with no keys —
 * but only literally empty: a lone `# Title` parses as a YAML comment, i.e. null.
 */
function isMetadata(yaml: string): boolean {
  if (yaml.trim() === '') return true;
  let value: unknown;
  try {
    value = parseYaml(yaml);
  } catch {
    return false;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The YAML block a document opens with, or null when it has none.
 *
 * Expects LF line endings: it reads `doc.body`, which `parse` (src/rfm/parse.ts) has already
 * normalised, and a stray CR would leave a fence line that no longer matches.
 *
 * Only line 1 opens one: a `---` anywhere later is the author's rule or setext underline, and
 * reading it as metadata would hide their text. An opener with no closer is not frontmatter
 * either — Jekyll and remark-frontmatter agree, and the alternative is a stray `---` swallowing
 * the whole document into a collapsed block.
 *
 * `---` only, not YAML's `...` end marker: the tools that write frontmatter never close with it,
 * and accepting it would let a line of ellipsis prose end the block early.
 */
export function findFrontmatter(body: string): Frontmatter | null {
  const lines = body.split('\n');
  const first = lines[0] ?? '';
  if (lines.length < 2 || !OPENER.test(first)) return null;
  const yamlStart = first.length + 1;
  let offset = yamlStart;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (FENCE.test(line)) {
      const yaml = body.slice(yamlStart, Math.max(yamlStart, offset - 1));
      if (!isMetadata(yaml)) return null;
      return { yaml, end: Math.min(offset + line.length + 1, body.length) };
    }
    offset += line.length + 1;
  }
  return null;
}

/**
 * `body` with the frontmatter turned into blank lines for the Markdown parser.
 *
 * Blanked rather than cut: every position the renderer reports — the span offsets a selection
 * resolves to, the heading ids, the `data-line` gutter — indexes into the saved file, and keeping
 * each character's slot (newlines where they were, spaces elsewhere) keeps all of them true
 * without a correction pass. Not remark-frontmatter: it would be a new dependency for a block
 * this small, and mdast-util-to-hast drops the node it produces anyway, so the view would still
 * need its own rendering.
 */
export function blankFrontmatter(body: string, fm: Frontmatter | null): string {
  if (fm === null) return body;
  return body.slice(0, fm.end).replace(/[^\n]/g, ' ') + body.slice(fm.end);
}

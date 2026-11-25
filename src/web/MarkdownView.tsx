import type { Root } from 'hast';
import type { JSX, RefObject } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Span } from '../rfm/types.js';
import { assetUrlTransform } from './assetUrl.js';
import { blankFrontmatter, findFrontmatter } from './frontmatter.js';
import { rehypeCriticMarkup } from './rehypeCriticMarkup.js';
import { rehypeHeadingIds } from './rehypeHeadingIds.js';
import { rehypeLineNumbers } from './rehypeLineNumbers.js';
import { rehypeSourceSpans } from './rehypeSourceSpans.js';
import { maskSubstitutions } from './substitutionMask.js';

export function MarkdownView({
  source,
  spans,
  articleRef,
}: {
  source: string;
  spans: Span[];
  articleRef?: RefObject<HTMLElement | null>;
}): JSX.Element {
  const frontmatter = findFrontmatter(source);
  return (
    <article className="article-pane" ref={articleRef}>
      <div className="markdown-body">
        {/* Raw YAML rather than a key/value table: frontmatter nests, and a block that will not
            parse still has to be shown as written. Collapsed, because some (a skill's
            description) run long enough to push the document's first heading off screen. No
            source offsets on it, so a drag inside resolves to nothing: a mark written into the
            YAML would break it for every other tool that reads the file. */}
        {frontmatter !== null && (
          <details className="frontmatter" data-line={1}>
            <summary>Frontmatter</summary>
            <pre>{frontmatter.yaml}</pre>
          </details>
        )}
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[
            (): ((tree: Root) => void) => rehypeCriticMarkup(spans),
            (): ((tree: Root) => void) => rehypeSourceSpans(source),
            rehypeHeadingIds,
            rehypeLineNumbers,
          ]}
          urlTransform={assetUrlTransform}
        >
          {blankFrontmatter(maskSubstitutions(source, spans), frontmatter)}
        </Markdown>
      </div>
    </article>
  );
}

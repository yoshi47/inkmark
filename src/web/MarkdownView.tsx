import type { Root } from 'hast';
import type { JSX, RefObject } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Span } from '../rfm/types.js';
import { assetUrlTransform } from './assetUrl.js';
import { rehypeCriticMarkup } from './rehypeCriticMarkup.js';
import { rehypeHeadingIds } from './rehypeHeadingIds.js';
import { rehypeSourceSpans } from './rehypeSourceSpans.js';

export function MarkdownView({
  source,
  spans,
  articleRef,
}: {
  source: string;
  spans: Span[];
  articleRef?: RefObject<HTMLElement | null>;
}): JSX.Element {
  return (
    <article className="markdown-body" ref={articleRef}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          (): ((tree: Root) => void) => rehypeCriticMarkup(spans),
          (): ((tree: Root) => void) => rehypeSourceSpans(source),
          rehypeHeadingIds,
        ]}
        urlTransform={assetUrlTransform}
      >
        {source}
      </Markdown>
    </article>
  );
}

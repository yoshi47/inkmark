import type { JSX } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeSourceSpans } from './rehypeSourceSpans.js';
import { remarkCriticmarkup } from './remarkCriticmarkup.js';

export function MarkdownView({ source }: { source: string }): JSX.Element {
  return (
    <article className="markdown-body">
      <Markdown remarkPlugins={[remarkGfm, remarkCriticmarkup]} rehypePlugins={[rehypeSourceSpans]}>
        {source}
      </Markdown>
    </article>
  );
}

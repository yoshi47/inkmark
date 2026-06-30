import type { JSX } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkCriticmarkup } from './remarkCriticmarkup.js';

export function MarkdownView({ source }: { source: string }): JSX.Element {
  return (
    <article className="markdown-body">
      <Markdown remarkPlugins={[remarkGfm, remarkCriticmarkup]}>{source}</Markdown>
    </article>
  );
}

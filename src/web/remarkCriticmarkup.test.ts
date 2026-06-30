import rehypeStringify from 'rehype-stringify';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { describe, expect, it } from 'vitest';
import { remarkCriticmarkup } from './remarkCriticmarkup.js';

async function toHtml(src: string): Promise<string> {
  const file = await remark()
    .use(remarkGfm)
    .use(remarkCriticmarkup)
    .use(remarkRehype)
    .use(rehypeStringify)
    .process(src);
  return String(file);
}

describe('remarkCriticmarkup', () => {
  it('wraps a comment span in a mark with data attributes AND keeps inner text', async () => {
    const html = await toHtml('a {==x==}{>>note<<}{#c1} b');
    expect(html).toContain('data-cm-kind="highlight"');
    expect(html).toContain('data-cm-id="c1"');
    expect(html).toMatch(/<mark[^>]*>x<\/mark>/); // inner text must survive
  });
});

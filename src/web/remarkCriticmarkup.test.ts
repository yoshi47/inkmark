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

  it('wraps insertion and deletion in marks with correct kind, preserves inner text and surrounding text', async () => {
    const html = await toHtml('a {++ins++}{#s1} b {--del--}{#s2} c');
    expect(html).toContain('data-cm-kind="insertion"');
    expect(html).toContain('data-cm-kind="deletion"');
    expect(html).toMatch(/<mark[^>]*>ins<\/mark>/);
    expect(html).toMatch(/<mark[^>]*>del<\/mark>/);
    expect(html).toContain('a ');
    expect(html).toContain(' b ');
    expect(html).toContain(' c');
  });

  it('does not wrap substitution in a mark but keeps surrounding text', async () => {
    const html = await toHtml('before {~~old~>new~~}{#s1} after');
    expect(html).not.toContain('data-cm-kind="substitution"');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });
});

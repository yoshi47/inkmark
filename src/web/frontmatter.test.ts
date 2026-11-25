import { describe, expect, it } from 'vitest';
import { blankFrontmatter, findFrontmatter } from './frontmatter.js';

describe('findFrontmatter', () => {
  it('reads the block a document opens with', () => {
    const body = '---\ncreated: 2026-11-25\ntags: [a]\n---\n\n# Title\n';
    expect(findFrontmatter(body)).toEqual({
      yaml: 'created: 2026-11-25\ntags: [a]',
      end: '---\ncreated: 2026-11-25\ntags: [a]\n---\n'.length,
    });
  });

  it('accepts an empty block and trailing whitespace on the fences', () => {
    expect(findFrontmatter('--- \n---\t\nx\n')).toEqual({ yaml: '', end: 10 });
  });

  it('accepts a document that is nothing but frontmatter', () => {
    expect(findFrontmatter('---\na: 1\n---')).toEqual({ yaml: 'a: 1', end: 12 });
  });

  it('ignores a block that does not start on the first line', () => {
    expect(findFrontmatter('\n---\na: 1\n---\n')).toBeNull();
    expect(findFrontmatter('# T\n\n---\na: 1\n---\n')).toBeNull();
  });

  it('ignores an opening fence that is never closed', () => {
    expect(findFrontmatter('---\n# Title\n\ntext\n')).toBeNull();
  });

  it('ignores a document that opens with a rule and draws another one later', () => {
    expect(findFrontmatter('---\n\nIntro para.\n\n---\n\n# H\n')).toBeNull();
    expect(findFrontmatter('---\n# Title\n---')).toBeNull();
  });

  it('ignores a block whose YAML is not a mapping', () => {
    expect(findFrontmatter('---\n- a\n- b\n---\n')).toBeNull();
    expect(findFrontmatter('---\na: [\n---\n')).toBeNull();
  });

  it('reads the block behind a byte order mark', () => {
    const body = '\uFEFF---\na: 1\n---\n# T\n';
    expect(findFrontmatter(body)).toEqual({ yaml: 'a: 1', end: body.indexOf('# T') });
  });

  it('does not take a longer rule or an indented one for a fence', () => {
    expect(findFrontmatter('----\na: 1\n----\n')).toBeNull();
    expect(findFrontmatter(' ---\na: 1\n---\n')).toBeNull();
  });
});

describe('blankFrontmatter', () => {
  it('keeps every offset and line break where it was', () => {
    const body = '---\na: 1\n---\n# T\n';
    const out = blankFrontmatter(body, findFrontmatter(body));
    expect(out).toBe('   \n    \n   \n# T\n');
    expect(out.length).toBe(body.length);
  });

  it('leaves a document without frontmatter alone', () => {
    expect(blankFrontmatter('# T\n', null)).toBe('# T\n');
  });
});

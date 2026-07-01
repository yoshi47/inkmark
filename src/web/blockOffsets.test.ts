import { describe, expect, it } from 'vitest';
import { nearestBlock, sameBlock } from './blockOffsets.js';

describe('nearestBlock', () => {
  it('finds the enclosing paragraph from a nested inline element', () => {
    const root = document.createElement('article');
    root.innerHTML = '<p id="a">x <strong>y</strong> z</p><p id="b">w</p>';
    const strong = root.querySelector('strong');
    if (strong === null) throw new Error('setup');
    expect(nearestBlock(strong.firstChild, root)?.id).toBe('a');
  });

  it('sameBlock is false across two paragraphs', () => {
    const root = document.createElement('article');
    root.innerHTML = '<p id="a">x</p><p id="b">y</p>';
    const a = root.querySelector('#a');
    const b = root.querySelector('#b');
    if (a?.firstChild == null || b?.firstChild == null) throw new Error('setup');
    expect(sameBlock(a.firstChild, b.firstChild, root)).toBe(false);
  });

  it('sameBlock is true for two inline runs in one paragraph', () => {
    const root = document.createElement('article');
    root.innerHTML = '<p id="a">x <strong>y</strong> z</p>';
    const p = root.querySelector('#a');
    const strong = root.querySelector('strong');
    if (p?.firstChild == null || strong?.firstChild == null) throw new Error('setup');
    expect(sameBlock(p.firstChild, strong.firstChild, root)).toBe(true);
  });
});

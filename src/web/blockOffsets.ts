const BLOCK_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'TD',
  'TH',
  'BLOCKQUOTE',
  'DD',
  'DT',
  'PRE',
]);

export function nearestBlock(node: Node | null, root: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el !== null && el !== root) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return null;
}

export function sameBlock(a: Node, b: Node, root: HTMLElement): boolean {
  const ba = nearestBlock(a, root);
  const bb = nearestBlock(b, root);
  return ba !== null && ba === bb;
}

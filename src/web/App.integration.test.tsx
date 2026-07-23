import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const h = vi.hoisted(() => ({
  state: {
    content: 'This is **bold** and plain text.\n',
    path: '/tmp/fake/doc.md',
    version: 'v0',
    puts: [] as { baseVersion: string; content: string }[],
  },
}));

vi.mock('./api.js', () => ({
  getFile: (): Promise<{ content: string; path: string; version: string }> =>
    Promise.resolve({ content: h.state.content, path: h.state.path, version: h.state.version }),
  putFile: (content: string, baseVersion: string): Promise<{ ok: true; version: string }> => {
    h.state.puts.push({ content, baseVersion });
    return Promise.resolve({ ok: true, version: 'v1' });
  },
  subscribe: (): (() => void) => (): void => undefined,
}));

// Import App AFTER the mock is declared (vi.mock is hoisted, so this is safe).
const { App } = await import('./App.js');

const scrolled: Element[] = [];

beforeEach(() => {
  h.state.content = 'This is **bold** and plain text.\n';
  h.state.path = '/tmp/fake/doc.md';
  h.state.puts = [];
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  // jsdom does not implement Range.getBoundingClientRect (used by the popover to
  // position itself); stub it so the end-to-end selection path can run.
  Range.prototype.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 0, 0);
  // jsdom does not implement Element.scrollIntoView either; record the receiver
  // so tests can assert which element was scrolled to.
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element): void {
    scrolled.push(this);
  };
});

test('commenting across bold writes a well-formed highlight', async () => {
  const { container } = render(<App />);

  // 1. wait for content to render (getFile resolves in an effect)
  await waitFor(() => {
    if (container.querySelector('strong') === null) throw new Error('not rendered yet');
  });

  // 2. locate the annotated runs: run at source offset 0 ("This is ") and offset 16 (" and plain text.")
  const runs = Array.from(container.querySelectorAll<HTMLElement>('[data-src-start]'));
  const first = runs.find((s) => s.dataset['srcStart'] === '0');
  const third = runs.find((s) => s.dataset['srcStart'] === '16');
  if (first?.firstChild == null || third?.firstChild == null)
    throw new Error('setup: annotated runs missing');

  // 3. select "This is **bold** and" (rendered: "This is bold and"), crossing the <strong>
  const sel = window.getSelection();
  if (sel === null) throw new Error('no selection');
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(first.firstChild, 0);
  r.setEnd(third.firstChild, 4); // " and"
  sel.addRange(r);
  fireEvent.mouseUp(document);

  // 4. the popover shows the Comment button; stub prompt and click
  const btn = await waitFor(() => {
    const b = container.querySelector<HTMLButtonElement>('.selection-popover button');
    if (b === null) throw new Error('no comment button');
    return b;
  });
  const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('note');
  fireEvent.click(btn);
  promptSpy.mockRestore();

  // 5. the PUT body wraps the correct SOURCE range (incl. the **bold** markup), with a comment + id
  await waitFor(() => {
    if (h.state.puts.length === 0) throw new Error('no PUT captured');
  });
  expect(h.state.puts[0]?.content).toContain('{==This is **bold** and==}{>>note<<}{#c1}');
});

test('commenting on a heading that starts with inline code wraps the whole code span', async () => {
  h.state.content = '## `.zprofile` note\n';

  const { container } = render(<App />);
  await waitFor(() => {
    if (container.querySelector('h2 code') === null) throw new Error('not rendered yet');
  });

  // select from inside the code run to the end of the heading — the start endpoint has no usable
  // interior offset, so it must snap out to the opening backtick. 3 and 14 are source offsets into
  // the content above: "`.zprofile`" starts at 3, " note" at 14.
  const runs = Array.from(container.querySelectorAll<HTMLElement>('[data-src-start]'));
  const code = runs.find((s) => s.dataset['srcStart'] === '3');
  const tail = runs.find((s) => s.dataset['srcStart'] === '14');
  if (code?.firstChild == null || tail?.firstChild == null)
    throw new Error('setup: annotated runs missing');

  const sel = window.getSelection();
  if (sel === null) throw new Error('no selection');
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(code.firstChild, 2);
  r.setEnd(tail.firstChild, 5); // " note"
  sel.addRange(r);
  fireEvent.mouseUp(document);

  const btn = await waitFor(() => {
    const b = container.querySelector<HTMLButtonElement>('.selection-popover button');
    if (b === null) throw new Error('no comment button');
    return b;
  });
  const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('note');
  fireEvent.click(btn);
  promptSpy.mockRestore();

  await waitFor(() => {
    if (h.state.puts.length === 0) throw new Error('no PUT captured');
  });
  expect(h.state.puts[0]?.content).toContain('## {==`.zprofile` note==}{>>note<<}{#c1}');
});

test('clicking a sidebar comment scrolls to its mark', async () => {
  h.state.content = [
    'Intro paragraph.',
    '',
    'Some {==target text==}{>>note<<}{#c1} here.',
    '',
    '---',
    'comments:',
    '  c1:',
    '    by: user',
    '    at: 2026-06-30T00:00:00.000Z',
    '    resolved: false',
    '',
  ].join('\n');

  const { container } = render(<App />);
  const commentButton = await waitFor(() => {
    const b = container.querySelector<HTMLButtonElement>('.comment-sidebar button.comment');
    if (b === null) throw new Error('sidebar not rendered yet');
    return b;
  });

  fireEvent.click(commentButton);

  expect(scrolled).toHaveLength(1);
  expect(scrolled[0]?.tagName).toBe('MARK');
  expect(scrolled[0]).toHaveAttribute('data-cm-id', 'c1');
});

test('clicking the second of two sidebar comments scrolls to that comment, not the first', async () => {
  h.state.content = [
    'One {==alpha==}{>>first<<}{#c1} here.',
    '',
    'Two {==beta==}{>>second<<}{#c2} there.',
    '',
    '---',
    'comments:',
    '  c1:',
    '    by: user',
    '    at: 2026-06-30T00:00:00.000Z',
    '    resolved: false',
    '  c2:',
    '    by: user',
    '    at: 2026-06-30T00:01:00.000Z',
    '    resolved: false',
    '',
  ].join('\n');

  const { container } = render(<App />);
  const buttons = await waitFor(() => {
    const b = container.querySelectorAll<HTMLButtonElement>('.comment-sidebar button.comment');
    if (b.length < 2) throw new Error('sidebar not rendered yet');
    return b;
  });

  const second = buttons[1];
  if (second === undefined) throw new Error('setup: second comment button missing');
  fireEvent.click(second);

  expect(scrolled).toHaveLength(1);
  expect(scrolled[0]).toHaveAttribute('data-cm-id', 'c2');
});

test('clicking an entry whose mark is missing is a safe no-op', async () => {
  // endmatter-only suggestion: no inline span, so no rendered mark
  h.state.content = [
    'No inline spans here.',
    '',
    '---',
    'suggestions:',
    '  s9:',
    '    by: AI',
    '    at: 2026-06-30T00:00:00.000Z',
    '    resolved: false',
    '',
  ].join('\n');

  const { container } = render(<App />);
  const suggestionButton = await waitFor(() => {
    const b = container.querySelector<HTMLButtonElement>(
      '.comment-sidebar button.suggestion-label',
    );
    if (b === null) throw new Error('sidebar not rendered yet');
    return b;
  });

  fireEvent.click(suggestionButton);

  expect(scrolled).toHaveLength(0);
});

test('clicking a sidebar suggestion scrolls to its mark', async () => {
  h.state.content = [
    'Intro paragraph.',
    '',
    'An agent can {++add text++}{#s1} inline.',
    '',
    '---',
    'suggestions:',
    '  s1:',
    '    by: AI',
    '    at: 2026-06-30T00:00:00.000Z',
    '    resolved: false',
    '',
  ].join('\n');

  const { container } = render(<App />);
  const suggestionButton = await waitFor(() => {
    const b = container.querySelector<HTMLButtonElement>(
      '.comment-sidebar button.suggestion-label',
    );
    if (b === null) throw new Error('sidebar not rendered yet');
    return b;
  });

  fireEvent.click(suggestionButton);

  expect(scrolled).toHaveLength(1);
  expect(scrolled[0]?.tagName).toBe('MARK');
  expect(scrolled[0]).toHaveAttribute('data-cm-id', 's1');
});

test('shows the served file path in the header and the tab title', async () => {
  const { container } = render(<App />);

  // getFile resolves in an effect, so wait for the header to render its text
  const header = await waitFor(() => {
    const el = container.querySelector('.app-header');
    if (el?.textContent !== '/tmp/fake/doc.md') throw new Error('header not rendered yet');
    return el;
  });
  expect(header).toHaveAttribute('title', '/tmp/fake/doc.md');
  expect(document.title).toBe('doc.md — inkmark');
});

import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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

// A confirm() stub left standing would silently answer a later test's dialog.
afterEach(() => {
  vi.restoreAllMocks();
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

test('highlighting across bold writes a mark with no comment note', async () => {
  const { container } = render(<App />);

  await waitFor(() => {
    if (container.querySelector('strong') === null) throw new Error('not rendered yet');
  });

  const runs = Array.from(container.querySelectorAll<HTMLElement>('[data-src-start]'));
  const first = runs.find((s) => s.dataset['srcStart'] === '0');
  const third = runs.find((s) => s.dataset['srcStart'] === '16');
  if (first?.firstChild == null || third?.firstChild == null)
    throw new Error('setup: annotated runs missing');

  const sel = window.getSelection();
  if (sel === null) throw new Error('no selection');
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(first.firstChild, 0);
  r.setEnd(third.firstChild, 4); // " and"
  sel.addRange(r);
  fireEvent.mouseUp(document);

  // no window.prompt stub: the highlight path must not ask for a comment body
  const btn = await within(container).findByRole('button', { name: '🖍 Highlight' });
  fireEvent.click(btn);

  await waitFor(() => {
    if (h.state.puts.length === 0) throw new Error('no PUT captured');
  });
  const written = h.state.puts[0]?.content ?? '';
  expect(written).toContain('{==This is **bold** and==}{#c1}');
  expect(written).not.toContain('{>>');

  // the write round-trips into a sidebar thread without a reload
  const entry = await within(container).findByRole('button', { name: /🖍/ });
  expect(entry.textContent).toContain('This is **bold** and');
});

test('a highlight-only mark is listed in the sidebar and scrolls to its mark', async () => {
  h.state.content = [
    'Intro paragraph.',
    '',
    'Some {==target text==}{#c1} here.',
    '',
    '---',
    'comments:',
    '  c1:',
    '    by: user',
    '    at: 2026-07-23T00:00:00.000Z',
    '    resolved: false',
    '',
  ].join('\n');

  const { container } = render(<App />);
  const entry = await waitFor(() => {
    const b = container.querySelector<HTMLButtonElement>('.comment-sidebar button.comment');
    if (b === null) throw new Error('sidebar not rendered yet');
    return b;
  });
  expect(entry.textContent).toContain('target text');

  fireEvent.click(entry);

  expect(scrolled).toHaveLength(1);
  expect(scrolled[0]).toHaveAttribute('data-cm-id', 'c1');
  // a commented thread scrolls to its note mark; a highlight scrolls to the text
  expect(scrolled[0]).toHaveAttribute('data-cm-kind', 'highlight');
});

test('a highlight an agent wrote without endmatter is still listed', async () => {
  h.state.content = 'Some {==agent mark==}{#c1} here.\n';

  const { container } = render(<App />);
  const entry = await within(container).findByRole('button', { name: /🖍/ });
  expect(entry.textContent).toContain('agent mark');
  // no endmatter entry means nothing to resolve
  expect(within(container).queryByRole('button', { name: 'Resolve' })).toBeNull();
});

test('removing a highlight with replies takes the replies with it', async () => {
  h.state.content = [
    'Some {==target text==}{#c1} here.',
    '',
    '---',
    'comments:',
    '  c1:',
    '    by: user',
    '    at: 2026-07-23T00:00:00.000Z',
    '    resolved: false',
    '  c2:',
    '    by: AI',
    '    at: 2026-07-23T00:01:00.000Z',
    '    re: c1',
    '    body: note added later',
    '',
  ].join('\n');

  const { container } = render(<App />);
  await within(container).findByRole('button', { name: /🖍/ });
  expect(container.querySelector('.reply')?.textContent).toContain('note added later');

  // replies are prose and go for good, so even a highlight has to ask first
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(within(container).getByRole('button', { name: 'Remove' }));

  await waitFor(() => {
    if (h.state.puts.length === 0) throw new Error('no PUT captured');
  });
  expect(confirmSpy).toHaveBeenCalledWith('Delete this highlight and its 1 reply?');
  const written = h.state.puts[0]?.content ?? '';
  expect(written).toContain('Some target text here.');
  expect(written).not.toContain('note added later');
});

test('removing a highlight-only mark leaves the plain text behind', async () => {
  h.state.content = [
    'Some {==target text==}{#c1} here.',
    '',
    '---',
    'comments:',
    '  c1:',
    '    by: user',
    '    at: 2026-07-23T00:00:00.000Z',
    '    resolved: false',
    '',
  ].join('\n');

  const confirmSpy = vi.spyOn(window, 'confirm');
  const { container } = render(<App />);
  const remove = await within(container).findByRole('button', { name: 'Remove' });
  fireEvent.click(remove);

  await waitFor(() => {
    if (h.state.puts.length === 0) throw new Error('no PUT captured');
  });
  // nothing but markup is at stake here, so the click goes through unasked
  expect(confirmSpy).not.toHaveBeenCalled();
  const written = h.state.puts[0]?.content ?? '';
  expect(written).toContain('Some target text here.');
  expect(written).not.toContain('{==');
  expect(written).not.toContain('c1:');
});

const COMMENTED_MARK = [
  'Some {==target text==}{>>note<<}{#c1} here.',
  '',
  '---',
  'comments:',
  '  c1:',
  '    by: user',
  '    at: 2026-07-23T00:00:00.000Z',
  '    resolved: false',
  '',
].join('\n');

test('removing a commented mark unwraps it once confirmed', async () => {
  h.state.content = COMMENTED_MARK;
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

  const { container } = render(<App />);
  fireEvent.click(await within(container).findByRole('button', { name: 'Remove' }));

  await waitFor(() => {
    if (h.state.puts.length === 0) throw new Error('no PUT captured');
  });
  expect(confirmSpy).toHaveBeenCalledWith('Delete this comment?');
  expect(h.state.puts[0]?.content).toBe('Some target text here.\n');
});

test('cancelling the confirmation leaves the comment alone', async () => {
  h.state.content = COMMENTED_MARK;
  // jsdom's own confirm() returns undefined, so an unstubbed dialog reads as
  // Cancel — every test that clicks this button has to say which it wants.
  vi.spyOn(window, 'confirm').mockReturnValue(false);

  const { container } = render(<App />);
  fireEvent.click(await within(container).findByRole('button', { name: 'Remove' }));

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.state.puts).toHaveLength(0);
  expect(container.querySelector('mark[data-cm-id="c1"]')).not.toBeNull();
});

test('removing one thread leaves its neighbour alone', async () => {
  h.state.content = [
    'A {==first==}{>>n1<<}{#c1} and {==second==}{>>n2<<}{#c2} B.',
    '',
    '---',
    'comments:',
    '  c1:',
    '    by: user',
    '    at: 2026-07-23T00:00:00.000Z',
    '  c2:',
    '    by: user',
    '    at: 2026-07-23T00:01:00.000Z',
    '',
  ].join('\n');
  vi.spyOn(window, 'confirm').mockReturnValue(true);

  const { container } = render(<App />);
  await waitFor(() => {
    if (container.querySelectorAll('.thread').length !== 2) throw new Error('not rendered yet');
  });
  const second = container.querySelectorAll<HTMLElement>('.thread')[1];
  if (second === undefined) throw new Error('setup: second thread missing');
  fireEvent.click(within(second).getByRole('button', { name: 'Remove' }));

  await waitFor(() => {
    if (h.state.puts.length === 0) throw new Error('no PUT captured');
  });
  const written = h.state.puts[0]?.content ?? '';
  expect(written).toContain('{==first==}{>>n1<<}{#c1}');
  expect(written).toContain('and second B.');
});

test('a Remove the document refuses says so instead of writing', async () => {
  // a suggestion mark an agent gave a comment id: listed as a thread, but not
  // a comment, so removal declines
  h.state.content = [
    'Please cut {--old text--}{#c1} from here.',
    '',
    '---',
    'comments:',
    '  c1:',
    '    by: AI',
    '    at: 2026-07-23T00:00:00.000Z',
    '    body: I suggest deleting this',
    '',
  ].join('\n');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);

  const { container } = render(<App />);
  fireEvent.click(await within(container).findByRole('button', { name: 'Remove' }));

  await waitFor(() => {
    if (alertSpy.mock.calls.length === 0) throw new Error('no alert yet');
  });
  expect(h.state.puts).toHaveLength(0);
});

test('a hand-written mark with no endmatter entry can still be removed', async () => {
  h.state.content = 'Some {==agent mark==}{#c1}{>>agent note<<} here.\n';
  vi.spyOn(window, 'confirm').mockReturnValue(true);

  const { container } = render(<App />);
  fireEvent.click(await within(container).findByRole('button', { name: 'Remove' }));

  await waitFor(() => {
    if (h.state.puts.length === 0) throw new Error('no PUT captured');
  });
  expect(h.state.puts[0]?.content).toBe('Some agent mark here.\n');
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

// A document carrying one of each sidebar entry kind: a commented thread, a
// note-free highlight, and a suggestion.
const MIXED = [
  'A {==commented==}{>>note here<<}{#c1} and a {==plain==}{#c2} and {++added++}{#s1} text.',
  '',
  '---',
  'comments:',
  '  c1:',
  '    by: AI',
  '    at: 2026-07-23T00:00:00.000Z',
  '    body: note here',
  '',
  'suggestions:',
  '  s1:',
  '    by: AI',
  '    at: 2026-07-23T00:00:00.000Z',
  '    resolved: false',
  '',
].join('\n');

async function renderSidebar(content: string): Promise<HTMLElement> {
  h.state.content = content;
  const { container } = render(<App />);
  return waitFor(() => {
    const el = container.querySelector<HTMLElement>('.comment-sidebar');
    if (el === null) throw new Error('sidebar not rendered yet');
    return el;
  });
}

function tab(sidebar: HTMLElement, label: string): HTMLElement {
  return within(sidebar).getByRole('button', { name: new RegExp(`^${label}`) });
}

test('the sidebar lists every entry kind until a filter is chosen', async () => {
  const sidebar = await renderSidebar(MIXED);

  expect(within(sidebar).getByRole('button', { name: /🖍 plain/ })).toBeInTheDocument();
  expect(sidebar.textContent).toContain('note here');
  expect(within(sidebar).getByRole('button', { name: 'Accept' })).toBeInTheDocument();
  expect(tab(sidebar, 'All')).toHaveTextContent('All (3)');
  expect(tab(sidebar, 'Highlights')).toHaveTextContent('Highlights (1)');
});

test('the Highlights filter leaves only note-free highlights', async () => {
  const sidebar = await renderSidebar(MIXED);
  fireEvent.click(tab(sidebar, 'Highlights'));

  expect(within(sidebar).getByRole('button', { name: /🖍 plain/ })).toBeInTheDocument();
  expect(sidebar.textContent).not.toContain('note here');
  expect(within(sidebar).queryByRole('button', { name: 'Accept' })).toBeNull();
});

test('the Comments filter leaves only commented threads', async () => {
  const sidebar = await renderSidebar(MIXED);
  fireEvent.click(tab(sidebar, 'Comments'));

  expect(sidebar.textContent).toContain('note here');
  expect(within(sidebar).queryByRole('button', { name: /🖍/ })).toBeNull();
  expect(within(sidebar).queryByRole('button', { name: 'Accept' })).toBeNull();
});

test('the Suggestions filter leaves only suggestions', async () => {
  const sidebar = await renderSidebar(MIXED);
  fireEvent.click(tab(sidebar, 'Suggestions'));

  expect(within(sidebar).getByRole('button', { name: 'Accept' })).toBeInTheDocument();
  expect(within(sidebar).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  expect(sidebar.querySelectorAll('.thread')).toHaveLength(0);
});

test('going back to All restores every entry', async () => {
  const sidebar = await renderSidebar(MIXED);
  fireEvent.click(tab(sidebar, 'Suggestions'));
  fireEvent.click(tab(sidebar, 'All'));

  expect(sidebar.querySelectorAll('.thread')).toHaveLength(2);
  expect(sidebar.querySelectorAll('.suggestion')).toHaveLength(1);
});

test('a filter that matches nothing says so, an unmarked document does not', async () => {
  const sidebar = await renderSidebar('Plain text with no marks at all.\n');

  expect(sidebar.textContent).not.toContain('Nothing to show.');

  fireEvent.click(tab(sidebar, 'Highlights'));
  expect(sidebar.textContent).toContain('Nothing to show.');
});

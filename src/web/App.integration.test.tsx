import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const h = vi.hoisted(() => ({
  state: {
    content: 'This is **bold** and plain text.\n',
    path: '/tmp/fake/doc.md',
    version: 'v0',
    puts: [] as { baseVersion: string; content: string }[],
    putStatus: 0, // non-zero makes the server refuse the write
  },
}));

vi.mock('./api.js', () => ({
  getFile: (): Promise<{ content: string; path: string; version: string }> =>
    Promise.resolve({ content: h.state.content, path: h.state.path, version: h.state.version }),
  putFile: (
    content: string,
    baseVersion: string,
  ): Promise<{ ok: true; version: string } | { ok: false; status: number }> => {
    if (h.state.putStatus !== 0) return Promise.resolve({ ok: false, status: h.state.putStatus });
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
  h.state.putStatus = 0;
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
    const b = container.querySelector<HTMLElement>('.comment-sidebar .comment');
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
    const b = container.querySelector<HTMLElement>('.comment-sidebar .comment');
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
    const b = container.querySelectorAll<HTMLElement>('.comment-sidebar .comment');
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
    const b = container.querySelector<HTMLElement>('.comment-sidebar .suggestion-label');
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
    const b = container.querySelector<HTMLElement>('.comment-sidebar .suggestion-label');
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

  // getFile resolves in an effect, so wait for the path to render its text
  const path = await waitFor(() => {
    const el = container.querySelector('.app-path');
    if (el?.textContent !== '/tmp/fake/doc.md') throw new Error('header not rendered yet');
    return el;
  });
  expect(path).toHaveAttribute('title', '/tmp/fake/doc.md');
  expect(document.title).toBe('doc.md — inkmark');
});

test('the width control constrains the content column and marks the active preset', async () => {
  const { container } = render(<App />);

  await waitFor(() => {
    if (container.querySelector('.app-path')?.textContent !== '/tmp/fake/doc.md') {
      throw new Error('header not rendered yet');
    }
  });

  const control = container.querySelector<HTMLElement>('.width-control');
  const layout = container.querySelector<HTMLElement>('.layout');
  if (control === null || layout === null) throw new Error('width control not rendered');
  const full = within(control).getByText('Full');
  const narrow = within(control).getByText('680px');

  // Full is the default: pressed, and the column is unconstrained.
  expect(full).toHaveAttribute('aria-pressed', 'true');
  expect(narrow).toHaveAttribute('aria-pressed', 'false');
  expect(layout.style.getPropertyValue('--content-width')).toBe('none');

  fireEvent.click(narrow);

  expect(narrow).toHaveAttribute('aria-pressed', 'true');
  expect(full).toHaveAttribute('aria-pressed', 'false');
  expect(layout.style.getPropertyValue('--content-width')).toBe('680px');

  // Back to Full lifts the constraint again.
  fireEvent.click(full);

  expect(full).toHaveAttribute('aria-pressed', 'true');
  expect(narrow).toHaveAttribute('aria-pressed', 'false');
  expect(layout.style.getPropertyValue('--content-width')).toBe('none');
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

// Scoped to the container: earlier renders are still in the document, so a
// document-wide query would find another test's mark.
function markById(root: HTMLElement, id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`mark[data-cm-id="${id}"]`);
  if (el === null) throw new Error(`no mark for ${id}`);
  return el;
}

async function renderMixed(): Promise<HTMLElement> {
  h.state.content = MIXED;
  const { container } = render(<App />);
  return waitFor(() => {
    const el = container.querySelector<HTMLElement>('.markdown-body');
    if (el?.textContent.includes('commented') !== true) throw new Error('not rendered yet');
    // A mark scrolls to the thread the sidebar registered, so the aside has to
    // have painted too — waiting on the body alone races it.
    if (container.querySelector('.comment-sidebar [data-thread-id]') === null) {
      throw new Error('sidebar not rendered yet');
    }
    return container;
  });
}

test('a note stays out of the body and its mark scrolls to the sidebar thread', async () => {
  const container = await renderMixed();
  const article = container.querySelector<HTMLElement>('.markdown-body');

  expect(article?.textContent).not.toContain('note here');
  const marked = markById(container, 'c1');
  expect(marked).toHaveTextContent('commented');

  fireEvent.click(marked);

  expect(scrolled).toHaveLength(1);
  expect(scrolled[0]).toHaveAttribute('data-thread-id', 'c1');
});

test('a mark whose thread the filter hides still scrolls to it', async () => {
  const container = await renderMixed();
  const sidebar = container.querySelector<HTMLElement>('.comment-sidebar');
  if (sidebar === null) throw new Error('sidebar not rendered');
  fireEvent.click(tab(sidebar, 'Suggestions'));
  expect(sidebar.querySelectorAll('.thread')).toHaveLength(0);

  fireEvent.click(markById(container, 'c1'));

  await waitFor(() => {
    if (scrolled.length === 0) throw new Error('not scrolled yet');
  });
  expect(scrolled[scrolled.length - 1]).toHaveAttribute('data-thread-id', 'c1');
});

test('clicking a mark twice scrolls twice', async () => {
  const container = await renderMixed();
  const marked = markById(container, 'c2');

  fireEvent.click(marked);
  fireEvent.click(marked);

  expect(scrolled).toHaveLength(2);
  expect(scrolled[1]).toHaveAttribute('data-thread-id', 'c2');
});

test('a selected thread does not hold the filter tabs down', async () => {
  const container = await renderMixed();
  const sidebar = container.querySelector<HTMLElement>('.comment-sidebar');
  if (sidebar === null) throw new Error('sidebar not rendered');
  fireEvent.click(markById(container, 'c1'));

  fireEvent.click(tab(sidebar, 'Suggestions'));

  expect(tab(sidebar, 'Suggestions')).toHaveAttribute('aria-pressed', 'true');
  expect(sidebar.querySelectorAll('.thread')).toHaveLength(0);
});

// The whole point of taking a note out of the body: its text has to be legible
// somewhere. An agent writing plain CriticMarkup leaves no endmatter behind.
test('a note an agent wrote without endmatter is still readable in the sidebar', async () => {
  h.state.content = 'A {==commented==}{>>note here<<}{#c1} line.\n';
  const { container } = render(<App />);
  const sidebar = await waitFor(() => {
    const el = container.querySelector<HTMLElement>('.comment-sidebar');
    if (el?.textContent.includes('note here') !== true) throw new Error('not listed yet');
    return el;
  });

  expect(container.querySelector('.markdown-body')?.textContent).not.toContain('note here');
  expect(sidebar.textContent).toContain('note here');
  fireEvent.click(markById(container, 'c1'));
  expect(scrolled[0]).toHaveAttribute('data-thread-id', 'c1');
});

test('clicking a mark with no sidebar entry is a safe no-op', async () => {
  // A mark carrying a reply's id: replies are rendered inside their parent
  // thread, so no row of the sidebar answers to c2 on its own.
  h.state.content = [
    'A {==commented==}{>>note<<}{#c1} and a {==stray==}{#c2} line.',
    '',
    '---',
    'comments:',
    '  c1:',
    '    by: AI',
    '    at: 2026-07-23T00:00:00.000Z',
    '    body: note',
    '  c2:',
    '    by: AI',
    '    at: 2026-07-23T00:00:00.000Z',
    '    re: c1',
    '    body: a reply',
    '',
  ].join('\n');
  const { container } = render(<App />);
  await waitFor(() => {
    if (container.querySelector('mark[data-cm-id="c2"]') === null)
      throw new Error('not rendered yet');
  });
  const sidebar = container.querySelector<HTMLElement>('.comment-sidebar');
  if (sidebar === null) throw new Error('sidebar not rendered');
  fireEvent.click(tab(sidebar, 'Suggestions'));

  fireEvent.click(markById(container, 'c2'));

  expect(scrolled).toHaveLength(0);
  expect(tab(sidebar, 'Suggestions')).toHaveAttribute('aria-pressed', 'true');
});

test('commenting inside a code block marks the whole fence', async () => {
  h.state.content = 'intro\n\n```js\nconst a = 1;\n```\n\nafter\n';
  const { container } = render(<App />);

  const code = await waitFor(() => {
    const el = container.querySelector('pre[data-src-block] code')?.firstChild;
    if (el == null) throw new Error('not rendered yet');
    return el;
  });

  // A partial selection inside the block: it has to widen to the whole fence, since CriticMarkup
  // written between the fences would be code rather than a mark.
  const sel = window.getSelection();
  if (sel === null) throw new Error('no selection');
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(code, 6);
  r.setEnd(code, 9);
  sel.addRange(r);
  fireEvent.mouseUp(document);

  const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('looks wrong');
  fireEvent.click(await within(container).findByRole('button', { name: '💬 Comment' }));
  promptSpy.mockRestore();

  await waitFor(() => {
    if (h.state.puts.length === 0) throw new Error('no PUT captured');
  });
  expect(h.state.puts[0]?.content).toContain(
    'intro\n\n{==\n```js\nconst a = 1;\n```\n==}{>>looks wrong<<}{#c1}\n\nafter\n',
  );
});

test('a marked code block renders inside its mark and reaches the sidebar', async () => {
  h.state.content = [
    '{==',
    '```js',
    'const a = 1;',
    '```',
    '==}{>>looks wrong<<}{#c1}',
    '',
    '---',
    'comments:',
    '  c1:',
    '    by: AI',
    '    at: 2026-07-23T00:00:00.000Z',
    '    body: looks wrong',
    '',
  ].join('\n');
  const { container } = render(<App />);

  const mark = await waitFor(() => {
    const el = container.querySelector('mark[data-cm-id="c1"]');
    if (el === null) throw new Error('not rendered yet');
    return el;
  });

  expect(mark.querySelector('pre code')?.textContent).toBe('const a = 1;\n');
  expect(container.querySelector('.markdown-body')?.querySelector('p:empty')).toBeNull();
  expect(container.querySelector('.comment-sidebar')?.textContent).toContain('looks wrong');

  fireEvent.click(mark);
  expect(scrolled[0]).toHaveAttribute('data-thread-id', 'c1');
});

test('a code block the delimiters have no line for refuses instead of going silent', async () => {
  h.state.content = 'intro\n\n    indented code\n';
  const { container } = render(<App />);

  const code = await waitFor(() => {
    const el = container.querySelector('pre code')?.firstChild;
    if (el == null) throw new Error('not rendered yet');
    return el;
  });
  expect(container.querySelector('pre')).not.toHaveAttribute('data-src-block');

  const sel = window.getSelection();
  if (sel === null) throw new Error('no selection');
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(code, 0);
  r.setEnd(code, 8);
  sel.addRange(r);
  fireEvent.mouseUp(document);

  const hint = await waitFor(() => {
    const el = container.querySelector('.selection-popover .selection-hint');
    if (el === null) throw new Error('no hint');
    return el;
  });
  expect(hint.textContent).toBe('この範囲は選択できません');
  expect(container.querySelector('.selection-popover button')).toBeNull();
});

test('a block highlight is listed in the sidebar with its code as the label', async () => {
  h.state.content = ['{==', '```js', 'const a = 1;', '```', '==}{#c1}', ''].join('\n');
  const { container } = render(<App />);

  const sidebar = await waitFor(() => {
    const el = container.querySelector<HTMLElement>('.comment-sidebar');
    if (el?.querySelector('[data-thread-id="c1"]') == null) throw new Error('not listed yet');
    return el;
  });

  // The label is the mark's inner text — for a block that is the fence itself, newlines and all.
  expect(sidebar.querySelector('[data-thread-id="c1"]')?.textContent).toContain('const a = 1;');
  expect(tab(sidebar, 'Highlights').textContent).toBe('Highlights (1)');
});

test('a selection with nothing to anchor to refuses instead of going silent', async () => {
  // A note rendered as a bare 💬 marker: no source offsets, so nothing to anchor a mark to.
  h.state.content = 'A {>>memo<<}{#c1} line.\n';
  const { container } = render(<App />);

  const marker = await waitFor(() => {
    const el = container.querySelector('mark[data-cm-id="c1"]')?.firstChild;
    if (el == null) throw new Error('not rendered yet');
    return el;
  });

  const sel = window.getSelection();
  if (sel === null) throw new Error('no selection');
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(marker, 0);
  r.setEnd(marker, 1);
  sel.addRange(r);
  fireEvent.mouseUp(document);

  const hint = await waitFor(() => {
    const el = container.querySelector('.selection-popover .selection-hint');
    if (el === null) throw new Error('no hint');
    return el;
  });
  expect(hint.textContent).toBe('この範囲は選択できません');
});

// --- copying a comment ---------------------------------------------------
// The labels are role="button" divs, not <button>s, so their text can be
// selected; the price is that a drag ending inside one still fires a click.

const ONE_COMMENT = [
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

function standingSelection(text: string): void {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    toString: () => text,
  } as unknown as Selection);
}

test('a drag that selects a sidebar comment leaves the document where it is', async () => {
  h.state.content = ONE_COMMENT;
  const { container } = render(<App />);
  const label = await waitFor(() => {
    const el = container.querySelector<HTMLElement>('.comment-sidebar .comment');
    if (el === null) throw new Error('sidebar not rendered yet');
    return el;
  });

  standingSelection('target');
  fireEvent.click(label);

  expect(scrolled).toHaveLength(0);
});

test('a drag that selects marked body text leaves the sidebar where it is', async () => {
  h.state.content = ONE_COMMENT;
  const { container } = render(<App />);
  const mark = await waitFor(() => {
    const el = container.querySelector<HTMLElement>('mark[data-cm-id="c1"]');
    if (el === null) throw new Error('not rendered yet');
    return el;
  });

  standingSelection('target');
  fireEvent.click(mark);

  expect(scrolled).toHaveLength(0);
});

test('a click with only whitespace selected still opens the thread', async () => {
  h.state.content = ONE_COMMENT;
  const { container } = render(<App />);
  const label = await waitFor(() => {
    const el = container.querySelector<HTMLElement>('.comment-sidebar .comment');
    if (el === null) throw new Error('sidebar not rendered yet');
    return el;
  });

  // A range left over the padding between rows selects nothing a user could
  // copy, and must not stand in the way of the click.
  standingSelection('   ');
  fireEvent.click(label);

  expect(scrolled).toHaveLength(1);
});

test('selecting a comment in the sidebar offers no mark toolbar', async () => {
  h.state.content = ONE_COMMENT;
  const { container } = render(<App />);
  const label = await waitFor(() => {
    const el = container.querySelector<HTMLElement>('.comment-sidebar .comment');
    if (el?.firstChild == null) throw new Error('sidebar not rendered yet');
    return el;
  });

  const sel = window.getSelection();
  if (sel === null) throw new Error('no selection');
  sel.removeAllRanges();
  const r = document.createRange();
  r.selectNodeContents(label);
  sel.addRange(r);
  fireEvent.mouseUp(document);

  expect(container.querySelector('.selection-popover')).toBeNull();
});

test.each([
  ['Enter', { key: 'Enter' }],
  ['Space', { key: ' ' }],
])('a sidebar comment answers %s from the keyboard', async (_name, event) => {
  h.state.content = ONE_COMMENT;
  const { container } = render(<App />);
  const label = await waitFor(() => {
    const el = container.querySelector<HTMLElement>('.comment-sidebar .comment');
    if (el === null) throw new Error('sidebar not rendered yet');
    return el;
  });

  expect(label).toHaveAttribute('tabindex', '0');
  fireEvent.keyDown(label, event);

  expect(scrolled).toHaveLength(1);
  expect(scrolled[0]).toHaveAttribute('data-cm-id', 'c1');
});

test('a held key scrolls once, not once per repeat', async () => {
  h.state.content = ONE_COMMENT;
  const { container } = render(<App />);
  const label = await waitFor(() => {
    const el = container.querySelector<HTMLElement>('.comment-sidebar .comment');
    if (el === null) throw new Error('sidebar not rendered yet');
    return el;
  });

  fireEvent.keyDown(label, { key: 'Enter' });
  fireEvent.keyDown(label, { key: 'Enter', repeat: true });
  fireEvent.keyDown(label, { key: 'Enter', repeat: true });

  expect(scrolled).toHaveLength(1);
});

test('a long highlight is listed in full, so the whole quote can be copied', async () => {
  const quote = 'x'.repeat(200);
  const sidebar = await renderSidebar(`A {==${quote}==}{#c1} line.\n`);

  const label = sidebar.querySelector<HTMLElement>('.comment');
  expect(label?.textContent).toContain(quote);
  // The bound on a quote this long is now the scroll box the stylesheet gives
  // a highlight thread, so the class that rule hangs on is part of the deal.
  expect(label?.closest('.thread')).toHaveClass('highlight');
});

const THREAD = [
  'Some {==target==}{>>first note<<}{#c1} here.',
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
  '    body: a reply',
  '',
].join('\n');

async function renderThread(): Promise<HTMLElement> {
  h.state.content = THREAD;
  const { container } = render(<App />);
  return waitFor(() => {
    const el = container.querySelector<HTMLElement>('[data-thread-id="c1"]');
    if (el === null) throw new Error('thread not rendered yet');
    return el;
  });
}

// The reply's Edit button and the thread's own share a name, so they are told
// apart by the row they sit in rather than by order.
function editButton(thread: HTMLElement, where: 'thread' | 'reply'): HTMLElement {
  const found = within(thread)
    .getAllByRole('button', { name: 'Edit' })
    .find((b) => (b.closest('.reply') === null) === (where === 'thread'));
  if (found === undefined) throw new Error(`no ${where} Edit button`);
  return found;
}

async function lastPut(): Promise<string> {
  await waitFor(() => {
    if (h.state.puts.length === 0) throw new Error('no PUT captured');
  });
  return h.state.puts[h.state.puts.length - 1]?.content ?? '';
}

test('a reply is written in a textarea that Enter sends', async () => {
  const thread = await renderThread();
  const box = within(thread).getByPlaceholderText('Reply…');

  expect(box.tagName).toBe('TEXTAREA');
  fireEvent.change(box, { target: { value: 'answer' } });
  fireEvent.keyDown(box, { key: 'Enter' });

  expect(await lastPut()).toContain('body: answer');
});

test('Shift+Enter in a reply does not send', async () => {
  const thread = await renderThread();
  const box = within(thread).getByPlaceholderText('Reply…');
  fireEvent.change(box, { target: { value: 'still typing' } });

  fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });

  expect(h.state.puts).toHaveLength(0);
  expect(box).toHaveValue('still typing');
});

test('an Enter that closes an IME conversion does not send', async () => {
  const thread = await renderThread();
  const box = within(thread).getByPlaceholderText('Reply…');
  fireEvent.change(box, { target: { value: '変換中' } });

  fireEvent.keyDown(box, { key: 'Enter', isComposing: true });

  expect(h.state.puts).toHaveLength(0);
  expect(box).toHaveValue('変換中');
});

// A note in the prose cannot hold a line break, so its editor sends on Enter
// whether or not Shift is down.
test('Shift+Enter saves a comment whose note lives in the body', async () => {
  const thread = await renderThread();
  fireEvent.click(editButton(thread, 'thread'));
  const box = within(thread).getByDisplayValue('first note');

  fireEvent.change(box, { target: { value: 'shifted note' } });
  fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });

  expect(await lastPut()).toContain('{>>shifted note<<}{#c1}');
});

test('a line break pasted into a body note is refused by name', async () => {
  const thread = await renderThread();
  fireEvent.click(editButton(thread, 'thread'));
  const box = within(thread).getByDisplayValue('first note');

  fireEvent.change(box, { target: { value: 'one\ntwo' } });
  fireEvent.click(within(thread).getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    if (vi.mocked(window.alert).mock.calls.length === 0) throw new Error('no alert yet');
  });
  expect(vi.mocked(window.alert)).toHaveBeenCalledWith('本文中のコメントは改行を含められません。');
  expect(h.state.puts).toHaveLength(0);
});

test('a refused save keeps the text in the editor', async () => {
  const thread = await renderThread();
  h.state.putStatus = 500;
  fireEvent.click(editButton(thread, 'thread'));
  const box = within(thread).getByDisplayValue('first note');
  fireEvent.change(box, { target: { value: 'a long note nobody wants to retype' } });

  fireEvent.click(within(thread).getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    if (vi.mocked(window.alert).mock.calls.length === 0) throw new Error('no alert yet');
  });
  expect(
    within(thread).getByDisplayValue('a long note nobody wants to retype'),
  ).toBeInTheDocument();
});

test('a note-free highlight offers nothing to edit', async () => {
  h.state.content = 'Some {==target==}{#c1} here.\n';
  const { container } = render(<App />);
  const thread = await waitFor(() => {
    const el = container.querySelector<HTMLElement>('[data-thread-id="c1"]');
    if (el === null) throw new Error('thread not rendered yet');
    return el;
  });

  expect(within(thread).queryAllByRole('button', { name: 'Edit' })).toHaveLength(0);
});

test('closing an untouched reply editor saves nothing and says nothing', async () => {
  const thread = await renderThread();
  fireEvent.click(editButton(thread, 'reply'));

  fireEvent.click(within(thread).getByRole('button', { name: 'Save' }));

  expect(h.state.puts).toHaveLength(0);
  expect(vi.mocked(window.alert)).not.toHaveBeenCalled();
});

test('an empty box cannot be sent', async () => {
  const thread = await renderThread();

  expect(within(thread).getByRole('button', { name: 'Send' })).toBeDisabled();
});

test('editing a comment rewrites its note and leaves the mark and its author alone', async () => {
  const thread = await renderThread();
  fireEvent.click(editButton(thread, 'thread'));

  const box = within(thread).getByDisplayValue('first note');
  fireEvent.change(box, { target: { value: 'second note' } });
  fireEvent.click(within(thread).getByRole('button', { name: 'Save' }));

  const written = await lastPut();
  expect(written).toContain('{==target==}{>>second note<<}{#c1}');
  expect(written).toContain('at: 2026-07-23T00:00:00.000Z');
});

test('editing a reply rewrites only its body', async () => {
  const thread = await renderThread();
  fireEvent.click(editButton(thread, 'reply'));

  const box = within(thread).getByDisplayValue('a reply');
  fireEvent.change(box, { target: { value: 'a better reply' } });
  fireEvent.click(within(thread).getByRole('button', { name: 'Save' }));

  const written = await lastPut();
  expect(written).toContain('body: a better reply');
  expect(written).toContain('{>>first note<<}{#c1}');
});

test('closing an editor without a change saves nothing and says nothing', async () => {
  const thread = await renderThread();
  fireEvent.click(editButton(thread, 'thread'));

  fireEvent.click(within(thread).getByRole('button', { name: 'Save' }));

  expect(h.state.puts).toHaveLength(0);
  expect(vi.mocked(window.alert)).not.toHaveBeenCalled();
  expect(within(thread).queryByDisplayValue('first note')).toBeNull();
});

test('Escape closes an editor and keeps the note as it was', async () => {
  const thread = await renderThread();
  fireEvent.click(editButton(thread, 'thread'));
  const box = within(thread).getByDisplayValue('first note');

  fireEvent.change(box, { target: { value: 'discarded' } });
  fireEvent.keyDown(box, { key: 'Escape' });

  expect(h.state.puts).toHaveLength(0);
  expect(thread.textContent).toContain('first note');
});

import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const h = vi.hoisted(() => ({
  state: {
    content: 'This is **bold** and plain text.\n',
    version: 'v0',
    puts: [] as { baseVersion: string; content: string }[],
  },
}));

vi.mock('./api.js', () => ({
  getFile: (): Promise<{ content: string; version: string }> =>
    Promise.resolve({ content: h.state.content, version: h.state.version }),
  putFile: (content: string, baseVersion: string): Promise<{ ok: true; version: string }> => {
    h.state.puts.push({ content, baseVersion });
    return Promise.resolve({ ok: true, version: 'v1' });
  },
  subscribe: (): (() => void) => (): void => undefined,
}));

// Import App AFTER the mock is declared (vi.mock is hoisted, so this is safe).
const { App } = await import('./App.js');

beforeEach(() => {
  h.state.puts = [];
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  // jsdom does not implement Range.getBoundingClientRect (used by the popover to
  // position itself); stub it so the end-to-end selection path can run.
  Range.prototype.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 0, 0);
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

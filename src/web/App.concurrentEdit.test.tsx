import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

// A deterministic content->version function. The real server hashes with sha256
// (src/server/version.ts); this test only needs distinct contents to get distinct
// versions and equal contents to match, and node's crypto is out of the web tsconfig.
function computeVersion(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) hash = (hash * 31 + content.charCodeAt(i)) | 0;
  return `${String(content.length)}-${(hash >>> 0).toString(16)}`;
}

// What this file guards: the 409 → refetch → re-apply retry path (App.tsx save,
// Success Criterion #5). The shared mock in App.integration.test.tsx never 409s,
// so this file owns the conflict path with a faithful lock: PUT succeeds only when
// baseVersion still matches what the server holds, otherwise 409 with the current
// version — the contract of src/server/app.ts:54.
//
// What it does NOT guard: the ref→state fix in App.tsx (version paired with
// content). That bug only surfaces in the commit gap where a ref has advanced but
// the content state has not, which act() collapses — so it cannot be reproduced
// deterministically through the DOM. The decoupling guarantee rests on the comment
// at App.tsx:32 and code review, not on this test.
const server = vi.hoisted(() => ({
  state: {
    content: '',
    version: '',
    path: '/tmp/fake/doc.md',
    puts: [] as { baseVersion: string; content: string }[],
  },
}));

vi.mock('./api.js', () => ({
  getFile: (): Promise<{ content: string; path: string; version: string }> =>
    Promise.resolve({
      content: server.state.content,
      path: server.state.path,
      version: server.state.version,
    }),
  putFile: (
    content: string,
    baseVersion: string,
  ): Promise<{ ok: true; version: string } | { ok: false; status: number; version?: string }> => {
    server.state.puts.push({ content, baseVersion });
    if (baseVersion !== server.state.version) {
      return Promise.resolve({ ok: false as const, status: 409, version: server.state.version });
    }
    server.state.content = content;
    server.state.version = computeVersion(content);
    return Promise.resolve({ ok: true as const, version: server.state.version });
  },
  // No external change is delivered in this file, so the callback is never needed.
  subscribe: (): (() => void) => (): void => undefined,
}));

const { App } = await import('./App.js');

function setServer(content: string): void {
  server.state.content = content;
  server.state.version = computeVersion(content);
}

beforeEach(() => {
  server.state.path = '/tmp/fake/doc.md';
  server.state.puts = [];
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  Range.prototype.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 0, 0);
  Element.prototype.scrollIntoView = function (): void {
    return undefined;
  };
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {
        return undefined;
      }
      unobserve(): void {
        return undefined;
      }
      disconnect(): void {
        return undefined;
      }
      takeRecords(): [] {
        return [];
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// A line above the mark: whether it survives is the whole test. If a stale body
// is written back, this reverts to keep-this-line — the bug the fix removes.
function withHeadline(headline: string): string {
  return [
    headline,
    '',
    'Some {==target==}{>>note<<}{#c1} here.',
    '',
    '---',
    'comments:',
    '  c1:',
    '    by: user',
    '    at: 2026-07-23T00:00:00.000Z',
    '    resolved: false',
    '',
  ].join('\n');
}

const DOC_V0 = withHeadline('Alpha keep-this-line.');
// The assistant's on-disk edit, made while the viewer is open but before it refreshes.
const DOC_V1 = withHeadline('Alpha CORRECTED-line.');

test('a reply saved against a stale body re-applies onto the newer server version', async () => {
  setServer(DOC_V0);
  const { container } = render(<App />);

  const thread = await waitFor(() => {
    const el = container.querySelector<HTMLElement>('[data-thread-id="c1"]');
    if (el === null) throw new Error('thread not rendered');
    return el;
  });
  await act(async () => {
    await Promise.resolve();
  });

  // The file changes on disk (server -> V1) without the viewer being told: the
  // browser's content and its baseVersion are both still V0.
  setServer(DOC_V1);

  const box = within(thread).getByPlaceholderText('Reply…');
  fireEvent.change(box, { target: { value: 'my reply' } });
  fireEvent.keyDown(box, { key: 'Enter' });

  await waitFor(() => {
    if (server.state.puts.length < 2) throw new Error('expected a 409 then a retry');
  });
  await act(async () => {
    await Promise.resolve();
  });

  // The corrected headline the assistant wrote must still be on the server, and
  // the reply must have landed on top of it — not clobbered it.
  expect(server.state.content).toContain('Alpha CORRECTED-line.');
  expect(server.state.content).not.toContain('Alpha keep-this-line.');
  expect(server.state.content).toContain('body: my reply');

  // The first PUT is refused (stale baseVersion), the last one carries the fresh one.
  expect(server.state.puts[0]?.baseVersion).toBe(computeVersion(DOC_V0));
  expect(server.state.puts[server.state.puts.length - 1]?.baseVersion).toBe(computeVersion(DOC_V1));
});

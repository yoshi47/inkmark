import { afterEach, expect, test, vi } from 'vitest';
import { getLive, putLive } from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(body: unknown): void {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(body))));
}

// A server started before the upgrade serves this bundle but answers in the old shape.
test('a live answer without a watcher reads as nobody waiting', async () => {
  answer({ armed: true, enabled: true });
  expect(await getLive()).toEqual({ armed: true, enabled: true, watcher: null });
  answer({ armed: false, enabled: true });
  expect(await putLive(false)).toEqual({ armed: false, enabled: true, watcher: null });
});

test('a live answer with a watcher passes it through', async () => {
  const watcher = { agent: 'claude', session: 's', project: '/p', since: 'T' };
  answer({ armed: true, enabled: true, watcher });
  expect(await getLive()).toEqual({ armed: true, enabled: true, watcher });
});

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FileStore } from './fileStore.js';
import type { FileWatcher } from './watch.js';
import { resolveAsset } from './assets.js';
import { readConfig, updateConfig } from './config.js';
import { readLiveState, setArmed } from './liveState.js';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function createApp(store: FileStore, watcher?: FileWatcher): Hono {
  const app = new Hono();

  // DNS-rebinding guard: only accept requests addressed to localhost.
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!LOCAL_HOST.test(host)) return c.text('forbidden', 403);
    return next();
  });

  // Identity, not content. `stop` has to know whether the process on this port is the
  // inkmark its registry record claims before it signals a pid, and asking `/api/file`
  // conflates "who are you" with "can you read the file right now" — a chmod, a rename or
  // a git checkout in flight would make a healthy server disown itself.
  app.get('/api/whoami', (c) => c.json({ path: store.absPath }));

  // One config for every document (see config.ts). Read on each request rather than cached, so a
  // hand edit of config.yml reaches an already-open tab on its next load without a restart.
  app.get('/api/config', async (c) => c.json(await readConfig()));

  app.put('/api/config', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    // Arrays pass a `typeof` test; they are not a patch of settings.
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'config required' }, 400);
    }
    try {
      return c.json(await updateConfig(body));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return c.json({ error: 'permission denied' }, 403);
      console.error('config write failed:', err);
      return c.json({ error: 'write failed' }, 500);
    }
  });

  // Live mode is per document, unlike the layout config: it is a switch on *this* review, not a
  // viewer preference. `enabled` carries the master switch from config.yml so the header can
  // explain why a document that is armed still wakes nobody.
  app.get('/api/live', async (c) => {
    const state = await readLiveState(store.absPath);
    const config = await readConfig();
    return c.json({ armed: state?.armed !== false, enabled: config.live !== false });
  });

  app.put('/api/live', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const on =
      typeof body === 'object' && body !== null ? (body as { on?: unknown }).on : undefined;
    if (typeof on !== 'boolean') return c.json({ error: 'on required' }, 400);
    try {
      const state = await setArmed(store.absPath, on);
      const config = await readConfig();
      return c.json({ armed: state.armed !== false, enabled: config.live !== false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return c.json({ error: 'permission denied' }, 403);
      console.error('live state write failed:', err);
      return c.json({ error: 'write failed' }, 500);
    }
  });

  app.get('/api/file', async (c) => {
    try {
      const { content, version } = await store.read();
      return c.json({ content, version, path: store.absPath });
    } catch (err) {
      console.error('read failed:', err);
      return c.json({ error: 'read failed' }, 500);
    }
  });

  app.put('/api/file', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      content?: string;
      baseVersion?: string;
    } | null;
    if (body === null || typeof body.content !== 'string' || typeof body.baseVersion !== 'string') {
      return c.json({ error: 'content and baseVersion required' }, 400);
    }
    let current: Awaited<ReturnType<typeof store.read>>;
    try {
      current = await store.read();
    } catch (err) {
      console.error('read failed:', err);
      return c.json({ error: 'read failed' }, 500);
    }
    // TOCTOU window between version check and write is acceptable for a single-process local server.
    if (current.version !== body.baseVersion) {
      return c.json({ error: 'version conflict', version: current.version }, 409);
    }
    try {
      const version = await store.write(body.content);
      return c.json({ version });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return c.json({ error: 'permission denied' }, 403);
      console.error('write failed:', err);
      return c.json({ error: 'write failed' }, 500);
    }
  });

  // Images the document references by path. Registered before the SPA fallthrough, which would
  // otherwise answer an asset request with index.html.
  app.get('/api/asset', async (c) => {
    const requested = c.req.query('path');
    if (requested === undefined || requested === '') {
      return c.json({ error: 'path required' }, 400);
    }
    const asset = await resolveAsset(store.absPath, requested);
    if (asset === null) return c.json({ error: 'not found' }, 404);
    try {
      const bytes = await readFile(asset.path);
      return c.body(new Uint8Array(bytes), 200, {
        'cache-control': 'no-cache',
        'content-type': asset.mime,
        'x-content-type-options': 'nosniff',
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return c.json({ error: 'permission denied' }, 403);
      console.error('asset read failed:', err);
      return c.json({ error: 'read failed' }, 500);
    }
  });

  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      if (watcher === undefined) return;
      const off = watcher.onChange((version) => {
        if (!stream.aborted) void stream.writeSSE({ data: JSON.stringify({ version }) });
      });
      stream.onAbort(() => {
        off();
      });
      while (!stream.aborted) await stream.sleep(30_000);
    });
  });

  // Absolute path to the bundled SPA: dist/web sits next to dist/server at runtime.
  const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('/*', serveStatic({ path: `${webRoot}index.html` }));

  return app;
}

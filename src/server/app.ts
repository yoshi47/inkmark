import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { fileURLToPath } from 'node:url';
import type { FileStore } from './fileStore.js';
import type { FileWatcher } from './watch.js';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function createApp(store: FileStore, watcher?: FileWatcher): Hono {
  const app = new Hono();

  // DNS-rebinding guard: only accept requests addressed to localhost.
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!LOCAL_HOST.test(host)) return c.text('forbidden', 403);
    return next();
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

import { Hono } from 'hono';
import type { FileStore } from './fileStore.js';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function createApp(store: FileStore): Hono {
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
      return c.json({ content, version });
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

  return app;
}

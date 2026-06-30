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

  return app;
}

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { FileStore } from './fileStore.js';
import { FileWatcher } from './watch.js';

export function startServer(
  absPath: string,
  port: number,
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const store = new FileStore(absPath);
  const watcher = new FileWatcher(store);
  watcher.start();
  const app = createApp(store, watcher);
  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  const url = `http://localhost:${String(port)}`;
  return Promise.resolve({
    url,
    port,
    close: async (): Promise<void> => {
      await watcher.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  });
}

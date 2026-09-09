import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { FileStore } from './fileStore.js';
import { FileWatcher } from './watch.js';

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export function startServer(absPath: string, port: number): Promise<RunningServer> {
  const store = new FileStore(absPath);
  const watcher = new FileWatcher(store);
  watcher.start();
  const app = createApp(store, watcher);

  return new Promise<RunningServer>((resolve, reject) => {
    let settled = false;
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
      settled = true;
      // Report the port we actually bound, not the one we asked for: port 0 means
      // "any free port", and the caller needs a URL that resolves.
      const bound = info.port;
      resolve({
        url: `http://localhost:${String(bound)}`,
        port: bound,
        close: async (): Promise<void> => {
          await watcher.close();
          await new Promise<void>((done) => {
            server.close(() => {
              done();
            });
            // `/api/events` is an open SSE stream, so every browser sitting on the page
            // is a connection `close()` would wait on forever. Cut them. Guarded because
            // `ServerType` also covers Http2Server, which has no such method.
            if ('closeAllConnections' in server) server.closeAllConnections();
          });
        },
      });
    });
    server.on('error', (err: Error) => {
      if (settled) {
        // Past listen this is the only channel the server has; the CLI is parked on a
        // promise that never settles, so stderr is where it has to go.
        console.error('inkmark: server error:', err);
        return;
      }
      // A listen failure (EADDRINUSE) arrives before the listening callback. Tear the
      // watcher down here — nobody else holds a handle to it yet. Its own failure must
      // not become an unhandled rejection that outranks the bind error we are reporting.
      settled = true;
      void watcher
        .close()
        .catch(() => undefined)
        .finally(() => {
          reject(err);
        });
    });
  });
}

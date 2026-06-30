import { createServer } from 'node:net';

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => {
      resolve(false);
    });
    srv.once('listening', () => {
      srv.close(() => {
        resolve(true);
      });
    });
    srv.listen(port, '127.0.0.1');
  });
}

export async function findFreePort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 50; p++) {
    if (await isFree(p)) return p;
  }
  return new Promise((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : preferred;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

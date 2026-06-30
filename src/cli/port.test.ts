import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { findFreePort } from './port.js';

describe('findFreePort', () => {
  it('returns the preferred port when free', async () => {
    const free = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        s.close(() => {
          resolve(port);
        });
      });
      s.once('error', reject);
    });
    expect(await findFreePort(free)).toBe(free);
  });

  it('falls through when the preferred port is taken', async () => {
    const { port: taken, server } = await new Promise<{
      port: number;
      server: ReturnType<typeof createServer>;
    }>((resolve, reject) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve({ port, server: s });
      });
      s.once('error', reject);
    });
    try {
      const p = await findFreePort(taken);
      expect(p).not.toBe(taken);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});

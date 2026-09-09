import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findFreePort } from '../cli/port.js';
import { startServer } from './start.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inkmark-'));
  file = join(dir, 'doc.md');
  await writeFile(file, 'Hello\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('startServer', () => {
  it('reports the port it actually bound, and serves on it', async () => {
    const server = await startServer(file, 0);
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://localhost:${String(server.port)}`);

    const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/file`);
    expect(res.status).toBe(200);
    await server.close();
  });

  it('closes even while a client holds the /api/events stream open', async () => {
    const port = await findFreePort(4900);
    const server = await startServer(file, port);
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/events`);
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    // Pull once so the stream is really established; it settles when the server hangs up.
    const pending = reader?.read().catch(() => undefined);

    const closed = server.close().then(() => 'closed' as const);
    const hung = new Promise<'hung'>((r) => {
      setTimeout(() => {
        r('hung');
      }, 3000);
    });
    expect(await Promise.race([closed, hung])).toBe('closed');

    await reader?.cancel().catch(() => undefined);
    await pending;
  }, 10_000);

  it('rejects instead of throwing an unhandled error when the port is taken', async () => {
    const { port, blocker } = await new Promise<{ port: number; blocker: Server }>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        resolve({ port: typeof addr === 'object' && addr !== null ? addr.port : 0, blocker: s });
      });
    });
    try {
      await expect(startServer(file, port)).rejects.toThrow();
    } finally {
      await new Promise<void>((done) => {
        blocker.close(() => {
          done();
        });
      });
    }
  });
});

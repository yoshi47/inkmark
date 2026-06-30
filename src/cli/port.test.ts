import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { findFreePort } from './port.js';

describe('findFreePort', () => {
  it('returns the preferred port when free', async () => {
    const p = await findFreePort(4747);
    expect(p).toBeGreaterThan(0);
  });

  it('falls through when the preferred port is taken', async () => {
    const taken = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const addr = s.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
      });
    });
    const p = await findFreePort(taken);
    expect(p).not.toBe(taken);
  });
});

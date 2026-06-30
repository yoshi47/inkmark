import type { Hono } from 'hono';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { FileStore } from './fileStore.js';

let dir: string;
let file: string;
let app: Hono;
const LOCAL = { headers: { host: 'localhost:4747' } };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inkmark-'));
  file = join(dir, 'doc.md');
  await writeFile(file, 'Hello\n');
  app = createApp(new FileStore(file));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/file', () => {
  it('returns content and a version', async () => {
    const res = await app.request('/api/file', LOCAL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; version: string };
    expect(body.content).toBe('Hello\n');
    expect(body.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects a non-localhost Host header', async () => {
    const res = await app.request('/api/file', { headers: { host: 'evil.com' } });
    expect(res.status).toBe(403);
  });

  it('rejects a request with no Host header', async () => {
    const res = await app.request('/api/file');
    expect(res.status).toBe(403);
  });

  it('rejects a subdomain-suffix bypass attempt (localhost.evil.com)', async () => {
    const res = await app.request('/api/file', { headers: { host: 'localhost.evil.com' } });
    expect(res.status).toBe(403);
  });

  it('allows IPv6 loopback host ([::1]:4747)', async () => {
    const res = await app.request('/api/file', { headers: { host: '[::1]:4747' } });
    expect(res.status).toBe(200);
  });
});

import type { Hono } from 'hono';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
  it('returns content, a version, and the served file path', async () => {
    const res = await app.request('/api/file', LOCAL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; path: string; version: string };
    expect(body.content).toBe('Hello\n');
    expect(body.version).toMatch(/^[0-9a-f]{16}$/);
    expect(body.path).toBe(file);
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

describe('PUT /api/file', () => {
  it('writes when baseVersion matches and returns a new version', async () => {
    const store = new FileStore(file);
    const putApp = createApp(store);
    const { version } = await store.read();
    const res = await putApp.request('/api/file', {
      method: 'PUT',
      headers: { host: 'localhost:4747', 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Changed\n', baseVersion: version }),
    });
    expect(res.status).toBe(200);
    expect((await store.read()).content).toBe('Changed\n');
  });

  it('rejects with 409 on version mismatch and returns the current version', async () => {
    const store = new FileStore(file);
    const putApp = createApp(store);
    const { version: currentVersion } = await store.read();
    const res = await putApp.request('/api/file', {
      method: 'PUT',
      headers: { host: 'localhost:4747', 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x', baseVersion: 'stale' }),
    });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string; version: string };
    expect(data.version).toBe(currentVersion);
  });
});

describe('GET /api/asset', () => {
  it('serves an image the document references, byte for byte', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(dir, 'shot.png'), bytes);
    const res = await app.request('/api/asset?path=.%2Fshot.png', LOCAL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // An edit to the image on disk has to win over the browser's copy, same as an edit to the document.
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  // The literal URL `assetUrlTransform` produces for `./my shot.png` (asserted in
  // src/web/assetUrl.test.ts). The two files cannot import each other — separate tsconfig
  // projects — so the seam is pinned by using the same string on both sides of it.
  it('serves an image whose name had to be escaped', async () => {
    await writeFile(join(dir, 'my shot.png'), 'PNG');
    const res = await app.request('/api/asset?path=.%2Fmy%20shot.png', LOCAL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('rejects a request with no path', async () => {
    const res = await app.request('/api/asset', LOCAL);
    expect(res.status).toBe(400);
  });

  it('returns 404 for a path that climbs out of the root to a file that exists', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'inkmark-out-'));
    await writeFile(join(outside, 'real.png'), 'PNG');
    const escape = join('..', basename(outside), 'real.png');
    const res = await app.request(`/api/asset?path=${encodeURIComponent(escape)}`, LOCAL);
    expect(res.status).toBe(404);
    await rm(outside, { recursive: true, force: true });
  });

  it('rejects a non-localhost Host header', async () => {
    const res = await app.request('/api/asset?path=.%2Fshot.png', {
      headers: { host: 'evil.com' },
    });
    expect(res.status).toBe(403);
  });
});

import type { Hono } from 'hono';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

// One config for every document, not one per port: the file is read on each request, so a hand
// edit reaches an open tab on its next load without a restart.
describe('/api/config', () => {
  beforeEach(() => {
    process.env['INKMARK_HOME'] = join(dir, 'home');
  });
  afterEach(() => {
    delete process.env['INKMARK_HOME'];
  });

  it('answers with nothing configured before the file exists', async () => {
    const res = await app.request('/api/config', LOCAL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('merges a patch into the file and keeps the keys it did not send', async () => {
    const first = await app.request('/api/config', {
      ...LOCAL,
      method: 'PUT',
      headers: { ...LOCAL.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ tocWidth: 300 }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ tocWidth: 300 });

    await app.request('/api/config', {
      ...LOCAL,
      method: 'PUT',
      headers: { ...LOCAL.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ showToc: false }),
    });

    const res = await app.request('/api/config', LOCAL);
    expect(await res.json()).toEqual({ tocWidth: 300, showToc: false });
    // Written as YAML so the reader can edit it, not as an opaque blob.
    expect(await readFile(join(dir, 'home', 'config.yml'), 'utf8')).toContain('tocWidth: 300');
  });

  it('ignores keys and values it does not know', async () => {
    const res = await app.request('/api/config', {
      ...LOCAL,
      method: 'PUT',
      headers: { ...LOCAL.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ tocWidth: 'wide', colour: 'red', lineNumbers: true }),
    });
    expect(await res.json()).toEqual({ lineNumbers: true });
  });

  it('falls back to the defaults when the file is not valid YAML', async () => {
    await mkdir(join(dir, 'home'), { recursive: true });
    await writeFile(join(dir, 'home', 'config.yml'), 'tocWidth: [unclosed\n');
    const res = await app.request('/api/config', LOCAL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('rejects a body that is not an object', async () => {
    const res = await app.request('/api/config', {
      ...LOCAL,
      method: 'PUT',
      headers: { ...LOCAL.headers, 'content-type': 'application/json' },
      body: JSON.stringify([1, 2]),
    });
    expect(res.status).toBe(400);
  });
});

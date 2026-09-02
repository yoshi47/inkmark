import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetRoot, resolveAsset } from './assets.js';

let repo: string;
let doc: string;

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'inkmark-')));
  await mkdir(join(repo, '.git'));
  await mkdir(join(repo, 'notes'));
  await mkdir(join(repo, 'assets'));
  doc = join(repo, 'notes', 'doc.md');
  await writeFile(doc, 'Hello\n');
  await writeFile(join(repo, 'notes', 'side.png'), 'PNG');
  await writeFile(join(repo, 'assets', 'up.png'), 'PNG');
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('assetRoot', () => {
  it('is the repository the document lives in', () => {
    expect(assetRoot(doc)).toBe(repo);
  });

  it('is the repository itself for a document sitting at its root', async () => {
    const atRoot = join(repo, 'top.md');
    await writeFile(atRoot, 'Hello\n');
    expect(assetRoot(atRoot)).toBe(repo);
  });

  it('is the nearest repository, not the outer one', async () => {
    const inner = join(repo, 'notes', 'nested');
    await mkdir(join(inner, '.git'), { recursive: true });
    const nestedDoc = join(inner, 'doc.md');
    await writeFile(nestedDoc, 'Hello\n');
    expect(assetRoot(nestedDoc)).toBe(inner);
  });

  it("falls back to the document's directory outside a repository", async () => {
    const bare = await realpath(await mkdtemp(join(tmpdir(), 'inkmark-')));
    await writeFile(join(bare, 'doc.md'), 'Hello\n');
    expect(assetRoot(join(bare, 'doc.md'))).toBe(bare);
    await rm(bare, { recursive: true, force: true });
  });
});

describe('resolveAsset', () => {
  it('resolves a file beside the document', async () => {
    await expect(resolveAsset(doc, './side.png')).resolves.toEqual({
      mime: 'image/png',
      path: join(repo, 'notes', 'side.png'),
    });
  });

  it('resolves a path that climbs above the document directory but stays in the repository', async () => {
    await expect(resolveAsset(doc, '../assets/up.png')).resolves.toEqual({
      mime: 'image/png',
      path: join(repo, 'assets', 'up.png'),
    });
  });

  it('refuses a path that climbs out of the root to a file that exists', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'inkmark-out-')));
    await writeFile(join(outside, 'real.png'), 'PNG');
    await expect(
      resolveAsset(doc, join('..', '..', basename(outside), 'real.png')),
    ).resolves.toBeNull();
    await rm(outside, { recursive: true, force: true });
  });

  // The containment check compares against `root + sep`; without the separator a sibling whose
  // name merely starts with the root's name would pass as if it were inside it.
  it('refuses a sibling directory whose name starts with the root', async () => {
    const sibling = `${repo}-evil`;
    await mkdir(sibling);
    await writeFile(join(sibling, 'x.png'), 'PNG');
    await expect(
      resolveAsset(doc, join('..', '..', basename(sibling), 'x.png')),
    ).resolves.toBeNull();
    await rm(sibling, { recursive: true, force: true });
  });

  it('refuses a root-absolute path', async () => {
    await expect(resolveAsset(doc, '/x.png')).resolves.toBeNull();
  });

  it('refuses a symlink pointing outside the root', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'inkmark-out-')));
    await writeFile(join(outside, 'secret.png'), 'PNG');
    await symlink(join(outside, 'secret.png'), join(repo, 'notes', 'link.png'));
    await expect(resolveAsset(doc, './link.png')).resolves.toBeNull();
    await rm(outside, { recursive: true, force: true });
  });

  it('refuses a symlink whose name hides the real extension', async () => {
    await writeFile(join(repo, 'notes', 'real.svg'), '<svg/>');
    await symlink(join(repo, 'notes', 'real.svg'), join(repo, 'notes', 'decoy.png'));
    await expect(resolveAsset(doc, './decoy.png')).resolves.toBeNull();
  });

  it('resolves an uppercase extension', async () => {
    await writeFile(join(repo, 'notes', 'SHOT.PNG'), 'PNG');
    await expect(resolveAsset(doc, './SHOT.PNG')).resolves.toEqual({
      mime: 'image/png',
      path: join(repo, 'notes', 'SHOT.PNG'),
    });
  });

  it('resolves a name with a space and non-ASCII characters', async () => {
    await writeFile(join(repo, 'notes', 'my 画像.png'), 'PNG');
    await expect(resolveAsset(doc, './my 画像.png')).resolves.toEqual({
      mime: 'image/png',
      path: join(repo, 'notes', 'my 画像.png'),
    });
  });

  it('refuses a non-image extension', async () => {
    await expect(resolveAsset(doc, './doc.md')).resolves.toBeNull();
  });

  it('refuses SVG', async () => {
    await writeFile(join(repo, 'notes', 'x.svg'), '<svg/>');
    await expect(resolveAsset(doc, './x.svg')).resolves.toBeNull();
  });

  it('refuses a directory', async () => {
    await expect(resolveAsset(doc, '../assets')).resolves.toBeNull();
  });

  it('refuses a missing file', async () => {
    await expect(resolveAsset(doc, './nope.png')).resolves.toBeNull();
  });
});

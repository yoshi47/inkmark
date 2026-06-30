import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from './fileStore.js';
import { FileWatcher } from './watch.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inkmark-w-'));
  file = join(dir, 'doc.md');
  await writeFile(file, 'one\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function nextChange(w: FileWatcher, ms = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const off = w.onChange((v) => {
      off();
      resolve(v);
    });
    setTimeout(() => {
      off();
      reject(new Error('no change event'));
    }, ms);
  });
}

describe('FileWatcher', () => {
  it('emits a new version when the file changes externally', async () => {
    const store = new FileStore(file);
    const watcher = new FileWatcher(store);
    watcher.start();
    await new Promise<void>((r) => setTimeout(r, 200));
    const got = nextChange(watcher);
    await writeFile(file, 'two\n');
    expect(await got).toMatch(/.+/);
    await watcher.close();
  });

  it('survives an atomic rename and still reports the next external write', async () => {
    const store = new FileStore(file);
    const watcher = new FileWatcher(store);
    watcher.start();
    await new Promise<void>((r) => setTimeout(r, 200));
    await store.write('via-store\n'); // atomic rename + sets lastWritten (self-echo, suppressed)
    await new Promise<void>((r) => setTimeout(r, 200));
    const got = nextChange(watcher);
    await writeFile(file, 'external-after-rename\n');
    expect(await got).toMatch(/.+/);
    await watcher.close();
  });

  it('suppresses self-write echo', async () => {
    const store = new FileStore(file);
    const watcher = new FileWatcher(store);
    let calls = 0;
    watcher.onChange(() => calls++);
    watcher.start();
    await new Promise<void>((r) => setTimeout(r, 200));
    await store.write('self\n');
    await new Promise<void>((r) => setTimeout(r, 300));
    expect(calls).toBe(0);
    await watcher.close();
  });
});

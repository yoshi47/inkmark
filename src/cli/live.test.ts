import type * as FsPromises from 'node:fs/promises';
import { link, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wrapped, not replaced, so a test can make one `link` fail the way a filesystem without hard
// links would; every other call goes to the real one.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return { ...real, link: vi.fn(real.link) };
});
import { parse } from '../rfm/index.js';
import { readConfig } from '../server/config.js';
import {
  liveDir,
  lockPath,
  parseLock,
  readLiveState,
  readWatcher,
  writeLiveState,
} from '../server/liveState.js';
import {
  acquireLock,
  anchorFor,
  cmdLive,
  cmdWait,
  formatBatches,
  newComments,
  ownsLock,
  releaseLock,
  sameFile,
  type Seen,
} from './live.js';

const DOC = `これは {==ローカルファースト==}{>>定義がまだない<<}{#c1} なツールです。

---
comments:
  c1:
    by: user
    at: 2026-01-01T00:00:00.000Z
    resolved: false
---
`;

const DOC_WITH_REPLY = `これは {==ローカルファースト==}{>>定義がまだない<<}{#c1} なツールです。

---
comments:
  c1:
    by: user
    at: 2026-01-01T00:00:00.000Z
    resolved: false
  c2:
    by: AI
    re: c1
    at: 2026-01-01T00:01:00.000Z
    body: "ファイルが唯一の状態です"
---
`;

let home: string;
let dir: string;
let file: string;
let written: string[];

/** Everything the CLI printed, so an integration test can read it like the hook does. */
function capture(): void {
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    written.push(String(chunk));
    return true;
  });
}

function printed(): string {
  return written.join('');
}

/** Append to the endmatter's comment map, the way the viewer (and an agent) does. */
async function appendComment(yaml: string): Promise<void> {
  const current = await readFile(file, 'utf8');
  const fence = current.lastIndexOf('\n---');
  await writeFile(file, `${current.slice(0, fence)}\n${yaml}---\n`, 'utf8');
}

/** The watcher is ready a beat after `cmdWait` returns, and the OS may coalesce writes. */
async function waitForComment(code: Promise<number>, yaml: string): Promise<number> {
  await delay(400);
  await appendComment(yaml);
  await delay(800);
  // A missed event (chokidar's initial scan landing late) must fail the test as a timeout,
  // not as a hang: nothing here retries forever.
  return code;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'inkmark-live-home-'));
  dir = await mkdtemp(join(tmpdir(), 'inkmark-live-docs-'));
  process.env['INKMARK_HOME'] = home;
  file = join(dir, 'draft.md');
  await writeFile(file, DOC, 'utf8');
  capture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('anchorFor', () => {
  it('reads the text a note was attached to, not the note', () => {
    const doc = parse(DOC);
    expect(anchorFor(doc, 'c1')).toBe('ローカルファースト');
  });

  it('returns null for a reply, which has no mark in the body', () => {
    const doc = parse(DOC);
    expect(anchorFor(doc, 'c99')).toBeNull();
  });
});

describe('newComments', () => {
  it('reports what the human wrote in the viewer and nothing else', () => {
    const doc = parse(DOC_WITH_REPLY);
    const fresh = newComments(doc, new Set());
    expect(fresh.map((c) => c.id)).toEqual(['c1']);
    expect(fresh[0]?.by).toBe('user');
  });

  it('leaves out what was already reported', () => {
    const doc = parse(DOC_WITH_REPLY);
    expect(newComments(doc, new Set(['c1', 'c2']))).toEqual([]);
  });

  it('never wakes on the agent’s own reply, whatever label it uses', () => {
    // An allowlist on the viewer's `by: user`, not "anything that is not AI": an agent that
    // labels a reply `by: Claude` must not wake itself with its own answer.
    const doc = parse(DOC_WITH_REPLY);
    const only = new Set(['c1']);
    expect(newComments(doc, only, 'Claude')).toEqual([]);
    expect(newComments(doc, only)).toEqual([]);
  });
});

describe('formatBatches', () => {
  it('names the document, the id, the author and the anchor', () => {
    const text = formatBatches([
      {
        file: '/tmp/draft.md',
        comments: [
          {
            id: 'c7',
            by: 'user',
            at: '2026-01-01T00:00:00.000Z',
            re: null,
            body: 'この語の定義がまだ出てきていません',
            anchor: 'ローカルファースト',
          },
        ],
      },
    ]);
    expect(text).toContain('1 new comment in /tmp/draft.md');
    expect(text).toContain('c7  user  2026-01-01T00:00:00.000Z');
    expect(text).toContain('  on: ローカルファースト');
    expect(text).toContain('  note: この語の定義がまだ出てきていません');
  });

  it('marks a reply and omits the anchor it does not have', () => {
    const text = formatBatches([
      {
        file: '/tmp/draft.md',
        comments: [
          {
            id: 'c8',
            by: 'user',
            at: '2026-01-01T00:01:00.000Z',
            re: 'c7',
            body: '同意します',
            anchor: null,
          },
        ],
      },
    ]);
    expect(text).toContain('re c7');
    expect(text).not.toContain('  on:');
  });
});

describe('cmdWait', () => {
  it(
    'prints a comment that arrives after it starts, then exits 0',
    { timeout: 20000 },
    async () => {
      const code = waitForComment(
        cmdWait(file, { timeoutMs: 8000 }),
        `  c2:\n    by: user\n    at: 2026-01-01T00:02:00.000Z\n    resolved: false\n    body: "ここは要確認"\n`,
      );
      expect(await code).toBe(0);
      expect(printed()).toContain('c2  user');
      expect(printed()).toContain('ここは要確認');

      // The id is recorded, so the next waiter does not report it a second time.
      expect((await readLiveState(file))?.reported).toContain('c2');
    },
  );

  it('reports a comment left while no waiter was listening', async () => {
    // A previous waiter died before this comment landed, so the file is the only record of it —
    // and no further change will come to announce it.
    await writeLiveState({ file, reported: ['c1'] });
    await appendComment(
      `  c2:\n    by: user\n    at: 2026-01-01T00:03:00.000Z\n    resolved: false\n    body: "起きてますか"\n`,
    );
    const code = await cmdWait(file, { timeoutMs: 3000 });
    expect(code).toBe(0);
    expect(printed()).toContain('c2  user');
    expect(printed()).toContain('起きてますか');
  });

  it('records who is waiting while it waits, and nobody after', async () => {
    const waiting = cmdWait(file, { timeoutMs: 1500, agent: 'claude', session: 's1' });
    await vi.waitFor(async () => {
      const watcher = await readWatcher(file);
      if (watcher === null) throw new Error('not holding the lock yet');
    });
    expect(await readWatcher(file)).toMatchObject({
      pid: process.pid,
      agent: 'claude',
      session: 's1',
      project: process.cwd(),
      since: expect.any(String) as unknown,
      until: expect.any(String) as unknown,
    });
    expect(await waiting).toBe(3);
    expect(await readWatcher(file)).toBeNull();
  });

  it('defers to a live waiter from an older inkmark, whose lock is a bare pid', async () => {
    await mkdir(dirname(lockPath(file)), { recursive: true });
    await writeFile(lockPath(file), String(process.ppid));
    const started = Date.now();
    expect(await cmdWait(file, { timeoutMs: 5000 })).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('stays quiet once another waiter has taken its lock over', { timeout: 20000 }, async () => {
    // What a waiter that slept past its expiry finds on waking: the document is someone else's.
    const waiting = cmdWait(file, { timeoutMs: 8000 });
    await vi.waitFor(async () => {
      if ((await readWatcher(file)) === null) throw new Error('not holding the lock yet');
    });
    await writeFile(lockPath(file), JSON.stringify({ pid: process.ppid, agent: 'other' }));
    const code = waitForComment(
      waiting,
      `  c2:\n    by: user\n    at: 2026-01-01T00:02:00.000Z\n    resolved: false\n    body: "誰宛て?"\n`,
    );
    expect(await code).toBe(0);
    expect(printed()).toBe('');
    // Not this waiter's to release.
    expect((await readWatcher(file))?.agent).toBe('other');
  });

  it('exits 3 when nothing arrives in time', async () => {
    const code = await cmdWait(file, { timeoutMs: 200 });
    expect(code).toBe(3);
    expect(printed()).toBe('');
  });

  it('does nothing at all when live mode is off in the config', async () => {
    await writeFile(join(home, 'config.yml'), 'live: false\n', 'utf8');
    const started = Date.now();
    expect(await cmdWait(file, { timeoutMs: 5000 })).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not arm a document that was switched off for itself', async () => {
    await cmdLive('off', file);
    expect(await cmdWait(file, { timeoutMs: 5000 })).toBe(0);
    expect(printed()).toBe('');
  });
});

describe('cmdLive', () => {
  it('writes the global switch to the one config file', async () => {
    expect(await cmdLive('off', undefined)).toBe(0);
    expect((await readConfig()).live).toBe(false);
    expect(await cmdLive('on', undefined)).toBe(0);
    expect((await readConfig()).live).toBe(true);
  });

  it('scopes a switch to one document', async () => {
    expect(await cmdLive('off', file)).toBe(0);
    expect((await readLiveState(file))?.armed).toBe(false);
    expect((await readConfig()).live).toBeUndefined();
  });

  it('rejects a mode it does not know', async () => {
    expect(await cmdLive('maybe', undefined)).toBe(2);
  });
});

describe('parseLock', () => {
  it.each([
    ['a bare pid from an older inkmark', '4242\n', { pid: 4242, agent: null, session: null }],
    [
      'the JSON record',
      '{"pid":7,"agent":"codex","session":"s","project":"/p","since":"T"}',
      { pid: 7, agent: 'codex', session: 's', project: '/p', since: 'T', until: null },
    ],
    ['the expiry of a waiter with a timeout', '{"pid":7,"until":"U"}', { pid: 7, until: 'U' }],
    ['an empty label as no label', '{"pid":7,"agent":""}', { pid: 7, agent: null }],
  ])('reads %s', (_name, raw, expected) => {
    expect(parseLock(raw)).toMatchObject(expected);
  });

  it.each([
    ['an empty file', ''],
    ['pid 0', '0'],
    ['a pid that is a string', '{"pid":"12"}'],
    ['a zero pid in JSON', '{"pid":0}'],
    ['garbage', 'not a lock'],
  ])('rejects %s', (_name, raw) => {
    expect(parseLock(raw)).toBeNull();
  });
});

describe('the lock', () => {
  const HOUR = 60 * 60 * 1000;

  async function placeLock(raw: string, ageMs = 0): Promise<void> {
    await mkdir(liveDir(), { recursive: true });
    await writeFile(lockPath(file), raw);
    if (ageMs > 0) {
      const then = new Date(Date.now() - ageMs);
      await utimes(lockPath(file), then, then);
    }
  }

  async function leftovers(): Promise<string[]> {
    return (await readdir(liveDir())).filter((name) => !name.endsWith('.lock'));
  }

  it('is created whole, with an expiry, and leaves no temp file behind', async () => {
    const record = await acquireLock(file, { agent: 'claude' }, 5000);
    expect(record).not.toBeNull();
    expect(await readFile(lockPath(file), 'utf8')).toBe(record);
    const watcher = await readWatcher(file);
    expect(watcher).toMatchObject({ pid: process.pid, agent: 'claude' });
    expect(Date.parse(watcher?.until ?? '') - Date.parse(watcher?.since ?? '')).toBe(5000);
    expect(await leftovers()).toEqual([]);
  });

  it('records no expiry for a waiter without a timeout', async () => {
    expect(await acquireLock(file)).not.toBeNull();
    expect((await readWatcher(file))?.until).toBeNull();
  });

  it('goes to exactly one of many simultaneous waiters', async () => {
    const records = await Promise.all(
      Array.from({ length: 20 }, () => acquireLock(file, {}, 5000)),
    );
    expect(records.filter((r) => r !== null)).toHaveLength(1);
    expect(await leftovers()).toEqual([]);
  });

  it('goes to exactly one of many waiters taking over the same stale lock', async () => {
    await placeLock(JSON.stringify({ pid: process.ppid, until: new Date(0).toISOString() }));
    // Staggered so that some judge the old lock stale while others have already replaced it,
    // which is the interleaving a delete-after-judging takeover gets wrong.
    const records = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        await delay(i % 5);
        return acquireLock(file, {}, 5000);
      }),
    );
    const winners = records.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(await readFile(lockPath(file), 'utf8')).toBe(winners[0]);
    expect(await leftovers()).toEqual([]);
  });

  it('is not taken from an older inkmark that has created it but not yet written its pid', async () => {
    await placeLock('');
    expect(await acquireLock(file)).toBeNull();
    expect(await readFile(lockPath(file), 'utf8')).toBe('');
  });

  it('is taken over once an unreadable lock has had time to be written', async () => {
    await placeLock('', 60_000);
    expect(await acquireLock(file)).not.toBeNull();
  });

  it('is not taken from a live waiter that has not run past its expiry', async () => {
    // Inside the grace period: a waiter that slept with the laptop may still be on its way out.
    await placeLock(
      JSON.stringify({ pid: process.ppid, until: new Date(Date.now() - 5000).toISOString() }),
    );
    expect(await readWatcher(file)).not.toBeNull();
    expect(await acquireLock(file)).toBeNull();
  });

  it('counts a live pid past its expiry as nobody, since the pid may belong to someone else now', async () => {
    await placeLock(
      JSON.stringify({ pid: process.ppid, until: new Date(Date.now() - HOUR).toISOString() }),
    );
    expect(await readWatcher(file)).toBeNull();
    const record = await acquireLock(file);
    expect(record).not.toBeNull();
    expect(await readFile(lockPath(file), 'utf8')).toBe(record);
  });

  it("keeps today's behaviour for a live pid with no expiry", async () => {
    await placeLock(JSON.stringify({ pid: process.ppid }), HOUR);
    expect(await readWatcher(file)).not.toBeNull();
    expect(await acquireLock(file)).toBeNull();
  });

  it('is released only by the waiter that wrote it', async () => {
    const record = await acquireLock(file, {}, 5000);
    if (record === null) throw new Error('expected the lock');
    await releaseLock(file, record.replace('"pid"', '"pid" '));
    expect(await readWatcher(file)).not.toBeNull();
    await releaseLock(file, record);
    expect(await readWatcher(file)).toBeNull();
    expect(await readdir(liveDir())).toEqual([]);
  });
});

describe('the lock, contended', () => {
  const HOUR = 60 * 60 * 1000;
  function guardPath(): string {
    return `${lockPath(file)}.takeover`;
  }

  async function place(path: string, raw: string, ageMs = 0): Promise<void> {
    await mkdir(liveDir(), { recursive: true });
    await writeFile(path, raw);
    if (ageMs !== 0) {
      const then = new Date(Date.now() - ageMs);
      await utimes(path, then, then);
    }
  }

  function stale(): string {
    return JSON.stringify({ pid: process.ppid, until: new Date(Date.now() - HOUR).toISOString() });
  }

  it('tells a re-created file from the one judged, even on a reused inode', () => {
    const judged: Seen = { raw: '{"pid":1,"nonce":"a"}', ino: 7n, mtimeNs: 100n, mtimeMs: 0 };
    expect(sameFile(judged, { ...judged })).toBe(true);
    // ext4 and tmpfs hand a freed inode to the next file: same ino, different lock.
    expect(sameFile(judged, { ...judged, raw: '{"pid":1,"nonce":"b"}' })).toBe(false);
    expect(sameFile(judged, { ...judged, mtimeNs: 101n })).toBe(false);
    expect(sameFile(judged, { ...judged, ino: 8n })).toBe(false);
  });

  it('writes a distinct record for every acquire, even in the same millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const files = Array.from({ length: 5 }, (_, i) => join(dir, `doc${String(i)}.md`));
      const records = await Promise.all(files.map((f) => acquireLock(f, { agent: 'a' }, 5000)));
      expect(records.every((r) => r !== null)).toBe(true);
      expect(new Set(records).size).toBe(records.length);

      const first = records[0] ?? '';
      await releaseLock(files[0] ?? '', first);
      const again = await acquireLock(files[0] ?? '', { agent: 'a' }, 5000);
      expect(again).not.toBeNull();
      expect(again).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts the nonce in a lock without exposing it', () => {
    expect(parseLock('{"pid":7,"nonce":"abc"}')).toEqual({
      pid: 7,
      agent: null,
      session: null,
      project: null,
      since: null,
      until: null,
    });
  });

  it('takes over an unreadable lock whose mtime is in the future (the clock went back)', async () => {
    await place(lockPath(file), '', -HOUR);
    expect(await acquireLock(file)).not.toBeNull();
  });

  it('sweeps temp files a killed waiter left behind, and only old ones', async () => {
    const old = `${lockPath(file)}.1.dead.tmp`;
    const fresh = `${lockPath(file)}.2.busy.tmp`;
    await place(old, 'x', 2 * 60_000);
    await place(fresh, 'x');
    expect(await acquireLock(file)).not.toBeNull();
    const names = await readdir(liveDir());
    expect(names).not.toContain(old.split('/').pop());
    expect(names).toContain(fresh.split('/').pop());
  });

  it('does not take over while another waiter holds the guard', async () => {
    const guard = JSON.stringify({ pid: process.ppid, nonce: 'theirs' });
    await place(lockPath(file), stale());
    await place(guardPath(), guard);
    expect(await acquireLock(file)).toBeNull();
    expect(await readFile(guardPath(), 'utf8')).toBe(guard);
  });

  it('clears an abandoned guard and then takes over', async () => {
    await place(lockPath(file), stale());
    await place(guardPath(), JSON.stringify({ pid: 2 ** 22 + 1, nonce: 'gone' }), 60_000);
    const record = await acquireLock(file);
    expect(record).not.toBeNull();
    expect(await readFile(lockPath(file), 'utf8')).toBe(record);
    expect(await readdir(liveDir())).not.toContain(guardPath().split('/').pop());
  });

  it('waits out a busy guard to release its lock', async () => {
    const record = await acquireLock(file, {}, 5000);
    if (record === null) throw new Error('expected the lock');
    await place(guardPath(), JSON.stringify({ pid: process.ppid, nonce: 'brief' }));
    const releasing = releaseLock(file, record);
    await delay(120);
    await rm(guardPath());
    await releasing;
    expect(await readWatcher(file)).toBeNull();
  });

  it('leaves its lock to go stale when the guard never frees', async () => {
    const record = await acquireLock(file, {}, 5000);
    if (record === null) throw new Error('expected the lock');
    await place(guardPath(), JSON.stringify({ pid: process.ppid, nonce: 'stuck' }));
    await releaseLock(file, record);
    expect(await readFile(lockPath(file), 'utf8')).toBe(record);
  });

  it('tells a lost lock from one it cannot read right now', async () => {
    const record = await acquireLock(file, {}, 5000);
    if (record === null) throw new Error('expected the lock');
    expect(await ownsLock(file, record)).toBe(true);
    await writeFile(lockPath(file), JSON.stringify({ pid: process.ppid }));
    expect(await ownsLock(file, record)).toBe(false);
    await rm(lockPath(file));
    expect(await ownsLock(file, record)).toBe(false);
    // A read that fails for any other reason (here EISDIR) says nothing about ownership.
    await mkdir(lockPath(file));
    expect(await ownsLock(file, record)).toBeNull();
  });

  it.each(['EPERM', 'ENOTSUP'])(
    'falls back to a plain exclusive create when link fails with %s',
    async (code) => {
      vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      const record = await acquireLock(file, {}, 5000);
      expect(record).not.toBeNull();
      expect(await readFile(lockPath(file), 'utf8')).toBe(record);
      expect(await readdir(liveDir())).toEqual([lockPath(file).split('/').pop()]);

      // The fallback is still exclusive: a live holder is not overwritten.
      vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      expect(await acquireLock(file)).toBeNull();
      expect(await readFile(lockPath(file), 'utf8')).toBe(record);
    },
  );
});

describe('cmdWait, against the wall clock', () => {
  it(
    'leaves at the expiry it recorded, even when its timer has not caught up',
    { timeout: 20000 },
    async () => {
      // Only the interval and the clock: the file watchers keep their real timers.
      vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
      try {
        const HOUR = 60 * 60 * 1000;
        const waiting = cmdWait(file, { timeoutMs: HOUR });
        await vi.waitFor(async () => {
          if ((await readWatcher(file)) === null) throw new Error('not holding the lock yet');
        });
        // What waking from sleep looks like: the wall clock moved, the timer did not.
        vi.setSystemTime(Date.now() + 2 * HOUR);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await waiting).toBe(3);
        expect(await readWatcher(file)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

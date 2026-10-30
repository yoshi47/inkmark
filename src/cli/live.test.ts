import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from '../rfm/index.js';
import { readConfig } from '../server/config.js';
import { readLiveState, writeLiveState } from '../server/liveState.js';
import { anchorFor, cmdLive, cmdWait, formatBatches, newComments } from './live.js';

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

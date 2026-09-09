import type { MockInstance } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import open from 'open';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunningServer } from '../server/start.js';
import { startServer } from '../server/start.js';
import { cmdOpen, cmdStatus, cmdStop, main, shutdownServer } from './commands.js';
import { findFreePort } from './port.js';
import { list, register } from './registry.js';

vi.mock('open', () => ({ default: vi.fn(() => Promise.resolve(undefined)) }));

/** `isAlive` probes with signal 0 on the same spy, so count only the real terminations. */
function sigterms(kill: MockInstance<typeof process.kill>): number {
  return kill.mock.calls.filter((c) => c[1] === 'SIGTERM').length;
}

let home: string;
let dir: string;
let started: RunningServer[];

/** Run cmdOpen without parking forever, keeping the server so we can close it. */
async function openDoc(file: string, port?: number): Promise<number> {
  return cmdOpen(file, {
    ...(port === undefined ? {} : { port }),
    wait: (server) => {
      started.push(server);
      return Promise.resolve();
    },
  });
}

beforeEach(async () => {
  started = [];
  home = await mkdtemp(join(tmpdir(), 'inkmark-home-'));
  dir = await mkdtemp(join(tmpdir(), 'inkmark-docs-'));
  process.env['INKMARK_HOME'] = home;
  await writeFile(join(dir, 'a.md'), 'A\n');
  await writeFile(join(dir, 'b.md'), 'B\n');
});
afterEach(async () => {
  for (const s of started) await s.close();
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  delete process.env['INKMARK_HOME'];
  await rm(home, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

describe('cmdOpen', () => {
  it('opens a second file on its own port without asking anything', async () => {
    expect(await openDoc(join(dir, 'a.md'))).toBe(0);
    expect(await openDoc(join(dir, 'b.md'))).toBe(0);

    const live = await list();
    expect(live).toHaveLength(2);
    expect(live.map((r) => r.file)).toEqual([join(dir, 'a.md'), join(dir, 'b.md')]);
    expect(live[0]?.port).not.toBe(live[1]?.port);
  });

  it('reuses the running server when the same file is opened again', async () => {
    await openDoc(join(dir, 'a.md'));
    const before = await list();

    expect(await openDoc(join(dir, 'a.md'))).toBe(0);
    expect(await list()).toEqual(before);
    expect(started).toHaveLength(1);
  });

  it('starts on the requested port', async () => {
    const free = await findFreePort(4901);
    await openDoc(join(dir, 'a.md'), free);
    expect((await list())[0]?.port).toBe(free);
  });

  it('moves up when the requested port is taken, rather than failing', async () => {
    const taken = await findFreePort(4901);
    const blocker = createServer();
    await new Promise<void>((done) => {
      blocker.listen(taken, '127.0.0.1', () => {
        done();
      });
    });
    try {
      expect(await openDoc(join(dir, 'a.md'), taken)).toBe(0);
      expect((await list())[0]?.port).toBeGreaterThan(taken);
    } finally {
      await new Promise<void>((done) => {
        blocker.close(() => {
          done();
        });
      });
    }
  });

  it('reuses the winner when another server registers the file first', async () => {
    const server = await startServer(join(dir, 'a.md'), await findFreePort(4930));
    started.push(server);
    await register({
      file: join(dir, 'a.md'),
      pid: process.pid,
      port: server.port,
      url: server.url,
      startedAt: '',
    });

    expect(await openDoc(join(dir, 'a.md'))).toBe(0);
    expect(await list()).toHaveLength(1);
  });

  it('rejects a file that is not markdown', async () => {
    await writeFile(join(dir, 'notes.txt'), 'x\n');
    expect(await openDoc(join(dir, 'notes.txt'))).toBe(2);
  });

  it('rejects a file that does not exist', async () => {
    expect(await openDoc(join(dir, 'missing.md'))).toBe(2);
  });

  it('keeps the server when no browser can be launched', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(open).mockRejectedValueOnce(new Error('no browser here'));

    expect(await openDoc(join(dir, 'a.md'))).toBe(0);
    expect(await list()).toHaveLength(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('keeps going when the browser fails on a reused server', async () => {
    await openDoc(join(dir, 'a.md'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(open).mockRejectedValueOnce(new Error('no browser here'));

    expect(await openDoc(join(dir, 'a.md'))).toBe(0);
    expect(await list()).toHaveLength(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('cmdOpen --detach', () => {
  /**
   * Stand in for the detached child. It has to serve for real: the parent probes the URL
   * before it believes the record, so a registration alone is not a started server.
   */
  async function childStarts(file: string): Promise<string> {
    const server = await startServer(file, await findFreePort(4940));
    started.push(server);
    await register({
      file,
      pid: process.pid,
      port: server.port,
      url: server.url,
      startedAt: new Date().toISOString(),
    });
    return server.url;
  }

  it('returns as soon as the child serves the file, printing its URL', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const file = join(dir, 'a.md');
    let seen: string[] = [];
    let url = '';

    const code = await cmdOpen(file, {
      detach: true,
      spawnChild: async (args) => {
        seen = args;
        url = await childStarts(file);
      },
    });

    expect(code).toBe(0);
    expect(seen).toEqual(['open', file]);
    expect(log).toHaveBeenCalledWith(`inkmark serving ${file}\n  ${url}`);
    log.mockRestore();
  });

  it('waits for a child that takes its time', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const file = join(dir, 'a.md');
    let late: Promise<string> | undefined;

    // Registers well after the first poll, so a single check would report a timeout.
    const code = await cmdOpen(file, {
      detach: true,
      detachTimeoutMs: 5000,
      spawnChild: () => {
        late = new Promise<string>((done) => {
          setTimeout(() => {
            void childStarts(file).then(done);
          }, 300);
        });
      },
    });

    expect(code).toBe(0);
    await late;
    log.mockRestore();
  });

  it('passes --port through to the child', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const file = join(dir, 'a.md');
    let seen: string[] = [];

    await cmdOpen(file, {
      detach: true,
      port: 4931,
      spawnChild: async (args) => {
        seen = args;
        await childStarts(file);
      },
    });

    expect(seen).toEqual(['open', file, '--port', '4931']);
    log.mockRestore();
  });

  it('reuses a running server instead of spawning a second one', async () => {
    await openDoc(join(dir, 'a.md'));
    const spawnChild = vi.fn();

    expect(await cmdOpen(join(dir, 'a.md'), { detach: true, spawnChild })).toBe(0);
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it('does not believe a record whose port answers nothing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const file = join(dir, 'a.md');
    const dead = await findFreePort(4960);

    const code = await cmdOpen(file, {
      detach: true,
      detachTimeoutMs: 300,
      spawnChild: () =>
        register({
          file,
          pid: process.pid,
          port: dead,
          url: `http://localhost:${String(dead)}`,
          startedAt: new Date().toISOString(),
        }),
    });

    expect(code).toBe(1);
    err.mockRestore();
  });

  it('reports a spawn that failed instead of crashing out of the CLI', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const code = await cmdOpen(join(dir, 'a.md'), {
      detach: true,
      spawnChild: () => Promise.reject(new Error('EACCES')),
    });

    expect(code).toBe(1);
    expect(err.mock.calls[0]?.[0]).toMatch(/could not start a detached server/);
    err.mockRestore();
  });

  it('fails with the log path when the child never registers', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const code = await cmdOpen(join(dir, 'a.md'), {
      detach: true,
      detachTimeoutMs: 50,
      spawnChild: () => undefined,
    });

    expect(code).toBe(1);
    expect(err.mock.calls[0]?.[0]).toMatch(/did not start in time[\s\S]*logs/);
    err.mockRestore();
  });
});

describe('shutdownServer', () => {
  it('removes the record so a later open does not reuse a dead URL', async () => {
    await openDoc(join(dir, 'a.md'));
    expect(await list()).toHaveLength(1);

    const server = started.pop();
    if (server === undefined) throw new Error('no server started');
    await shutdownServer(server);
    expect(await list()).toEqual([]);
  });
});

describe('main --port', () => {
  it('rejects a non-numeric port', async () => {
    expect(await main(['open', join(dir, 'a.md'), '--port', 'abc'])).toBe(2);
  });

  it('rejects a port out of range', async () => {
    expect(await main(['open', join(dir, 'a.md'), '--port', '70000'])).toBe(2);
  });

  it('rejects --port with no value', async () => {
    expect(await main(['open', join(dir, 'a.md'), '--port'])).toBe(2);
  });

  it('refuses --port on stop instead of silently stopping everything', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await register({
      file: '/docs/a.md',
      pid: process.pid,
      port: 4801,
      url: 'http://localhost:4801',
      startedAt: '',
    });
    await register({
      file: '/docs/b.md',
      pid: process.pid,
      port: 4802,
      url: 'http://localhost:4802',
      startedAt: '',
    });

    expect(await main(['stop', '--port', '4801'])).toBe(2);
    expect(sigterms(kill)).toBe(0);
    kill.mockRestore();
    err.mockRestore();
  });

  it('refuses --port on status', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(['status', '--port', '4801'])).toBe(2);
    err.mockRestore();
  });
});

describe('main --detach', () => {
  it('does not read the flag as the file argument', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // With `--detach` left in the positionals this would be "not a markdown file".
    expect(await main(['open', '--detach'])).toBe(2);
    expect(err.mock.calls[0]?.[0]).toMatch(/^usage: inkmark open/);
    err.mockRestore();
  });

  it('reaches cmdOpen as a detached start, whatever the flag order', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const file = join(dir, 'a.md');
    const spawnChild = vi.fn();

    // Exit 1 is the timeout: the point here is that a child was asked for at all.
    const opts = { spawnChild, detachTimeoutMs: 50 };
    expect(await main(['open', '--detach', '--port', '4931', file], opts)).toBe(1);
    expect(spawnChild).toHaveBeenCalledWith(['open', file, '--port', '4931'], expect.any(String));
    err.mockRestore();
  });

  it.each(['status', 'stop'])('refuses --detach on %s', async (cmd) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main([cmd, '--detach'])).toBe(2);
    expect(err).toHaveBeenCalledWith('--detach is only valid for `open`.');
    err.mockRestore();
  });
});

describe('main dispatch', () => {
  it('prints usage for no command', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main([])).toBe(2);
    expect(await main(['bogus'])).toBe(2);
    err.mockRestore();
  });

  it('routes status', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main(['status'])).toBe(0);
    expect(log).toHaveBeenCalledWith('not running');
    log.mockRestore();
  });
});

describe('cmdStatus', () => {
  it('reports every running server', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await openDoc(join(dir, 'a.md'));
    await openDoc(join(dir, 'b.md'));
    log.mockClear();

    expect(await cmdStatus()).toBe(0);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('says not running when the registry is empty', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdStatus()).toBe(0);
    expect(log).toHaveBeenCalledWith('not running');
    log.mockRestore();
  });
});

describe('cmdStop', () => {
  it('signals every server when given no target', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await register({
      file: '/docs/a.md',
      pid: process.pid,
      port: 4801,
      url: 'http://localhost:4801',
      startedAt: '',
    });
    await register({
      file: '/docs/b.md',
      pid: process.pid,
      port: 4802,
      url: 'http://localhost:4802',
      startedAt: '',
    });

    expect(await cmdStop()).toBe(0);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(sigterms(kill)).toBe(2);
    kill.mockRestore();
  });

  it('signals only the server matching a file', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await register({
      file: '/docs/a.md',
      pid: process.pid,
      port: 4801,
      url: 'http://localhost:4801',
      startedAt: '',
    });
    await register({
      file: '/docs/b.md',
      pid: process.pid,
      port: 4802,
      url: 'http://localhost:4802',
      startedAt: '',
    });

    expect(await cmdStop('/docs/b.md')).toBe(0);
    expect(sigterms(kill)).toBe(1);
    kill.mockRestore();
  });

  it('signals only the server matching a port', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await register({
      file: '/docs/a.md',
      pid: process.pid,
      port: 4801,
      url: 'http://localhost:4801',
      startedAt: '',
    });
    await register({
      file: '/docs/b.md',
      pid: process.pid,
      port: 4802,
      url: 'http://localhost:4802',
      startedAt: '',
    });

    expect(await cmdStop('4802')).toBe(0);
    expect(sigterms(kill)).toBe(1);
    kill.mockRestore();
  });

  it('prunes the record of a process that vanished (ESRCH)', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal !== 'SIGTERM') return true;
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    await register({
      file: '/docs/a.md',
      pid: process.pid,
      port: 4801,
      url: 'http://localhost:4801',
      startedAt: '',
    });

    expect(await cmdStop()).toBe(0);
    kill.mockRestore();
    expect(await list()).toEqual([]);
  });

  it('keeps the record and fails when the signal is refused (EPERM)', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal !== 'SIGTERM') return true;
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await register({
      file: '/docs/a.md',
      pid: process.pid,
      port: 4801,
      url: 'http://localhost:4801',
      startedAt: '',
    });

    expect(await cmdStop()).toBe(1);
    kill.mockRestore();
    expect(await list()).toHaveLength(1);
    err.mockRestore();
  });

  it('fails with the running list when nothing matches', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await register({
      file: '/docs/a.md',
      pid: process.pid,
      port: 4801,
      url: 'http://localhost:4801',
      startedAt: '',
    });

    expect(await cmdStop('9999')).toBe(2);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('says not running when the registry is empty', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdStop()).toBe(0);
    expect(log).toHaveBeenCalledWith('not running');
    log.mockRestore();
  });
});

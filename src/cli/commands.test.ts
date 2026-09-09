import type { MockInstance } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

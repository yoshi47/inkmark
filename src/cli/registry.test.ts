import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findByFile, list, register, type ServerRecord, unregister } from './registry.js';

let home: string;

function rec(port: number, file: string, pid = process.pid): ServerRecord {
  return {
    file,
    pid,
    port,
    url: `http://localhost:${String(port)}`,
    startedAt: new Date().toISOString(),
  };
}

/** A pid that is certainly gone: spawn a process and wait for it to exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid ?? 0;
  await new Promise<void>((resolve) => {
    child.on('exit', () => {
      resolve();
    });
  });
  return pid;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'inkmark-home-'));
  process.env['INKMARK_HOME'] = home;
});
afterEach(async () => {
  delete process.env['INKMARK_HOME'];
  await rm(home, { recursive: true, force: true });
});

describe('register / list', () => {
  it('round-trips records and returns them lowest port first', async () => {
    await register(rec(4748, '/docs/b.md'));
    await register(rec(4747, '/docs/a.md'));
    expect((await list()).map((r) => r.port)).toEqual([4747, 4748]);
  });

  it('drops records whose process is gone, and deletes the file', async () => {
    await register(rec(4747, '/docs/a.md'));
    await register(rec(4748, '/docs/b.md', await deadPid()));
    expect((await list()).map((r) => r.port)).toEqual([4747]);
    expect(await readdir(join(home, 'servers'))).toEqual(['4747.json']);
  });

  it('skips an unparseable record without losing the others', async () => {
    await register(rec(4747, '/docs/a.md'));
    await mkdir(join(home, 'servers'), { recursive: true });
    await writeFile(join(home, 'servers', '4748.json'), '{not json', 'utf8');
    expect((await list()).map((r) => r.port)).toEqual([4747]);
  });

  it('refuses a second port for a file another live server already holds', async () => {
    await register(rec(4747, '/docs/a.md'));
    await expect(register(rec(4748, '/docs/a.md'))).rejects.toThrow(/already serving/);
  });

  it('lets the same server rewrite its own record', async () => {
    await register(rec(4747, '/docs/a.md'));
    await expect(register(rec(4747, '/docs/a.md'))).resolves.toBeUndefined();
  });
});

describe('legacy server.json', () => {
  it('moves a live record into the per-port layout', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'server.json'), JSON.stringify(rec(4747, '/docs/a.md')), 'utf8');
    expect((await list()).map((r) => r.file)).toEqual(['/docs/a.md']);
    expect(await readdir(join(home, 'servers'))).toEqual(['4747.json']);
  });

  it('discards a record whose process is gone', async () => {
    await mkdir(home, { recursive: true });
    const stale = JSON.stringify(rec(4747, '/docs/a.md', await deadPid()));
    await writeFile(join(home, 'server.json'), stale, 'utf8');
    expect(await list()).toEqual([]);
    await expect(readdir(home)).resolves.not.toContain('server.json');
  });
});

describe('record validation', () => {
  it.each([
    ['a pid of -1, which POSIX kill reads as every process the user owns', -1],
    ['a pid of 0, which POSIX kill reads as the whole process group', 0],
    ['a non-integer pid', 1.5],
  ])('discards %s', async (_label, pid) => {
    await mkdir(join(home, 'servers'), { recursive: true });
    const bad = { ...rec(4747, '/docs/a.md'), pid };
    await writeFile(join(home, 'servers', '4747.json'), JSON.stringify(bad), 'utf8');
    expect(await list()).toEqual([]);
  });

  it('discards a port outside the valid range', async () => {
    await mkdir(join(home, 'servers'), { recursive: true });
    const bad = { ...rec(4747, '/docs/a.md'), port: 70000 };
    await writeFile(join(home, 'servers', '4747.json'), JSON.stringify(bad), 'utf8');
    expect(await list()).toEqual([]);
  });
});

describe('findByFile', () => {
  it('matches on the absolute path', async () => {
    await register(rec(4747, '/docs/a.md'));
    expect((await findByFile('/docs/a.md'))?.port).toBe(4747);
    expect(await findByFile('/docs/b.md')).toBeUndefined();
  });

  it('does not match a record whose process is gone', async () => {
    await register(rec(4747, '/docs/a.md', await deadPid()));
    expect(await findByFile('/docs/a.md')).toBeUndefined();
  });
});

describe('unregister', () => {
  it('removes only the named port', async () => {
    await register(rec(4747, '/docs/a.md'));
    await register(rec(4748, '/docs/b.md'));
    await unregister(4747);
    expect((await list()).map((r) => r.port)).toEqual([4748]);
  });
});

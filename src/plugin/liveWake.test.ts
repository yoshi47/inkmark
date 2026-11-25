import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createWakeManager,
  type LiveContext,
  type LiveDeps,
  type LiveEvent,
  onPath,
  spawnWait,
  startLiveWake,
  waitArgs,
  type Waiter,
  type WaitResult,
} from '../../skills/live-wake.js';

function noop(): void {
  // Replaced once the promise executor runs.
}

interface FakeWaiter extends Waiter {
  args: readonly string[];
  finish(result: WaitResult): void;
  killed: boolean;
}

function fakeRunner(): { run: (args: readonly string[]) => FakeWaiter; started: FakeWaiter[] } {
  const started: FakeWaiter[] = [];
  return {
    started,
    run(args: readonly string[]): FakeWaiter {
      let finish: (result: WaitResult) => void = noop;
      const result = new Promise<WaitResult>((resolve) => {
        finish = resolve;
      });
      const waiter: FakeWaiter = {
        args,
        result,
        killed: false,
        finish: (r) => {
          finish(r);
        },
        kill(): void {
          waiter.killed = true;
        },
      };
      started.push(waiter);
      return waiter;
    },
  };
}

function nth(started: FakeWaiter[], index: number): FakeWaiter {
  const waiter = started[index];
  if (waiter === undefined) throw new Error(`no waiter #${String(index)}`);
  return waiter;
}

describe('createWakeManager', () => {
  it('runs inkmark wait for the session directory, labelled as opencode', () => {
    expect(waitArgs('/repo', 'ses_1')).toEqual([
      'wait',
      '--project',
      '/repo',
      '--timeout',
      '7200',
      '--agent',
      'opencode',
      '--session',
      'ses_1',
    ]);
  });

  it('keeps one waiter per session while it is running', () => {
    const { run, started } = fakeRunner();
    const manager = createWakeManager(
      run,
      vi.fn(() => Promise.resolve()),
    );

    expect(manager.arm('ses_1', '/repo')).toBe(true);
    expect(manager.arm('ses_1', '/repo')).toBe(false);
    expect(manager.arm('ses_2', '/repo')).toBe(true);
    expect(started.map((w) => w.args.at(-1))).toEqual(['ses_1', 'ses_2']);
  });

  it('delivers the output to the same session when the waiter exits 0', async () => {
    const { run, started } = fakeRunner();
    const deliver = vi.fn(() => Promise.resolve());
    const manager = createWakeManager(run, deliver);

    manager.arm('ses_1', '/repo');
    nth(started, 0).finish({ code: 0, output: 'inkmark: 1 new comment in /repo/a.md\n' });

    await vi.waitFor(() => {
      expect(deliver).toHaveBeenCalledWith('ses_1', 'inkmark: 1 new comment in /repo/a.md\n');
    });
  });

  it.each([
    ['the timeout ran out', { code: 3, output: '' }],
    ['there was nothing to wait for', { code: 0, output: '' }],
    ['the process could not start', { code: null, output: '', error: new Error('ENOENT') }],
  ])('delivers nothing when %s', async (_case, result) => {
    const { run, started } = fakeRunner();
    const deliver = vi.fn(() => Promise.resolve());
    const manager = createWakeManager(run, deliver);

    manager.arm('ses_1', '/repo');
    nth(started, 0).finish(result);

    // The waiter leaves the map in the same callback that decides on delivery.
    await vi.waitFor(() => {
      expect(manager.has('ses_1')).toBe(false);
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('warns when inkmark wait could not be started', async () => {
    const { run, started } = fakeRunner();
    const warn = vi.fn();
    const manager = createWakeManager(
      run,
      vi.fn(() => Promise.resolve()),
      warn,
    );

    manager.arm('ses_1', '/repo');
    nth(started, 0).finish({ code: null, output: '', error: new Error('spawn inkmark ENOENT') });

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('could not run inkmark wait: spawn inkmark ENOENT');
    });
  });

  it('re-arms once the previous waiter has exited', async () => {
    const { run, started } = fakeRunner();
    const manager = createWakeManager(
      run,
      vi.fn(() => Promise.resolve()),
    );

    manager.arm('ses_1', '/repo');
    nth(started, 0).finish({ code: 0, output: 'comment\n' });

    await vi.waitFor(() => {
      expect(manager.has('ses_1')).toBe(false);
    });
    expect(manager.arm('ses_1', '/repo')).toBe(true);
    expect(started).toHaveLength(2);
  });

  it('kills a stopped waiter and drops whatever it prints afterwards', async () => {
    const { run, started } = fakeRunner();
    const deliver = vi.fn(() => Promise.resolve());
    const manager = createWakeManager(run, deliver);

    manager.arm('ses_1', '/repo');
    manager.stop('ses_1');
    nth(started, 0).finish({ code: 0, output: 'late\n' });
    await nth(started, 0).result;
    // A fresh waiter armed after the stale one finished proves its callback has run.
    manager.arm('ses_1', '/repo');

    expect(nth(started, 0).killed).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('kills every waiter on dispose and arms nothing after it', async () => {
    const { run, started } = fakeRunner();
    const deliver = vi.fn(() => Promise.resolve());
    const manager = createWakeManager(run, deliver);

    manager.arm('ses_1', '/repo');
    manager.arm('ses_2', '/repo');
    manager.dispose();
    for (const waiter of started) waiter.finish({ code: 0, output: 'late\n' });
    await Promise.all(started.map((w) => w.result));

    expect(started.map((w) => w.killed)).toEqual([true, true]);
    expect(manager.arm('ses_3', '/repo')).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('survives a delivery that fails', async () => {
    const { run, started } = fakeRunner();
    const deliver = vi.fn(() => Promise.reject(new Error('session gone')));
    const manager = createWakeManager(run, deliver);

    manager.arm('ses_1', '/repo');
    nth(started, 0).finish({ code: 0, output: 'comment\n' });

    await vi.waitFor(() => {
      expect(deliver).toHaveBeenCalled();
    });
    expect(manager.arm('ses_1', '/repo')).toBe(true);
  });
});

describe('spawnWait', () => {
  it('reports a command that does not exist instead of throwing', async () => {
    const result = await spawnWait([], 'inkmark-command-that-does-not-exist').result;

    expect(result.code).toBeNull();
    expect(result.output).toBe('');
    expect(result.error?.message).toMatch(/ENOENT/);
  });

  it('collects output written in several chunks', async () => {
    const script =
      'process.stdout.write("first "); setTimeout(() => process.stdout.write("second\\n"), 30);';
    const result = await spawnWait(['-e', script], process.execPath).result;

    expect(result).toEqual({ code: 0, output: 'first second\n' });
  });

  it('kills a running waiter, and kill after exit does nothing', async () => {
    const waiter = spawnWait(['-e', 'setInterval(() => {}, 1000);'], process.execPath);
    waiter.kill();
    const result = await waiter.result;

    expect(result.code).toBeNull();
    expect(() => {
      waiter.kill();
    }).not.toThrow();
  });
});

describe('onPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkmark-onpath-'));
  writeFileSync(join(dir, 'runnable'), '#!/bin/sh\n');
  chmodSync(join(dir, 'runnable'), 0o755);
  writeFileSync(join(dir, 'plain'), '');
  chmodSync(join(dir, 'plain'), 0o644);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds an executable in any PATH entry', () => {
    expect(onPath('runnable', { PATH: `/nonexistent-dir:${dir}` })).toBe(true);
  });

  it('ignores a file that is not executable, and a missing PATH', () => {
    expect(onPath('plain', { PATH: dir })).toBe(false);
    expect(onPath('runnable', {})).toBe(false);
  });
});

/** A server-wide event stream: every subscriber sees every event pushed after it subscribed. */
function eventStream(): {
  push(event: LiveEvent): void;
  subscribe: LiveContext['event']['subscribe'];
  types: string[][];
} {
  const subscribers: { queue: LiveEvent[]; wake: () => void }[] = [];
  const types: string[][] = [];
  return {
    types,
    push(event: LiveEvent): void {
      for (const subscriber of subscribers) {
        subscriber.queue.push(event);
        subscriber.wake();
      }
    },
    subscribe(options: { types: string[]; signal: AbortSignal }): AsyncIterable<LiveEvent> {
      types.push(options.types);
      const subscriber = { queue: [] as LiveEvent[], wake: noop };
      subscribers.push(subscriber);
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<LiveEvent> {
          while (!options.signal.aborted) {
            const next = subscriber.queue.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              subscriber.wake = resolve;
              options.signal.addEventListener('abort', () => {
                resolve();
              });
            });
          }
        },
      };
    },
  };
}

interface Harness {
  context: LiveContext;
  synthetic: ReturnType<typeof vi.fn>;
  started: FakeWaiter[];
  start(overrides?: Partial<LiveDeps>): (() => void) | undefined;
}

function harness(
  sessions: Record<string, unknown>,
  stream: ReturnType<typeof eventStream>,
  directory = '/repo',
  get?: LiveContext['session']['get'],
): Harness {
  const synthetic = vi.fn(() => Promise.resolve({}));
  const { run, started } = fakeRunner();
  const context: LiveContext = {
    location: { directory },
    event: { subscribe: stream.subscribe },
    session: {
      get: get ?? (({ sessionID }): Promise<unknown> => Promise.resolve(sessions[sessionID])),
      synthetic,
    },
  };
  return {
    context,
    synthetic,
    started,
    start: (overrides = {}) =>
      startLiveWake(context, { env: {}, run, hasInkmark: () => true, warn: vi.fn(), ...overrides }),
  };
}

const ROOT = { id: 'ses_1', location: { directory: '/repo' } };
const OTHER = { id: 'ses_2', location: { directory: '/repo' } };

function turnEnded(sessionID: string): LiveEvent {
  return { type: 'session.execution.succeeded', data: { sessionID } };
}

describe('startLiveWake', () => {
  it('arms a waiter in the session directory when a turn succeeds', async () => {
    const stream = eventStream();
    const live = harness({ ses_1: ROOT }, stream);
    const stop = live.start();

    stream.push(turnEnded('ses_1'));

    await vi.waitFor(() => {
      expect(live.started.map((w) => w.args)).toEqual([waitArgs('/repo', 'ses_1')]);
    });
    expect(stream.types).toEqual([['session.execution.succeeded', 'session.deleted']]);
    stop?.();
  });

  it('sends the comment as a queued synthetic message', async () => {
    const stream = eventStream();
    const live = harness({ ses_1: ROOT }, stream);
    const stop = live.start();

    stream.push(turnEnded('ses_1'));
    await vi.waitFor(() => {
      expect(live.started).toHaveLength(1);
    });
    nth(live.started, 0).finish({ code: 0, output: 'inkmark: 1 new comment\n' });

    await vi.waitFor(() => {
      expect(live.synthetic).toHaveBeenCalledWith({
        sessionID: 'ses_1',
        text: 'inkmark: 1 new comment\n',
        description: 'inkmark: new comment',
        delivery: 'queue',
      });
    });
    stop?.();
  });

  it('arms a session in exactly one of two instances: the one loaded where it lives', async () => {
    const stream = eventStream();
    const own = { id: 'ses_3', location: { directory: '/other-project' } };
    const sessions = { ses_1: ROOT, ses_3: own };
    const here = harness(sessions, stream, '/repo');
    const elsewhere = harness(sessions, stream, '/other-project');
    const stopHere = here.start();
    const stopElsewhere = elsewhere.start();

    stream.push(turnEnded('ses_1'));
    // Each instance arming its own ses_3 proves it has handled the ses_1 event before it.
    stream.push(turnEnded('ses_3'));

    await vi.waitFor(() => {
      expect(here.started.map((w) => w.args.at(-1))).toEqual(['ses_1']);
      expect(elsewhere.started.map((w) => w.args.at(-1))).toEqual(['ses_3']);
    });
    stopHere?.();
    stopElsewhere?.();
  });

  it('does not start a second waiter for a turn that ends while one is parked', async () => {
    const stream = eventStream();
    const live = harness({ ses_1: ROOT, ses_2: OTHER }, stream);
    const stop = live.start();

    stream.push(turnEnded('ses_1'));
    stream.push(turnEnded('ses_1'));
    stream.push(turnEnded('ses_2'));

    await vi.waitFor(() => {
      expect(live.started.map((w) => w.args.at(-1))).toEqual(['ses_1', 'ses_2']);
    });
    stop?.();
  });

  it.each([
    ['a subagent session', { id: 'ses_1', parentID: 'ses_0', location: { directory: '/repo' } }],
    ['a session in another directory', { id: 'ses_1', location: { directory: '/elsewhere' } }],
    ['a session with no location', { id: 'ses_1' }],
  ])('leaves %s alone', async (_case, session) => {
    const stream = eventStream();
    const live = harness({ ses_1: session, ses_2: OTHER }, stream);
    const stop = live.start();

    stream.push(turnEnded('ses_1'));
    stream.push(turnEnded('ses_2'));

    await vi.waitFor(() => {
      expect(live.started.map((w) => w.args.at(-1))).toEqual(['ses_2']);
    });
    stop?.();
  });

  it('treats a null parentID as a root session', async () => {
    const stream = eventStream();
    const live = harness({ ses_1: { ...ROOT, parentID: null } }, stream);
    const stop = live.start();

    stream.push(turnEnded('ses_1'));

    await vi.waitFor(() => {
      expect(live.started).toHaveLength(1);
    });
    stop?.();
  });

  it.each(['session.execution.failed', 'session.execution.interrupted'])(
    'does not arm on %s',
    async (type) => {
      const stream = eventStream();
      const live = harness({ ses_1: ROOT, ses_2: OTHER }, stream);
      const stop = live.start();

      stream.push({ type, data: { sessionID: 'ses_1' } });
      stream.push(turnEnded('ses_2'));

      await vi.waitFor(() => {
        expect(live.started.map((w) => w.args.at(-1))).toEqual(['ses_2']);
      });
      stop?.();
    },
  );

  it('skips a turn whose session cannot be read, and keeps listening', async () => {
    const stream = eventStream();
    const live = harness({}, stream, '/repo', ({ sessionID }) =>
      sessionID === 'ses_1' ? Promise.reject(new Error('not found')) : Promise.resolve(OTHER),
    );
    const stop = live.start();

    stream.push(turnEnded('ses_1'));
    stream.push(turnEnded('ses_2'));

    await vi.waitFor(() => {
      expect(live.started.map((w) => w.args.at(-1))).toEqual(['ses_2']);
    });
    stop?.();
  });

  it('kills the waiter of a deleted session', async () => {
    const stream = eventStream();
    const live = harness({ ses_1: ROOT }, stream);
    const stop = live.start();

    stream.push(turnEnded('ses_1'));
    await vi.waitFor(() => {
      expect(live.started).toHaveLength(1);
    });
    stream.push({ type: 'session.deleted', data: { sessionID: 'ses_1' } });

    await vi.waitFor(() => {
      expect(nth(live.started, 0).killed).toBe(true);
    });
    stop?.();
  });

  it('does not arm a session deleted while its turn-end was being looked up', async () => {
    const stream = eventStream();
    let release: (session: unknown) => void = noop;
    const lookup = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const live = harness({ ses_2: OTHER }, stream, '/repo', ({ sessionID }) =>
      sessionID === 'ses_1' ? lookup : Promise.resolve(OTHER),
    );
    const stop = live.start();

    stream.push(turnEnded('ses_1'));
    stream.push({ type: 'session.deleted', data: { sessionID: 'ses_1' } });
    // Once ses_2 arms, the deletion (pushed before it) has been handled.
    stream.push(turnEnded('ses_2'));
    await vi.waitFor(() => {
      expect(live.started).toHaveLength(1);
    });
    release(ROOT);
    // The handler awaited this lookup first, so its continuation has run once this await returns.
    await lookup;

    expect(live.started.map((w) => w.args.at(-1))).toEqual(['ses_2']);
    stop?.();
  });

  it('kills its waiters when the plugin unloads', async () => {
    const stream = eventStream();
    const live = harness({ ses_1: ROOT }, stream);
    const stop = live.start();

    stream.push(turnEnded('ses_1'));
    await vi.waitFor(() => {
      expect(live.started).toHaveLength(1);
    });
    stop?.();

    expect(nth(live.started, 0).killed).toBe(true);
  });

  it('does nothing when INKMARK_LIVE=off', () => {
    const stream = eventStream();
    const live = harness({ ses_1: ROOT }, stream);

    expect(live.start({ env: { INKMARK_LIVE: 'off' } })).toBeUndefined();
    expect(stream.types).toEqual([]);
  });

  it('warns once and does nothing when inkmark is not on PATH', () => {
    const stream = eventStream();
    const live = harness({ ses_1: ROOT }, stream);
    const warn = vi.fn();

    expect(live.start({ hasInkmark: () => false, warn })).toBeUndefined();
    expect(stream.types).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/not on the OpenCode server PATH/);
  });

  it('resubscribes with a doubling, capped delay and warns only on the first failure', async () => {
    const delays: number[] = [];
    const warn = vi.fn();
    let subscriptions = 0;
    const context: LiveContext = {
      location: { directory: '/repo' },
      event: {
        subscribe(): AsyncIterable<LiveEvent> {
          subscriptions++;
          throw new Error('stream overflowed');
        },
      },
      session: { get: () => Promise.resolve(ROOT), synthetic: () => Promise.resolve({}) },
    };
    // Read only from the seventh sleep, long after startLiveWake has returned.
    const stop: (() => void) | undefined = startLiveWake(context, {
      env: {},
      hasInkmark: () => true,
      run: fakeRunner().run,
      warn,
      sleep: (ms) => {
        delays.push(ms);
        if (delays.length === 7) stop?.();
        return Promise.resolve();
      },
    });

    await vi.waitFor(() => {
      expect(delays).toHaveLength(7);
    });
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(subscriptions).toBe(7);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/stream overflowed/);
  });

  it('stops retrying when cleaned up during a backoff', async () => {
    let subscriptions = 0;
    let sleeping: AbortSignal | null = null;
    const context: LiveContext = {
      location: { directory: '/repo' },
      event: {
        subscribe(): AsyncIterable<LiveEvent> {
          subscriptions++;
          throw new Error('stream overflowed');
        },
      },
      session: { get: () => Promise.resolve(ROOT), synthetic: () => Promise.resolve({}) },
    };
    const stop = startLiveWake(context, {
      env: {},
      hasInkmark: () => true,
      run: fakeRunner().run,
      warn: vi.fn(),
      sleep: (_ms, signal) => {
        sleeping = signal;
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            resolve();
          });
        });
      },
    });

    await vi.waitFor(() => {
      expect(sleeping).not.toBeNull();
    });
    stop?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(subscriptions).toBe(1);
  });
});

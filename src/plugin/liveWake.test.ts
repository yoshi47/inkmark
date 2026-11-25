import { describe, expect, it, vi } from 'vitest';
import {
  createWakeManager,
  type LiveContext,
  type LiveEvent,
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

/** Lets the promise chains hanging off a finished waiter run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
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
    await settle();

    expect(deliver).toHaveBeenCalledWith('ses_1', 'inkmark: 1 new comment in /repo/a.md\n');
  });

  it.each([
    ['the timeout ran out', { code: 3, output: '' }],
    ['there was nothing to wait for', { code: 0, output: '' }],
    ['the process could not start', { code: null, output: '' }],
  ])('delivers nothing when %s', async (_case, result) => {
    const { run, started } = fakeRunner();
    const deliver = vi.fn(() => Promise.resolve());
    const manager = createWakeManager(run, deliver);

    manager.arm('ses_1', '/repo');
    nth(started, 0).finish(result);
    await settle();

    expect(deliver).not.toHaveBeenCalled();
  });

  it('re-arms once the previous waiter has exited', async () => {
    const { run, started } = fakeRunner();
    const manager = createWakeManager(
      run,
      vi.fn(() => Promise.resolve()),
    );

    manager.arm('ses_1', '/repo');
    nth(started, 0).finish({ code: 0, output: 'comment\n' });
    await settle();

    expect(manager.has('ses_1')).toBe(false);
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
    await settle();

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
    await settle();

    expect(started.map((w) => w.killed)).toEqual([true, true]);
    expect(manager.arm('ses_3', '/repo')).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('survives a delivery that fails', async () => {
    const { run, started } = fakeRunner();
    const manager = createWakeManager(run, () => Promise.reject(new Error('session gone')));

    manager.arm('ses_1', '/repo');
    nth(started, 0).finish({ code: 0, output: 'comment\n' });
    await settle();

    expect(manager.arm('ses_1', '/repo')).toBe(true);
  });
});

/** An event stream the test pushes into, ending when the subscriber's signal aborts. */
function eventStream(): {
  push(event: LiveEvent): void;
  subscribe: LiveContext['event']['subscribe'];
  types: string[][];
} {
  const queue: LiveEvent[] = [];
  let wake: (() => void) | null = null;
  const types: string[][] = [];
  return {
    types,
    push(event: LiveEvent): void {
      queue.push(event);
      wake?.();
    },
    subscribe(options: { types: string[]; signal: AbortSignal }): AsyncIterable<LiveEvent> {
      types.push(options.types);
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<LiveEvent> {
          while (!options.signal.aborted) {
            const next = queue.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
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

function liveHarness(sessions: Record<string, unknown>): {
  context: LiveContext;
  prompt: ReturnType<typeof vi.fn>;
  started: FakeWaiter[];
  stream: ReturnType<typeof eventStream>;
  start(env?: NodeJS.ProcessEnv, hasInkmark?: boolean): (() => void) | undefined;
} {
  const stream = eventStream();
  const prompt = vi.fn(() => Promise.resolve({}));
  const { run, started } = fakeRunner();
  const context: LiveContext = {
    event: { subscribe: stream.subscribe },
    session: {
      get: ({ sessionID }) => Promise.resolve(sessions[sessionID]),
      prompt,
    },
  };
  return {
    context,
    prompt,
    started,
    stream,
    start: (env = {}, hasInkmark = true) =>
      startLiveWake(context, { env, run, hasInkmark: () => hasInkmark }),
  };
}

const ROOT_SESSION = { id: 'ses_1', location: { directory: '/repo' } };

describe('startLiveWake', () => {
  it('arms a waiter in the session directory when a turn succeeds', async () => {
    const live = liveHarness({ ses_1: ROOT_SESSION });
    const stop = live.start();

    live.stream.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    await settle();

    expect(live.stream.types).toEqual([['session.execution.succeeded', 'session.deleted']]);
    expect(live.started.map((w) => w.args)).toEqual([waitArgs('/repo', 'ses_1')]);
    stop?.();
  });

  it('prompts the session with the comment, queued behind any running turn', async () => {
    const live = liveHarness({ ses_1: ROOT_SESSION });
    const stop = live.start();

    live.stream.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    await settle();
    nth(live.started, 0).finish({ code: 0, output: 'inkmark: 1 new comment\n' });
    await settle();

    expect(live.prompt).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      text: 'inkmark: 1 new comment\n',
      delivery: 'queue',
    });
    stop?.();
  });

  it('does not start a second waiter for a turn that ends while one is parked', async () => {
    const live = liveHarness({ ses_1: ROOT_SESSION });
    const stop = live.start();

    live.stream.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    await settle();
    live.stream.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    await settle();

    expect(live.started).toHaveLength(1);
    stop?.();
  });

  it('leaves subagent sessions alone', async () => {
    const live = liveHarness({
      ses_child: { id: 'ses_child', parentID: 'ses_1', location: { directory: '/repo' } },
    });
    const stop = live.start();

    live.stream.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } });
    await settle();

    expect(live.started).toHaveLength(0);
    stop?.();
  });

  it('kills the waiter of a deleted session', async () => {
    const live = liveHarness({ ses_1: ROOT_SESSION });
    const stop = live.start();

    live.stream.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    await settle();
    live.stream.push({ type: 'session.deleted', data: { sessionID: 'ses_1' } });
    await settle();

    expect(nth(live.started, 0).killed).toBe(true);
    stop?.();
  });

  it('kills its waiters when the plugin unloads', async () => {
    const live = liveHarness({ ses_1: ROOT_SESSION });
    const stop = live.start();

    live.stream.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    await settle();
    stop?.();

    expect(nth(live.started, 0).killed).toBe(true);
  });

  it('does nothing when INKMARK_LIVE=off', () => {
    const live = liveHarness({ ses_1: ROOT_SESSION });

    expect(live.start({ INKMARK_LIVE: 'off' })).toBeUndefined();
    expect(live.stream.types).toEqual([]);
  });

  it('does nothing when inkmark is not on PATH', () => {
    const live = liveHarness({ ses_1: ROOT_SESSION });

    expect(live.start({}, false)).toBeUndefined();
    expect(live.stream.types).toEqual([]);
  });
});

/**
 * Live mode for OpenCode: the counterpart of `hooks/wake.sh`, which Claude Code and Codex run as a
 * Stop hook. OpenCode has no hook that outlives a turn, so the plugin itself parks
 * `inkmark wait` when a session's turn ends and hands what it prints back to that session as a
 * new prompt.
 *
 * Kept apart from `opencode-plugin.ts` so the bookkeeping (one waiter per session, re-arming,
 * delivery, cleanup) can be tested without an OpenCode to load it: everything that touches a
 * process or OpenCode comes in as an argument.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** The label `inkmark wait --agent` records, for the viewer to say who a comment would wake. */
const AGENT = 'opencode';

/** Same lapse as `hooks/wake.sh`: the next turn re-arms, so expiring costs one nudge, not the feature. */
const WAIT_SECONDS = 7200;

/**
 * Why not `session.idle`: in OpenCode 2.4.1 that name only survives in the legacy event set beside
 * the `tui.*` events, and OpenCode's own TUI decides a session went idle from `session.execution.*`.
 * Only a turn that finished counts, as with Claude Code's Stop hook: `interrupted` also covers the
 * server shutting down, and a failed turn did not end in a reply the human could comment on.
 */
const TURN_ENDED = 'session.execution.succeeded';
const SESSION_DELETED = 'session.deleted';

/** A stream that fails (a slow consumer overflows it) must not end live mode for the whole run. */
const RESUBSCRIBE_DELAY_MS = 1000;

export interface WaitResult {
  /** null when the process could not start or was killed by a signal. */
  code: number | null;
  output: string;
}

export interface Waiter {
  result: Promise<WaitResult>;
  kill(): void;
}

export type RunWait = (args: readonly string[]) => Waiter;
export type Deliver = (sessionID: string, text: string) => Promise<unknown>;

export interface WakeManager {
  /** Starts a waiter for the session unless one is already running; true when it started one. */
  arm(sessionID: string, directory: string): boolean;
  has(sessionID: string): boolean;
  /** Kills the session's waiter without delivering anything it might still print. */
  stop(sessionID: string): void;
  dispose(): void;
}

export function waitArgs(directory: string, sessionID: string): string[] {
  return [
    'wait',
    '--project',
    directory,
    '--timeout',
    String(WAIT_SECONDS),
    '--agent',
    AGENT,
    '--session',
    sessionID,
  ];
}

export function createWakeManager(run: RunWait, deliver: Deliver): WakeManager {
  const waiters = new Map<string, Waiter>();
  let disposed = false;

  return {
    arm(sessionID: string, directory: string): boolean {
      if (disposed || waiters.has(sessionID)) return false;
      const waiter = run(waitArgs(directory, sessionID));
      waiters.set(sessionID, waiter);
      void waiter.result
        .then(async ({ code, output }) => {
          // A waiter that was stopped is no longer in the map (or another one is): whatever it
          // printed belongs to a session that is gone or a plugin that is unloading.
          if (waiters.get(sessionID) !== waiter) return;
          waiters.delete(sessionID);
          if (disposed || code !== 0 || output.trim() === '') return;
          await deliver(sessionID, output);
        })
        .catch(() => undefined);
      return true;
    },
    has(sessionID: string): boolean {
      return waiters.has(sessionID);
    },
    stop(sessionID: string): void {
      const waiter = waiters.get(sessionID);
      if (waiter === undefined) return;
      waiters.delete(sessionID);
      waiter.kill();
    },
    dispose(): void {
      disposed = true;
      for (const waiter of waiters.values()) waiter.kill();
      waiters.clear();
    },
  };
}

/** Runs `inkmark wait` and collects what it prints; it never rejects. */
export function spawnWait(args: readonly string[]): Waiter {
  const child = spawn('inkmark', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  const result = new Promise<WaitResult>((resolve) => {
    child.once('error', () => {
      resolve({ code: null, output: '' });
    });
    child.once('close', (code) => {
      resolve({ code, output });
    });
  });
  return {
    result,
    kill(): void {
      // SIGTERM, not SIGKILL: `inkmark wait` releases its lock on SIGTERM and exits without
      // printing, so the viewer stops naming a session that is no longer listening.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    },
  };
}

/** Whether `name` resolves on PATH, without spawning a shell to ask. */
export function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not in this directory; try the next one.
    }
  }
  return false;
}

export interface LiveEvent {
  type: string;
  data?: unknown;
}

/** The slice of OpenCode's plugin context live mode uses. */
export interface LiveContext {
  event: {
    subscribe(options: { types: string[]; signal: AbortSignal }): AsyncIterable<LiveEvent>;
  };
  session: {
    get(input: { sessionID: string }): Promise<unknown>;
    prompt(input: {
      sessionID: string;
      text: string;
      delivery: 'queue' | 'steer';
    }): Promise<unknown>;
  };
}

export interface LiveDeps {
  env: NodeJS.ProcessEnv;
  run: RunWait;
  hasInkmark(env: NodeJS.ProcessEnv): boolean;
}

const DEFAULT_DEPS: LiveDeps = {
  env: process.env,
  run: spawnWait,
  hasInkmark: (env) => onPath('inkmark', env),
};

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The directory to wait under, or null for a session that should not wait at all.
 *
 * A subagent's session (one with a parent) ends a turn every time it hands its result back; a
 * waiter there would take the document's lock and route the human's comment to a session nobody
 * is talking to.
 */
function waitDirectory(session: unknown): string | null {
  if (field(session, 'parentID') !== undefined) return null;
  const directory = field(field(session, 'location'), 'directory');
  return typeof directory === 'string' && directory !== '' ? directory : null;
}

/**
 * Starts live mode on an OpenCode plugin context and returns its cleanup, or undefined when live
 * mode is off or `inkmark` is not installed — the same two cases in which `hooks/wake.sh` exits
 * without doing anything.
 */
export function startLiveWake(
  context: LiveContext,
  deps: LiveDeps = DEFAULT_DEPS,
): (() => void) | undefined {
  if ((deps.env['INKMARK_LIVE'] ?? 'on') === 'off') return undefined;
  if (!deps.hasInkmark(deps.env)) return undefined;

  // `queue`, not the default `steer`: a comment that lands while the human is mid-conversation
  // with the agent waits for that turn instead of being pushed into it.
  const manager = createWakeManager(deps.run, (sessionID, text) =>
    context.session.prompt({ sessionID, text, delivery: 'queue' }),
  );
  const controller = new AbortController();

  async function onTurnEnded(sessionID: string): Promise<void> {
    if (manager.has(sessionID)) return;
    const directory = waitDirectory(await context.session.get({ sessionID }));
    if (directory === null || controller.signal.aborted) return;
    manager.arm(sessionID, directory);
  }

  async function listen(): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        const events = context.event.subscribe({
          types: [TURN_ENDED, SESSION_DELETED],
          signal: controller.signal,
        });
        for await (const event of events) {
          const sessionID = field(event.data, 'sessionID');
          if (typeof sessionID !== 'string') continue;
          if (event.type === SESSION_DELETED) manager.stop(sessionID);
          else if (event.type === TURN_ENDED) void onTurnEnded(sessionID).catch(() => undefined);
        }
      } catch {
        // Fall through to resubscribe.
      }
      await sleep(RESUBSCRIBE_DELAY_MS, undefined, { signal: controller.signal }).catch(
        () => undefined,
      );
    }
  }

  void listen();

  return () => {
    controller.abort();
    manager.dispose();
  };
}

/**
 * Live mode for OpenCode: the counterpart of `hooks/wake.sh`, which Claude Code and Codex run as a
 * Stop hook. OpenCode has no hook that outlives a turn, so the plugin itself parks
 * `inkmark wait` when a session's turn ends and hands what it prints back to that session.
 *
 * Kept apart from `opencode-plugin.ts` so the bookkeeping (one waiter per session, re-arming,
 * delivery, cleanup) can be tested without an OpenCode to load it: everything that touches a
 * process, a timer or OpenCode comes in as an argument.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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

/**
 * A stream that fails (a slow consumer overflows it) must not end live mode for the whole run, and
 * one that keeps failing must not be retried in a tight loop either.
 */
const RESUBSCRIBE_FIRST_MS = 1000;
const RESUBSCRIBE_MAX_MS = 30_000;

/** Shown in OpenCode next to the message, which the human did not type themselves. */
const MESSAGE_DESCRIPTION = 'inkmark: new comment';

export interface WaitResult {
  /** null when the process could not start or was killed by a signal. */
  code: number | null;
  output: string;
  /** Set when the process could not be started at all. */
  error?: Error;
}

export interface Waiter {
  result: Promise<WaitResult>;
  kill(): void;
}

export type RunWait = (args: readonly string[]) => Waiter;
export type Deliver = (sessionID: string, text: string) => Promise<unknown>;
export type Warn = (message: string) => void;

export interface WakeManager {
  /** Starts a waiter for the session unless one is already running; true when it started one. */
  arm(sessionID: string, directory: string): boolean;
  has(sessionID: string): boolean;
  /** Kills the session's waiter without delivering anything it might still print. */
  stop(sessionID: string): void;
  dispose(): void;
}

function ignore(): void {
  // Nothing to report.
}

/**
 * `--parent-pid` is this process, the one that delivers what the waiter prints: if OpenCode dies
 * without unloading the plugin (a crash, a SIGKILL), the waiter notices and leaves instead of
 * holding the document's lock and recording comments nobody will receive.
 */
export function waitArgs(
  directory: string,
  sessionID: string,
  parentPid: number = process.pid,
): string[] {
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
    '--parent-pid',
    String(parentPid),
  ];
}

export function createWakeManager(
  run: RunWait,
  deliver: Deliver,
  warn: Warn = ignore,
): WakeManager {
  const waiters = new Map<string, Waiter>();
  let disposed = false;

  return {
    arm(sessionID: string, directory: string): boolean {
      if (disposed || waiters.has(sessionID)) return false;
      const waiter = run(waitArgs(directory, sessionID));
      waiters.set(sessionID, waiter);
      void waiter.result
        .then(async ({ code, output, error }) => {
          // A waiter that was stopped is no longer in the map (or another one is): whatever it
          // printed belongs to a session that is gone or a plugin that is unloading.
          if (waiters.get(sessionID) !== waiter) return;
          waiters.delete(sessionID);
          if (error !== undefined) warn(`could not run inkmark wait: ${error.message}`);
          if (disposed || code !== 0 || output.trim() === '') return;
          await deliver(sessionID, output);
        })
        .catch(ignore);
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

/**
 * Runs `inkmark wait` and collects what it prints; it never rejects.
 *
 * A plain child, not a detached one: when OpenCode dies without unloading the plugin, nothing
 * here gets to kill it, and the waiter's own `--parent-pid` check (see `waitArgs`) is what ends
 * it.
 */
export function spawnWait(args: readonly string[], command = 'inkmark'): Waiter {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  const result = new Promise<WaitResult>((resolve) => {
    // `on`, not `once`: a second 'error' (a failed kill, say) with no listener left would be
    // thrown into OpenCode's server process.
    child.on('error', (error) => {
      resolve({ code: null, output: '', error });
    });
    child.once('close', (code) => {
      resolve({ code, output });
    });
  });
  return {
    result,
    kill(): void {
      // SIGTERM, not SIGKILL: `inkmark wait` releases its lock on SIGTERM and exits without
      // printing, so the viewer stops naming a session that is no longer listening. A comment
      // it had already recorded as reported in the instant before the signal is lost with it.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    },
  };
}

/**
 * Whether `name` resolves on PATH, without spawning a shell to ask.
 *
 * macOS and Linux only: no PATHEXT lookup, so a Windows `inkmark.cmd` is not found. It reads the
 * OpenCode server's PATH, which for an app started from the macOS GUI is not the shell's.
 */
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
  /** Where this plugin instance is loaded — not where every event it receives comes from. */
  location: { directory: string };
  event: {
    subscribe(options: { types: string[]; signal: AbortSignal }): AsyncIterable<LiveEvent>;
  };
  session: {
    get(input: { sessionID: string }): Promise<unknown>;
    synthetic(input: {
      sessionID: string;
      text: string;
      description?: string;
      delivery: 'queue' | 'steer';
    }): Promise<unknown>;
  };
}

export interface LiveDeps {
  env: NodeJS.ProcessEnv;
  run: RunWait;
  hasInkmark(env: NodeJS.ProcessEnv): boolean;
  /** Resolves after `ms`, or as soon as `signal` aborts; never rejects. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  warn: Warn;
}

const DEFAULT_DEPS: LiveDeps = {
  env: process.env,
  run: spawnWait,
  hasInkmark: (env) => onPath('inkmark', env),
  sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(ignore),
  warn: (message) => {
    console.warn(`[inkmark] ${message}`);
  },
};

/**
 * A directory in the one spelling two paths to it agree on. OpenCode does not promise the session's
 * location and the plugin's are written the same way, and a trailing slash or a symlinked checkout
 * (macOS's /var is one) would otherwise leave a session unarmed with nothing to say why. A path
 * that cannot be resolved on disk is compared as written.
 */
export function canonicalDir(directory: string): string {
  const resolved = resolve(directory);
  let real: string;
  try {
    real = realpathSync.native(resolved);
  } catch {
    real = resolved;
  }
  return real.length > 1 && real.endsWith(sep) ? real.replace(/[\\/]+$/, '') : real;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The directory to wait under, or null for a session this instance should not wait for.
 *
 * A subagent's session (one with a parent) ends a turn every time it hands its result back; a
 * waiter there would take the document's lock and route the human's comment to a session nobody
 * is talking to.
 *
 * The event stream is server-wide, so every instance of this plugin sees every session's turns.
 * Only the instance loaded where the session lives arms it: otherwise each extra instance spawns a
 * waiter the lock turns away, and a plugin configured for one project arms sessions of all others.
 */
function waitDirectory(session: unknown, here: string): string | null {
  if (typeof field(session, 'parentID') === 'string') return null;
  const directory = field(field(session, 'location'), 'directory');
  if (typeof directory !== 'string' || directory === '') return null;
  return canonicalDir(directory) === here ? directory : null;
}

/**
 * Starts live mode on an OpenCode plugin context and returns its cleanup, or undefined when live
 * mode is off or `inkmark` is not installed — the same two cases in which `hooks/wake.sh` exits
 * without doing anything.
 */
export function startLiveWake(
  context: LiveContext,
  overrides: Partial<LiveDeps> = {},
): (() => void) | undefined {
  const deps: LiveDeps = { ...DEFAULT_DEPS, ...overrides };
  if ((deps.env['INKMARK_LIVE'] ?? 'on') === 'off') return undefined;

  const warned = new Set<string>();
  function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    deps.warn(message);
  }

  if (!deps.hasInkmark(deps.env)) {
    warnOnce('missing', 'live mode is off: `inkmark` is not on the OpenCode server PATH');
    return undefined;
  }
  // Read defensively: the context is typed here, not by OpenCode, and without a location no
  // session could ever match it.
  const location: unknown = field(context, 'location');
  const loadedAt = field(location, 'directory');
  if (typeof loadedAt !== 'string' || loadedAt === '') {
    warnOnce('location', 'live mode is off: the plugin context has no location directory');
    return undefined;
  }
  const here = canonicalDir(loadedAt);

  // A synthetic message rather than `prompt`: the text is inkmark's, not something the human
  // typed, and OpenCode keeps that distinction (prompt hooks do not run on it). `queue`, not the
  // default `steer`, so a comment that lands mid-conversation waits for that turn instead of
  // being pushed into it.
  const manager = createWakeManager(
    deps.run,
    (sessionID, text) =>
      context.session.synthetic({
        sessionID,
        text,
        description: MESSAGE_DESCRIPTION,
        delivery: 'queue',
      }),
    (message) => {
      warnOnce('spawn', message);
    },
  );
  const controller = new AbortController();
  // A deletion can arrive while the turn-end handler for the same session is still waiting on
  // `session.get`; without this it would arm a waiter for a session that no longer exists.
  const deleted = new Set<string>();

  async function onTurnEnded(sessionID: string): Promise<void> {
    if (manager.has(sessionID)) return;
    const session = await context.session.get({ sessionID });
    if (controller.signal.aborted || deleted.has(sessionID)) return;
    const directory = waitDirectory(session, here);
    if (directory === null) return;
    manager.arm(sessionID, directory);
  }

  async function listen(): Promise<void> {
    let backoff = RESUBSCRIBE_FIRST_MS;
    while (!controller.signal.aborted) {
      try {
        const events = context.event.subscribe({
          types: [TURN_ENDED, SESSION_DELETED],
          signal: controller.signal,
        });
        for await (const event of events) {
          backoff = RESUBSCRIBE_FIRST_MS;
          const sessionID = field(event.data, 'sessionID');
          if (typeof sessionID !== 'string') continue;
          if (event.type === SESSION_DELETED) {
            deleted.add(sessionID);
            manager.stop(sessionID);
          } else if (event.type === TURN_ENDED) {
            void onTurnEnded(sessionID).catch(ignore);
          }
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          const reason = error instanceof Error ? error.message : String(error);
          warnOnce('stream', `event stream failed, resubscribing: ${reason}`);
        }
      }
      if (controller.signal.aborted) break;
      await deps.sleep(backoff, controller.signal);
      backoff = Math.min(backoff * 2, RESUBSCRIBE_MAX_MS);
    }
  }

  void listen();

  return () => {
    controller.abort();
    manager.dispose();
  };
}

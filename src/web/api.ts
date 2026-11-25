export async function getFile(): Promise<{ content: string; path: string; version: string }> {
  const res = await fetch('/api/file');
  if (!res.ok) throw new Error(`getFile ${String(res.status)}`);
  return (await res.json()) as { content: string; path: string; version: string };
}

export async function putFile(
  content: string,
  baseVersion: string,
): Promise<{ ok: true; version: string } | { ok: false; status: number; version?: string }> {
  const res = await fetch('/api/file', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, baseVersion }),
  });
  if (res.ok) {
    const data = (await res.json()) as { version: string };
    return { ok: true as const, version: data.version };
  }
  const body = (await res.json().catch(() => ({}))) as { version?: string };
  const base = { ok: false as const, status: res.status };
  return body.version !== undefined ? { ...base, version: body.version } : base;
}

/**
 * The UI values shared by every document. Declared here rather than imported from `src/server`:
 * the two are separate TypeScript projects, and the web only needs this one shape.
 */
export interface Config {
  tocWidth?: number;
  commentWidth?: number;
  lineNumbers?: boolean;
  showToc?: boolean;
  contentWidth?: 'full' | '760';
}

/**
 * Live mode for *this* document. `enabled` is the master switch in config.yml; when it is off,
 * arming the document changes nothing, and the header says so instead of lying.
 */
export interface LiveState {
  armed: boolean;
  enabled: boolean;
  /** The agent session waiting on this document right now; null when nothing is listening. */
  watcher: LiveWatcher | null;
}

export interface LiveWatcher {
  agent: string | null;
  session: string | null;
  project: string | null;
  since: string | null;
}

/**
 * A server started before an upgrade keeps running the old code but serves this bundle from disk,
 * so its answer can lack `watcher`. Read as "nobody waiting" rather than trusting the cast: an
 * undefined watcher took the whole viewer down.
 */
async function readLive(res: Response): Promise<LiveState> {
  const body = (await res.json()) as Partial<LiveState>;
  return {
    armed: body.armed !== false,
    enabled: body.enabled !== false,
    watcher: body.watcher ?? null,
  };
}

export async function getLive(): Promise<LiveState> {
  const res = await fetch('/api/live');
  if (!res.ok) throw new Error(`getLive ${String(res.status)}`);
  return readLive(res);
}

export async function putLive(on: boolean): Promise<LiveState> {
  const res = await fetch('/api/live', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on }),
  });
  if (!res.ok) throw new Error(`putLive ${String(res.status)}`);
  return readLive(res);
}

export async function getConfig(): Promise<Config> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`getConfig ${String(res.status)}`);
  return (await res.json()) as Config;
}

export async function putConfig(patch: Config): Promise<void> {
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`putConfig ${String(res.status)}`);
}

export function subscribe(onVersion: (v: string) => void): () => void {
  const es = new EventSource('/api/events');
  es.onmessage = (e: MessageEvent<unknown>): void => {
    try {
      const parsed = JSON.parse(e.data as string) as { version: string };
      onVersion(parsed.version);
    } catch {
      /* ignore malformed */
    }
  };
  return (): void => {
    es.close();
  };
}

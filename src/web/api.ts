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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { homeDir } from './paths.js';

/**
 * UI values shared by every document, in one file the reader can also edit by hand.
 *
 * Not browser storage: localStorage is keyed by origin, and the origin carries the port, so a
 * document served on 4747 keeps its own copy and the next document to take that port inherits
 * it. One file behind the server is the only place where "one setting for everything" holds —
 * across ports, across documents and across browsers.
 */
export interface AppConfig {
  /** px; the bounds live in the web UI (`App.tsx`), so a hand-written value is clamped there. */
  tocWidth?: number;
  /** px, same. */
  commentWidth?: number;
  lineNumbers?: boolean;
  /** Whether the outline column starts open. A phone width still forces it shut. */
  showToc?: boolean;
}

function configPath(): string {
  return join(homeDir(), 'config.yml');
}

/** Known keys with the right primitive type; anything else in the file is not a setting. */
function pick(raw: unknown): AppConfig {
  if (typeof raw !== 'object' || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const out: AppConfig = {};
  const tocWidth = src['tocWidth'];
  if (typeof tocWidth === 'number' && Number.isFinite(tocWidth)) out.tocWidth = tocWidth;
  const commentWidth = src['commentWidth'];
  if (typeof commentWidth === 'number' && Number.isFinite(commentWidth)) {
    out.commentWidth = commentWidth;
  }
  const lineNumbers = src['lineNumbers'];
  if (typeof lineNumbers === 'boolean') out.lineNumbers = lineNumbers;
  const showToc = src['showToc'];
  if (typeof showToc === 'boolean') out.showToc = showToc;
  return out;
}

/**
 * A missing file is "nothing configured yet". An unreadable or malformed one is the same to the
 * caller — a hand-edited typo must not take the viewer down — but it is logged, because a config
 * that is silently ignored is a worse puzzle than one that says so.
 */
export async function readConfig(): Promise<AppConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath(), 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('inkmark: could not read config.yml:', err);
    }
    return {};
  }
  try {
    return pick(parseYaml(raw));
  } catch (err: unknown) {
    console.error('inkmark: could not parse config.yml; using defaults:', err);
    return {};
  }
}

/**
 * Merge and rewrite the file, so a key the caller did not touch survives. Two servers writing at
 * once can still lose one of the writes — accepted: the file is UI state, and the reader would
 * have to drag two columns in two windows within the same read-modify-write window.
 */
export async function updateConfig(patch: unknown): Promise<AppConfig> {
  const next: AppConfig = { ...(await readConfig()), ...pick(patch) };
  const file = configPath();
  await mkdir(dirname(file), { recursive: true });
  // Rename, not an in-place write: a reader (or another server) must never see half a file.
  const tmp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(tmp, stringifyYaml(next), 'utf8');
  await rename(tmp, file);
  return next;
}

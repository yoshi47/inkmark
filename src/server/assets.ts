import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';

/**
 * Extension → MIME, and the allowlist in one: an extension absent here is not served at all, so
 * the type in the header can never disagree with the type that passed the check.
 *
 * `.svg` is deliberately absent. It does not execute inside <img>, but every browser offers "open
 * image in new tab", and an SVG opened as a top-level document runs its scripts in this app's
 * origin — where `PUT /api/file` would rewrite the document being reviewed.
 */
const IMAGE_MIME = new Map<string, string>([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

/** The walk is a handful of blocking existsSync calls, and the answer cannot change while the
 *  server is serving that document. */
const rootCache = new Map<string, string>();

export interface ResolvedAsset {
  mime: string;
  path: string;
}

/**
 * The directory an asset path may not escape: the repository the document lives in, falling back to
 * the document's own directory. Assets commonly sit beside the document's folder rather than inside
 * it (`../assets/x.png`), so the document's directory alone is too tight a root.
 */
export function assetRoot(docPath: string): string {
  const cached = rootCache.get(docPath);
  if (cached !== undefined) return cached;
  const docDir = dirname(docPath);
  let dir = docDir;
  let root = docDir;
  for (;;) {
    // existsSync reports false for a `.git` inside an unreadable directory rather than throwing,
    // so an unreadable ancestor silently widens the root. Accepted: the alternative is failing
    // every asset request over a directory the user cannot read anyway.
    if (existsSync(join(dir, '.git'))) {
      root = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  rootCache.set(docPath, root);
  return root;
}

/**
 * Resolve a path referenced by the document to a file that may be served, or null.
 *
 * Both gates run on the symlink-resolved path, which is what makes them gates: containment
 * compared before resolution would be defeated by a link out of the root, and an extension read
 * before resolution would let `a.png -> b.svg` be served labelled as something its bytes are not.
 *
 * Every refusal collapses into null — the caller answers 404 either way, so the endpoint cannot be
 * used to tell "missing" from "out of bounds" — but each one is logged, because the person running
 * the server is the one who has to work out why an image is broken.
 */
export async function resolveAsset(
  docPath: string,
  requested: string,
): Promise<ResolvedAsset | null> {
  let root: string;
  try {
    root = await realpath(assetRoot(docPath));
  } catch (err) {
    // Not about this request: no asset under this document will resolve until it is fixed.
    console.error(`asset root unresolvable for ${docPath}:`, err);
    return null;
  }
  let real: string;
  try {
    real = await realpath(resolve(dirname(docPath), requested));
  } catch (err) {
    // A path the document simply got wrong is the common case and needs no stack.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      console.error(`asset not found: ${requested}`);
    else console.error(`asset unresolvable (${requested}):`, err);
    return null;
  }
  if (real !== root && !real.startsWith(root.endsWith(sep) ? root : root + sep)) {
    console.error(`asset outside ${root}: ${real}`);
    return null;
  }
  const mime = IMAGE_MIME.get(extname(real).toLowerCase());
  if (mime === undefined) {
    console.error(`asset type not served: ${real}`);
    return null;
  }
  try {
    if (!(await stat(real)).isFile()) {
      console.error(`asset is not a file: ${real}`);
      return null;
    }
  } catch (err) {
    // realpath just succeeded on this path, so a failure here is a race, not a bad reference.
    console.error(`asset stat failed (${real}):`, err);
    return null;
  }
  return { mime, path: real };
}

import type { Element } from 'hast';
import { defaultUrlTransform } from 'react-markdown';

/**
 * Route an image src that names a file rather than a remote resource through the asset endpoint —
 * document-relative and root-absolute paths alike; a root-absolute one is still confined by
 * `assetRoot` on the server.
 *
 * Mounting the document's directory as a static root would not work: assets legitimately live
 * outside it (`../99_ASSETS/x.png`), and the browser collapses the `..` away when it resolves the
 * src against the page URL, so the path the document meant never reaches the server. Carrying it
 * as a query parameter keeps it intact for `resolveAsset`.
 */
export function assetUrlTransform(url: string, key: string, node: Element): string {
  if (key !== 'src' || node.tagName !== 'img') return defaultUrlTransform(url);
  // An empty src would otherwise be routed as an empty path; `//host/x.png` is protocol-relative
  // and `#x` a fragment. None of the three names a file.
  if (url === '' || url.startsWith('#') || url.startsWith('//')) return defaultUrlTransform(url);
  if (hasProtocol(url)) return defaultUrlTransform(url);
  // What arrives here is already percent-encoded: mdast-util-to-hast normalizes the URL before
  // react-markdown hands it over, so `./画像.png` shows up as `./%E7%94%BB%E5%83%8F.png`. Encoding
  // that again would ask the server for a file whose name literally contains the escapes.
  return `/api/asset?path=${encodeURIComponent(decodeSafely(url))}`;
}

/** The URL comes from document text, so a malformed escape is possible; it is then not an escape. */
function decodeSafely(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/** The colon test react-markdown's own `defaultUrlTransform` uses, so the two agree on what a protocol is. */
function hasProtocol(url: string): boolean {
  const colon = url.indexOf(':');
  if (colon === -1) return false;
  const slash = url.indexOf('/');
  const questionMark = url.indexOf('?');
  const numberSign = url.indexOf('#');
  if (slash !== -1 && colon > slash) return false;
  if (questionMark !== -1 && colon > questionMark) return false;
  if (numberSign !== -1 && colon > numberSign) return false;
  return true;
}

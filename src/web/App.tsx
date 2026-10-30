import {
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  addReply,
  applySuggestion,
  editComment,
  insertComment,
  insertHighlight,
  parse,
  removeComment,
  removeHighlight,
  setResolved,
} from '../rfm/index.js';
import { tokenize } from '../rfm/tokenize.js';
import {
  type Config,
  getConfig,
  getFile,
  getLive,
  putConfig,
  putFile,
  putLive,
  subscribe,
} from './api.js';
import { CommentSidebar } from './CommentSidebar.js';
import { leakedDelimitersIn } from './delimiterLeaks.js';
import { MarkdownView } from './MarkdownView.js';
import { SelectionPopover } from './SelectionPopover.js';
import { hasTextSelection } from './textSelection.js';
import { collectHeadings, pickActive, type TocEntry } from './toc.js';
import { TocSidebar } from './TocSidebar.js';

type ContentWidth = 'full' | '760';
const WIDTHS: { key: ContentWidth; label: string; value: string }[] = [
  { key: 'full', label: 'Full', value: 'none' },
  { key: '760', label: '760px', value: '760px' },
];

// Comment column width (px), drag-resized via the handle on its left border. Persisted in the one
// config every document shares (see server/config.ts), never per document: a viewer opened once
// per file would otherwise keep a separate copy on each port.
const COMMENT_MIN = 240;
const COMMENT_MAX = 640;
const COMMENT_DEFAULT = 320;
function clampCommentWidth(w: number): number {
  return Math.min(COMMENT_MAX, Math.max(COMMENT_MIN, Math.round(w)));
}

// Table-of-contents column width (px), drag-resized via the handle on its right border. Persisted
// like the comment width. Narrower than the comment column could be, since a heading is one short
// line where a note is prose.
const TOC_MIN = 160;
const TOC_MAX = 400;
const TOC_DEFAULT = 240;
function clampTocWidth(w: number): number {
  return Math.min(TOC_MAX, Math.max(TOC_MIN, Math.round(w)));
}

// Which panels start open, read once from the viewport width. The CSS turns the toc and comment
// panels into a column / an overlay / a drawer by breakpoint, but which of them is *open* is a
// flag the CSS keys off — and at a phone width both must start closed, or the reader meets the
// document under two drawers and a scrim. Matching numbers live in theme.css's media queries.
// Read once, not on resize: a matchMedia subscription is the only way to re-derive on a
// breakpoint crossing, and the whole layout is deliberately CSS-driven with no matchMedia.
function initialPanels(): { toc: boolean; comments: boolean } {
  const w = typeof window === 'undefined' ? 1200 : window.innerWidth;
  if (w <= 760) return { toc: false, comments: false };
  if (w <= 1100) return { toc: false, comments: true };
  return { toc: true, comments: true };
}

export function App(): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  // Paired with content, not a ref: a ref advances the instant doRefresh reads a new version,
  // while content only lands on the next commit. A save reading the fresh version but the stale
  // content would send that mismatch as (old body, new baseVersion) — which the server's version
  // check waves through, overwriting a newer on-disk edit. Holding both in state keeps every
  // render's baseVersion describing the body that render will send, so a stale save conflicts
  // (409) and re-applies instead of clobbering.
  const [version, setVersion] = useState('');
  const doc = useMemo(() => (content === null ? null : parse(content)), [content]);
  const spans = useMemo(() => (doc === null ? [] : tokenize(doc.body)), [doc]);
  const articleRef = useRef<HTMLElement | null>(null);
  // The constrained measure is the default: a local review tool is read, and the browser at full
  // width hands a line far past what a paragraph wants. `full` stays one press away.
  const [contentWidth, setContentWidth] = useState<ContentWidth>('760');
  const [commentWidth, setCommentWidth] = useState<number>(COMMENT_DEFAULT);
  const [tocWidth, setTocWidth] = useState<number>(TOC_DEFAULT);
  // seq, not the id alone: clicking the same mark twice must scroll again. `from` records which
  // surface picked the thread — a body mark or the sidebar row for it — because only the former
  // leaves the sidebar needing to reveal the row it belongs to. A click inside the sidebar has
  // that row under the pointer already; scrolling it again would just shuffle the list.
  const [selected, setSelected] = useState<{
    id: string;
    seq: number;
    from: 'body' | 'sidebar';
  } | null>(null);
  const [leaks, setLeaks] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showToc, setShowToc] = useState(() => initialPanels().toc);
  const [showComments, setShowComments] = useState(() => initialPanels().comments);
  const [lineNumbers, setLineNumbers] = useState<boolean>(false);
  // Whether a comment wakes the agent waiting on this document — per document, not a shared
  // preference: it is a switch on this review, and turning it off while reading one draft must
  // not silence another. On by default; the wake-up costs nothing while it waits.
  const [live, setLive] = useState<boolean>(true);
  // The master switch in config.yml (`inkmark live on|off`). Off means arming this document
  // changes nothing, so the toggle is disabled rather than showing a state that cannot happen.
  const [liveEnabled, setLiveEnabled] = useState<boolean>(true);
  const [pathCopied, setPathCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  // The config is fetched once, with the first document. Later file-change events must not re-apply
  // it: that would undo a drag the reader just made with the value saved before it.
  const configLoaded = useRef(false);
  // The j/k tour (below) reads the thread order from the DOM and the current thread from state, so
  // its closure is rebuilt every render. Kept in a ref so the one keydown listener never has to be
  // torn down and re-added to see the latest values.
  const moveRef = useRef<(step: 1 | -1) => void>(() => undefined);

  // A config write is a convenience, never a reason to interrupt the reader: if the server is gone
  // the value stays in state, which is what they are looking at anyway.
  function persistConfig(patch: Config): void {
    void putConfig(patch).catch((err: unknown) => {
      console.error('inkmark: could not save the config', err);
    });
  }

  // Header path: click to copy. Clipboard API first, textarea fallback for
  // non-secure contexts. Feedback is a CSS ::after on data-copied so the
  // button's textContent stays exactly the path (ellipsis + tests rely on it).
  async function copyPath(): Promise<void> {
    if (path === null) return;
    try {
      const withClipboard = navigator as unknown as {
        clipboard?: { writeText(text: string): Promise<void> };
      };
      if (withClipboard.clipboard !== undefined) {
        await withClipboard.clipboard.writeText(path);
      } else {
        const ta = document.createElement('textarea');
        ta.value = path;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- fallback for non-secure contexts without Clipboard API
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setPathCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        setPathCopied(false);
      }, 1500);
    } catch (err) {
      console.error('inkmark: could not copy the file path', err);
    }
  }

  useEffect(() => {
    return (): void => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  // Apply a pure (content) -> content transform, re-applying against fresh
  // content on a 409 (Success Criterion #5: re-apply, not just reload).
  // Reports whether the document was written: an editor that closed on a failed
  // save would take the text the user typed with it.
  async function save(transform: (src: string) => string): Promise<boolean> {
    // The badge says what the file has that the screen does not; this asks before a write
    // makes it permanent. A notice the user may not have looked at is not consent.
    const stakes = [
      ...(doc?.unreadable == null
        ? []
        : [
            `- The trailing note block could not be read (${doc.unreadable}). ` +
              'Its text stays in the body, and a new block is appended after it.',
          ]),
      ...(doc === null || doc.mixedEol === 0
        ? []
        : [
            `- Mixed line endings: saving rewrites ${String(doc.mixedEol)} lines as ` +
              `${doc.eol === '\r\n' ? 'CRLF' : 'LF'}.`,
          ]),
    ];
    if (stakes.length > 0 && !window.confirm(`${stakes.join('\n')}\nContinue?`)) {
      return false;
    }
    try {
      let base = content ?? '';
      let baseVersion = version;
      for (let attempt = 0; attempt < 3; attempt++) {
        const next = transform(base);
        if (next === base) {
          // Every rfm transform declines by returning its input, so an unchanged document
          // means the mark was not what the sidebar took it for. Which reason it was —
          // an agent rewrote it, or it never proposed a change to begin with — is not
          // knowable from here, so the message names the outcome and not a cause the
          // user would go looking for. Writing it back would report a save that did
          // nothing at all.
          console.error('inkmark: the transform declined, document unchanged');
          setContent(base);
          setVersion(baseVersion);
          alert('Nothing in this file changed — this mark cannot be applied.');
          return false;
        }
        const res = await putFile(next, baseVersion);
        if (res.ok) {
          setVersion(res.version);
          setContent(next);
          // A round trip that worked settles the question the badge was asking.
          setLoadError(null);
          return true;
        }
        if (res.status === 409) {
          // Someone (AI) wrote concurrently — refetch and re-apply the transform
          const fresh = await getFile();
          base = fresh.content;
          baseVersion = fresh.version;
          continue;
        }
        alert(`save failed (${String(res.status)})`);
        return false;
      }
      alert('save failed after retries (conflicts)');
      return false;
    } catch (err) {
      // An alert says what went wrong and then it is gone. Everything below decides which
      // sentence the user reads; this keeps the error itself where it can still be read.
      console.error('inkmark: save failed', err);
      // The rfm transforms run here, so this catch sees content errors as well as network ones.
      // Naming only the two it recognised reported the rest as a network failure — something the
      // user would retry forever over a document that will never save. Anything unrecognised now
      // says what it was instead of guessing why.
      if (err instanceof Error && err.message === 'selection moved') {
        alert('The text moved while you were commenting — please re-select and try again.');
      } else if (err instanceof Error && err.message.includes('overlap')) {
        alert('You cannot mark a range that overlaps an existing mark.');
      } else if (err instanceof Error && err.message.includes('line break')) {
        // Ahead of the CriticMarkup test below, which matches on "may not
        // contain" — words this message also says. Behind it, a line break
        // would be reported as a fault in the selection instead of in the text.
        alert('A comment inside the body cannot contain a line break.');
      } else if (err instanceof Error && err.message.includes('may not contain')) {
        alert(`This range cannot be marked (it contains a CriticMarkup delimiter): ${err.message}`);
      } else if (err instanceof Error) {
        alert(`save failed: ${err.message}`);
      } else {
        alert('save failed (network or server error)');
      }
      return false;
    }
  }

  function scrollToSpan(id: string): void {
    const root = articleRef.current;
    if (root === null) return;
    for (const el of root.querySelectorAll<HTMLElement>('mark[data-cm-id]')) {
      if (el.dataset['cmId'] === id) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
  }

  // Clicking a sidebar entry goes to its mark in the body AND paints it as the
  // selection — the same outline a body-mark click gives. Scrolling alone left the
  // destination unmarked: a highlight the sidebar showed could be one of several in
  // view, and after a resolve the only trace in the body is a bare marker. `from` is
  // 'sidebar' so the row the reader just clicked is not scrolled out from under them.
  function selectAndScroll(id: string): void {
    setSelected((prev) => ({ id, seq: (prev?.seq ?? 0) + 1, from: 'sidebar' }));
    scrollToSpan(id);
    // At a phone width the comment panel is a drawer sitting over the body, so the mark
    // just scrolled to is hidden behind it and the jump lands nowhere the reader can see.
    // Close the drawer to reveal the spot. Wider, the panel is a column and the mark
    // scrolls into view beside it, so there is nothing to get out of the way.
    if (window.innerWidth <= 760) setShowComments(false);
  }

  // The j/k tour. Threads come from the rendered marks in body order — the order a reader scrolls
  // in — deduped, because a mark split across blocks (a highlight over several list items) renders
  // one element and repeats one id per block. A thread with no mark in the body has nowhere to
  // scroll and so is not a stop. Rebuilt into moveRef every render because it closes over the
  // current selection; see moveRef.
  useEffect(() => {
    moveRef.current = (step: 1 | -1): void => {
      const root = articleRef.current;
      if (root === null) return;
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const el of root.querySelectorAll<HTMLElement>('mark[data-cm-id]')) {
        const id = el.dataset['cmId'];
        if (id !== undefined && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      if (ids.length === 0) return;
      const current = selected?.id;
      const at = current === undefined ? -1 : ids.indexOf(current);
      // From nothing, j opens at the first thread and k at the last; otherwise both ends wrap, so
      // neither direction is ever a dead press.
      const next =
        at === -1 ? (step === 1 ? 0 : ids.length - 1) : (at + step + ids.length) % ids.length;
      const id = ids[next];
      if (id === undefined) return;
      setSelected((prev) => ({ id, seq: (prev?.seq ?? 0) + 1, from: 'body' }));
      scrollToSpan(id);
    };
  });

  // Paint the selected thread onto its body mark. The sidebar marks selection with an outline; the
  // body showed nothing, so a j/k move with the comment panel closed landed on a mark with no tell
  // that it was the one. Written straight onto the DOM rather than threaded through the rehype
  // plugin, which would re-parse the whole document on every selection for one attribute.
  useEffect(() => {
    const root = articleRef.current;
    if (root === null) return;
    const id = selected?.id ?? null;
    for (const el of root.querySelectorAll<HTMLElement>('mark[data-cm-id]')) {
      if (id !== null && el.dataset['cmId'] === id) el.setAttribute('data-cm-selected', '');
      else el.removeAttribute('data-cm-selected');
    }
  }, [selected, content]);

  function scrollToHeading(id: string): void {
    const root = articleRef.current;
    if (root === null) return;
    for (const el of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
      if (el.id === id) {
        // 'start', not 'center': the reader clicked a heading to read what is under it, and
        // centring it would spend half the screen on what comes before it.
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
  }

  // Both panels toggle at every width now: at a wide width each is a column the CSS folds away
  // when its flag is off. Mutual exclusion is kept only where a panel floats over the body
  // (<=1100) — at a phone width two open drawers would overlap, and a mid-width toc overlay would
  // fight the comment column. As columns they coexist, so closing the other there would take away
  // a panel the user meant to keep. innerWidth is read at the event, the same one-shot approach as
  // initialPanels: the whole layout is deliberately CSS-driven with no matchMedia.
  function toggleToc(): void {
    const next = !showToc;
    setShowToc(next);
    if (next && window.innerWidth <= 1100) setShowComments(false);
    persistConfig({ showToc: next });
  }
  function toggleComments(): void {
    const next = !showComments;
    setShowComments(next);
    if (next && window.innerWidth <= 1100) setShowToc(false);
  }
  function toggleLineNumbers(): void {
    const next = !lineNumbers;
    setLineNumbers(next);
    persistConfig({ lineNumbers: next });
  }
  function toggleLive(): void {
    const next = !live;
    setLive(next);
    void putLive(next)
      .then((state) => {
        setLive(state.armed);
        setLiveEnabled(state.enabled);
      })
      .catch((err: unknown) => {
        console.error('inkmark: could not save the live switch', err);
      });
  }
  function closePanels(): void {
    setShowToc(false);
    setShowComments(false);
  }

  // One keydown listener for the whole app. Escape dismisses an open drawer/overlay — but only at
  // the widths where a panel actually floats (<= 1100px). Wider, both panels are permanent columns;
  // closing showToc there would make the outline column vanish with no way back but the Contents
  // toggle.
  // innerWidth is read at the event, the same one-shot approach as initialPanels, so this needs no
  // matchMedia. j/k walk the threads (moveRef, above).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        if (window.innerWidth <= 1100) closePanels();
        return;
      }
      // j/k only. A modifier belongs to the browser (Ctrl+K, ⌘J), Shift is typing, and a composing
      // key is the IME's to consume.
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
      // Never steal the key from a field being typed in. closest() rather than a tag check, so a
      // press on a control nested inside the box is caught too.
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select') !== null)
      ) {
        return;
      }
      if (e.key === 'j') moveRef.current(1);
      else if (e.key === 'k') moveRef.current(-1);
    }
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Ids are body offsets, so writing a mark shifts every heading below it. The active heading is
  // dropped rather than left naming an id that now belongs to a different heading.
  useEffect(() => {
    const root = articleRef.current;
    setToc(root === null ? [] : collectHeadings(root));
    setActiveId(null);
  }, [content]);

  // Scroll-spy. The scroll container is the <article> itself, not the window, so it is the
  // observer's root; the -70% bottom margin narrows the trigger zone to the top of it, which is
  // where a reader looks for the heading they are under.
  useEffect(() => {
    const root = articleRef.current;
    if (root === null || toc.length === 0) return;
    // Only the first callback carries every heading; later ones carry just those whose
    // intersection changed, so the set has to remember the ones absent from a batch.
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          const { id } = record.target as HTMLElement;
          if (record.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        setActiveId((previous) => pickActive(toc, visible, previous));
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    // Observing only what the outline lists, so an id it cannot show is never even reported.
    for (const entry of toc) {
      const el = root.querySelector<HTMLElement>(`#${CSS.escape(entry.id)}`);
      if (el !== null) observer.observe(el);
    }
    return (): void => {
      observer.disconnect();
    };
  }, [toc]);

  // One delegated listener on the root rather than an onClick threaded down
  // through MarkdownView: the marks come out of a rehype plugin, so the
  // <article> is the only element of theirs that is ours to hold. The marks are
  // deliberately not tab stops — a document of them would be a maze to tab
  // through, and the sidebar buttons already reach every thread. Re-runs on
  // content because the <article> exists only once a document has loaded.
  useEffect(() => {
    const root = articleRef.current;
    if (root === null) return;
    function onClick(e: MouseEvent): void {
      if (hasTextSelection()) return;
      const id = (e.target as HTMLElement).closest<HTMLElement>('mark[data-cm-id]')?.dataset[
        'cmId'
      ];
      if (id === undefined) return;
      setSelected((prev) => ({ id, seq: (prev?.seq ?? 0) + 1, from: 'body' }));
    }
    root.addEventListener('click', onClick);
    return (): void => {
      root.removeEventListener('click', onClick);
    };
  }, [content]);

  useEffect(() => {
    async function doRefresh(): Promise<void> {
      try {
        // Fetched alongside the first document, then applied before `setContent` lands: the layout
        // is only rendered once a document exists, so the reader never sees the defaults flash by.
        // A config that fails to load is not worth an error state — the defaults are a fine view.
        const [r, config, liveState] = await Promise.all([
          getFile(),
          configLoaded.current ? Promise.resolve(null) : getConfig().catch(() => null),
          configLoaded.current ? Promise.resolve(null) : getLive().catch(() => null),
        ]);
        if (liveState !== null) {
          setLive(liveState.armed);
          setLiveEnabled(liveState.enabled);
        }
        if (config !== null) {
          configLoaded.current = true;
          if (typeof config.commentWidth === 'number' && Number.isFinite(config.commentWidth)) {
            setCommentWidth(clampCommentWidth(config.commentWidth));
          }
          if (typeof config.tocWidth === 'number' && Number.isFinite(config.tocWidth)) {
            setTocWidth(clampTocWidth(config.tocWidth));
          }
          if (typeof config.lineNumbers === 'boolean') setLineNumbers(config.lineNumbers);
          if (config.contentWidth === 'full' || config.contentWidth === '760') {
            setContentWidth(config.contentWidth);
          }
          // Below 1101 the outline is an overlay or a drawer, and the width rule decides: opening
          // it on load would drop it over the document (and, at a mid width, next to a comment
          // column the toggles would never have allowed beside it).
          if (typeof config.showToc === 'boolean') {
            setShowToc(config.showToc && window.innerWidth > 1100);
          }
        }
        setContent(r.content);
        setPath(r.path);
        setVersion(r.version);
        setLoadError(null);
      } catch (err: unknown) {
        // Both a state and a log line: the state is what the user can act on, the log is
        // what survives them dismissing it. Neither alone is enough to diagnose a server
        // that went away mid-session.
        console.error('inkmark: could not load the document', err);
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    }
    void doRefresh();
    return subscribe(() => void doRefresh());
  }, []);

  // A mark the plugin could not build leaves its delimiters in the body. Read from the
  // committed DOM rather than from a callback the rehype plugin fires mid-render: an
  // effect over what the reader is actually looking at has no ordering hazard, and it
  // sees leaks the plugin never did — MarkdownView runs a second pass after it.
  useEffect(() => {
    const root = articleRef.current;
    // Cleared rather than left standing: a scan that could not run must not leave the
    // previous document's count sitting over this one.
    setLeaks(root === null ? [] : leakedDelimitersIn(root));
  }, [content]);

  useEffect(() => {
    if (path === null) return;
    const base = path.slice(path.lastIndexOf('/') + 1);
    document.title = `${base} — inkmark`;
  }, [path]);

  if (content === null || doc === null) {
    // Only before anything has loaded. A later refresh that fails must not take a document
    // the reader is looking at off the screen — that failure goes to the badge below.
    return loadError === null ? (
      <div>Loading…</div>
    ) : (
      <div role="alert">Could not load the document: {loadError}</div>
    );
  }
  // Drag the body/comment border. Width is the distance from the viewport's right edge to the
  // pointer, so dragging left widens the comment column. Listeners live on window (not the handle)
  // so the drag survives the pointer leaving the 8px hit area. Persisted once, on release.
  function startCommentResize(e: ReactPointerEvent): void {
    e.preventDefault();
    let latest = commentWidth;
    function onMove(ev: PointerEvent): void {
      latest = clampCommentWidth(window.innerWidth - ev.clientX);
      setCommentWidth(latest);
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      persistConfig({ commentWidth: latest });
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  function nudgeCommentWidth(delta: number): void {
    const next = clampCommentWidth(commentWidth + delta);
    setCommentWidth(next);
    persistConfig({ commentWidth: next });
  }
  // Drag the toc/body border. The toc sits on the left, so its width is the pointer's distance from
  // the viewport's left edge — the mirror of the comment handle, which measures from the right.
  // Listeners live on window so the drag survives the pointer leaving the 8px hit area.
  function startTocResize(e: ReactPointerEvent): void {
    e.preventDefault();
    let latest = tocWidth;
    function onMove(ev: PointerEvent): void {
      latest = clampTocWidth(ev.clientX);
      setTocWidth(latest);
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      persistConfig({ tocWidth: latest });
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  function nudgeTocWidth(delta: number): void {
    const next = clampTocWidth(tocWidth + delta);
    setTocWidth(next);
    persistConfig({ tocWidth: next });
  }
  const widthValue = WIDTHS.find((w) => w.key === contentWidth)?.value ?? 'none';
  // Every way the document on screen can be less than the file, gathered into one line.
  const notices = [
    ...(leaks.length > 0
      ? [
          `CriticMarkup left as text in ${String(leaks.length)} place${leaks.length === 1 ? '' : 's'}`,
        ]
      : []),
    ...(doc.unreadable === null ? [] : ['Could not read the trailing note block']),
    ...(doc.mixedEol === 0
      ? []
      : [`Mixed line endings on ${String(doc.mixedEol)} line${doc.mixedEol === 1 ? '' : 's'}`]),
    ...(loadError === null ? [] : ['Reload failed']),
  ];
  const noticeDetail = [
    ...leaks,
    ...(doc.unreadable === null ? [] : [doc.unreadable]),
    ...(doc.mixedEol === 0
      ? []
      : [`Saving normalises them to ${doc.eol === '\r\n' ? 'CRLF' : 'LF'}`]),
    ...(loadError === null ? [] : [loadError]),
  ];
  // A document with no headings has no table of contents to hide or show, and a toggle for an
  // empty panel is a control that does nothing twice.
  const tocOpen = showToc && toc.length > 0;
  const layoutClass = [
    'layout',
    tocOpen ? 'toc-open' : '',
    showComments ? 'comments-open' : '',
    lineNumbers ? 'line-numbers' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={layoutClass}
      style={
        {
          '--content-width': widthValue,
          '--comment-width': `${String(commentWidth)}px`,
          '--toc-width': `${String(tocWidth)}px`,
        } as CSSProperties
      }
    >
      <header className="app-header">
        {/* Leads the header: the panel it controls is the leftmost column, and at narrow widths the
            drawer slides in from the left too. Trailing the header put the toggle at the far right,
            across the body from the column it toggles. */}
        {toc.length > 0 && (
          <button
            className={showToc ? 'filter-tab active' : 'filter-tab'}
            aria-pressed={showToc}
            aria-expanded={showToc}
            aria-controls="toc-sidebar"
            onClick={toggleToc}
          >
            Contents
          </button>
        )}
        <button
          type="button"
          className="app-path app-path--copy"
          title={path ?? ''}
          aria-label={path === null ? 'Copy file path' : `Copy file path: ${path}`}
          data-copied={pathCopied ? 'true' : 'false'}
          onClick={() => void copyPath()}
        >
          <span className="app-path__text">{path ?? ''}</span>
        </button>
        {/* One live region for all three notices: two status regions in the same header
            compete for the screen reader. Mounted even when empty, because a live region inserted
            together with its text is not reliably announced, and :empty in the stylesheet
            keeps it out of the way. The text is its own span so a phone width can drop the
            sentence and keep the ⚠ — the count is what the reader needs at a glance. `status`
            takes its name from the author rather than its contents, so the summary is named
            explicitly; without it the long `title` becomes what a screen reader reads out. */}
        <span
          className="leak-badge"
          role="status"
          aria-label={notices.join(' / ')}
          title={noticeDetail.join('\n')}
        >
          {notices.length > 0 ? (
            <>
              ⚠ <span className="leak-badge__text">{notices.join(' / ')}</span>
            </>
          ) : null}
        </span>
        {/* Shown at every width: at a wide width the comment panel is a column the CSS folds
            away when the flag is off, and at a narrow one it is a drawer this opens. */}
        <button
          className={
            showComments ? 'filter-tab comment-toggle active' : 'filter-tab comment-toggle'
          }
          aria-pressed={showComments}
          aria-expanded={showComments}
          aria-controls="comment-sidebar"
          onClick={toggleComments}
        >
          Comments
        </button>
        {/* Right of the path: the review loop first (Comments controls the column, Live arms the
            watcher that answers it), then the reading settings (Line numbers, width). Grouping by
            purpose keeps the two tinted controls together instead of alternating them with the
            neutral ones. */}
        <button
          type="button"
          className={live ? 'live-toggle live-toggle--on' : 'live-toggle'}
          aria-pressed={live}
          disabled={!liveEnabled}
          title={
            liveEnabled
              ? 'A comment on this document wakes the agent (the Stop hook holds a wait)'
              : 'The master switch is off. Turn it back on with `inkmark live on`.'
          }
          onClick={toggleLive}
        >
          <span className="live-toggle__dot" aria-hidden="true">
            ●
          </span>
          Live
        </button>
        <button
          className={lineNumbers ? 'filter-tab active' : 'filter-tab'}
          aria-pressed={lineNumbers}
          title="Line numbers"
          onClick={toggleLineNumbers}
        >
          Lines
        </button>
        <div className="width-control" role="group" aria-label="Content width">
          {WIDTHS.map((w) => (
            <button
              key={w.key}
              className={w.key === contentWidth ? 'filter-tab active' : 'filter-tab'}
              aria-pressed={w.key === contentWidth}
              onClick={() => {
                setContentWidth(w.key);
                persistConfig({ contentWidth: w.key });
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
      </header>
      {/* Before <MarkdownView> so grid auto-placement puts it in the first column — and so a
          screen reader meets the document's outline before the document. Rendered whenever the
          document has headings, not only when open: the CSS hides a closed one with display:none
          (which also takes it out of the tab order), so it can open without a remount. */}
      {toc.length > 0 && (
        <TocSidebar entries={toc} activeId={activeId} onSelect={scrollToHeading} />
      )}
      {toc.length > 0 && (
        <>
          {/* Resize the outline column by dragging (or arrow keys) its border with the body,
              mirroring the comment resizer. Rendered only when there are headings; CSS hides it
              where the toc is an overlay/drawer and so has no column to drag. A focusable separator
              with aria-valuenow is the ARIA "window splitter" pattern (APG); the role IS
              interactive here, so the two no-noninteractive lint rules are false positives. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div
            className="toc-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Outline width"
            aria-valuenow={tocWidth}
            aria-valuemin={TOC_MIN}
            aria-valuemax={TOC_MAX}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            onPointerDown={startTocResize}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') nudgeTocWidth(-16);
              else if (e.key === 'ArrowRight') nudgeTocWidth(16);
            }}
          />
        </>
      )}
      <MarkdownView source={doc.body} spans={spans} articleRef={articleRef} />
      <SelectionPopover
        body={doc.body}
        rootRef={articleRef}
        // Returned, not voided: a save the server refuses keeps the editor open with the text,
        // the same contract the sidebar's editors keep.
        onComment={(range, body, selectedText) =>
          save(
            (src) =>
              insertComment(src, range, body, 'user', new Date().toISOString(), selectedText).md,
          )
        }
        onHighlight={(range, selectedText) =>
          void save(
            (src) => insertHighlight(src, range, 'user', new Date().toISOString(), selectedText).md,
          )
        }
      />
      {/* Drag (or arrow-key) the border between body and comments to resize the column. role=
          separator with the value range makes it a first-class resizer for the keyboard and screen
          reader; CSS hides it at the narrow width where the panel is a drawer. */}
      {/* A focusable separator with aria-valuenow is the ARIA "window splitter" pattern (APG); the
          role IS interactive here, so the two no-noninteractive lint rules are false positives. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        className="comment-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Comments width"
        aria-valuenow={commentWidth}
        aria-valuemin={COMMENT_MIN}
        aria-valuemax={COMMENT_MAX}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        onPointerDown={startCommentResize}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') nudgeCommentWidth(16);
          else if (e.key === 'ArrowRight') nudgeCommentWidth(-16);
        }}
      />
      <CommentSidebar
        source={content}
        selectedId={selected?.id ?? null}
        selectSeq={selected?.seq ?? 0}
        revealSelected={selected?.from === 'body'}
        onEdit={(id, body) => save((src) => editComment(src, id, body))}
        onReply={(pid, body) =>
          save((src) => addReply(src, pid, body, 'user', new Date().toISOString()).md)
        }
        onResolve={(id) => void save((src) => setResolved(src, id, true))}
        onSelect={selectAndScroll}
        onSuggestion={(id, action) => void save((src) => applySuggestion(src, id, action))}
        onRemove={(id) => void save((src) => removeHighlight(src, id))}
        onRemoveComment={(id) => void save((src) => removeComment(src, id))}
      />
      {/* The scrim dims and closes an open drawer. A <button>, not a <div>, so it is keyboard-
          and screen-reader-reachable without hand-rolling the roles a static element would need;
          shown by CSS only at the widths where a panel is a drawer. */}
      <button type="button" className="scrim" aria-label="Close panel" onClick={closePanels} />
    </div>
  );
}

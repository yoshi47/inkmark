import { type CSSProperties, type JSX, useEffect, useMemo, useRef, useState } from 'react';
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
import { getFile, putFile, subscribe } from './api.js';
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
  const [contentWidth, setContentWidth] = useState<ContentWidth>('full');
  // seq, not the id alone: clicking the same mark twice must scroll again.
  const [selected, setSelected] = useState<{ id: string; seq: number } | null>(null);
  const [leaks, setLeaks] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showToc, setShowToc] = useState(() => initialPanels().toc);
  const [showComments, setShowComments] = useState(() => initialPanels().comments);

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
            `・末尾の注記ブロックを読めていません（${doc.unreadable}）。` +
              '読めないブロックは本文として残り、新しいブロックがその後ろに追記されます。',
          ]),
      ...(doc === null || doc.mixedEol === 0
        ? []
        : [
            `・改行コードが混在しています。保存すると ${String(doc.mixedEol)} 行が ` +
              `${doc.eol === '\r\n' ? 'CRLF' : 'LF'} に書き換わります。`,
          ]),
    ];
    if (stakes.length > 0 && !window.confirm(`${stakes.join('\n')}\n続けますか?`)) {
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
          alert('その操作はファイルを変更しませんでした（このマークには適用できません）。');
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
        alert('既存のマークと重なる範囲にはマークを付けられません。');
      } else if (err instanceof Error && err.message.includes('line break')) {
        // Ahead of the CriticMarkup test below, which matches on "may not
        // contain" — words this message also says. Behind it, a line break
        // would be reported as a fault in the selection instead of in the text.
        alert('本文中のコメントは改行を含められません。');
      } else if (err instanceof Error && err.message.includes('may not contain')) {
        alert(
          `この範囲にはマークを付けられません（CriticMarkup の終端記号を含んでいます）: ${err.message}`,
        );
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

  // The toc and comment panels are mutually exclusive: opening one closes the other. At a phone
  // width their two drawers would otherwise overlap; at wider widths the panel the CSS pins as a
  // column stays visible regardless of its flag, so closing it here is invisible and harmless.
  function toggleToc(): void {
    setShowToc((v) => !v);
    setShowComments(false);
  }
  function toggleComments(): void {
    setShowComments((v) => !v);
    setShowToc(false);
  }
  function closePanels(): void {
    setShowToc(false);
    setShowComments(false);
  }

  // Escape dismisses an open drawer/overlay — but only at the widths where a panel actually floats
  // (<= 1100px). Wider, both panels are permanent columns; closing showToc there would make the
  // outline column vanish with no way back but the 目次 toggle. innerWidth is read at the event,
  // the same one-shot approach as initialPanels, so this needs no matchMedia.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && window.innerWidth <= 1100) closePanels();
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
      setSelected((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
    }
    root.addEventListener('click', onClick);
    return (): void => {
      root.removeEventListener('click', onClick);
    };
  }, [content]);

  useEffect(() => {
    async function doRefresh(): Promise<void> {
      try {
        const r = await getFile();
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
      <div role="alert">ドキュメントを読み込めませんでした: {loadError}</div>
    );
  }
  const widthValue = WIDTHS.find((w) => w.key === contentWidth)?.value ?? 'none';
  // Every way the document on screen can be less than the file, gathered into one line.
  const notices = [
    ...(leaks.length > 0 ? [`記法が ${String(leaks.length)} 箇所そのまま残っています`] : []),
    ...(doc.unreadable === null ? [] : ['末尾の注記ブロックを読めませんでした']),
    ...(doc.mixedEol === 0 ? [] : [`改行コードが ${String(doc.mixedEol)} 行分混在しています`]),
    ...(loadError === null ? [] : ['再読み込みに失敗しました']),
  ];
  const noticeDetail = [
    ...leaks,
    ...(doc.unreadable === null ? [] : [doc.unreadable]),
    ...(doc.mixedEol === 0
      ? []
      : [`保存すると ${doc.eol === '\r\n' ? 'CRLF' : 'LF'} に揃えられます`]),
    ...(loadError === null ? [] : [loadError]),
  ];
  // A document with no headings has no table of contents to hide or show, and a toggle for an
  // empty panel is a control that does nothing twice.
  const tocOpen = showToc && toc.length > 0;
  const layoutClass = ['layout', tocOpen ? 'toc-open' : '', showComments ? 'comments-open' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={layoutClass} style={{ '--content-width': widthValue } as CSSProperties}>
      <header className="app-header">
        <span className="app-path" title={path ?? ''}>
          {path ?? ''}
        </span>
        {/* One live region for all three notices: two status regions in the same header
            compete for the screen reader. Mounted even when empty, because a live region inserted
            together with its text is not reliably announced, and :empty in the stylesheet
            keeps it out of the way.
            箇所, not 件 — one mark that failed to build leaves two delimiters, so the
            count is of what the reader can see, not of threads lost. */}
        <span className="leak-badge" role="status" title={noticeDetail.join('\n')}>
          {notices.length > 0 ? `⚠ ${notices.join(' / ')}` : ''}
        </span>
        {toc.length > 0 && (
          <button
            className={showToc ? 'filter-tab active' : 'filter-tab'}
            aria-pressed={showToc}
            aria-expanded={showToc}
            aria-controls="toc-sidebar"
            onClick={toggleToc}
          >
            目次
          </button>
        )}
        {/* Only reachable at a narrow width (hidden by CSS otherwise): there the comment panel is a
            drawer, so it needs a control to open it. Wider, it is always a visible column. */}
        <button
          className={
            showComments ? 'filter-tab comment-toggle active' : 'filter-tab comment-toggle'
          }
          aria-pressed={showComments}
          aria-expanded={showComments}
          aria-controls="comment-sidebar"
          onClick={toggleComments}
        >
          コメント
        </button>
        <div className="width-control" role="group" aria-label="本文の幅">
          {WIDTHS.map((w) => (
            <button
              key={w.key}
              className={w.key === contentWidth ? 'filter-tab active' : 'filter-tab'}
              aria-pressed={w.key === contentWidth}
              onClick={() => {
                setContentWidth(w.key);
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
      <MarkdownView source={doc.body} spans={spans} articleRef={articleRef} />
      <SelectionPopover
        body={doc.body}
        rootRef={articleRef}
        onComment={(range, body, selectedText) =>
          void save(
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
      <CommentSidebar
        source={content}
        selectedId={selected?.id ?? null}
        selectSeq={selected?.seq ?? 0}
        onEdit={(id, body) => save((src) => editComment(src, id, body))}
        onReply={(pid, body) =>
          save((src) => addReply(src, pid, body, 'user', new Date().toISOString()).md)
        }
        onResolve={(id) => void save((src) => setResolved(src, id, true))}
        onSelect={scrollToSpan}
        onSuggestion={(id, action) => void save((src) => applySuggestion(src, id, action))}
        onRemove={(id) => void save((src) => removeHighlight(src, id))}
        onRemoveComment={(id) => void save((src) => removeComment(src, id))}
      />
      {/* The scrim dims and closes an open drawer. A <button>, not a <div>, so it is keyboard-
          and screen-reader-reachable without hand-rolling the roles a static element would need;
          shown by CSS only at the widths where a panel is a drawer. */}
      <button type="button" className="scrim" aria-label="パネルを閉じる" onClick={closePanels} />
    </div>
  );
}

import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  type CommentMeta,
  noteFor,
  noteFreeHighlight,
  parse,
  type Span,
  threadIds,
} from '../rfm/index.js';
import { hasTextSelection } from './textSelection.js';

type Filter = 'all' | 'highlights' | 'comments' | 'suggestions';

function removalPrompt(subject: string, replyCount: number): string {
  if (replyCount === 0) return `Delete this ${subject}?`;
  const replies = replyCount === 1 ? '1 reply' : `${String(replyCount)} replies`;
  return `Delete this ${subject} and its ${replies}?`;
}

interface SidebarProps {
  source: string;
  selectedId: string | null;
  /** Bumped per click, so clicking the same mark twice scrolls twice. */
  selectSeq: number;
  onReply: (parentId: string, body: string) => void;
  onResolve: (id: string) => void;
  onRemove: (id: string) => void;
  onRemoveComment: (id: string) => void;
  onSelect: (id: string) => void;
  onSuggestion: (id: string, action: 'accept' | 'reject') => void;
}

export function CommentSidebar({
  source,
  selectedId,
  selectSeq,
  onReply,
  onResolve,
  onRemove,
  onRemoveComment,
  onSelect,
  onSuggestion,
}: SidebarProps): JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');
  const asideRef = useRef<HTMLElement | null>(null);
  const doc = parse(source);
  const comments = doc.endmatter.comments;

  function noteText(id: string): string {
    return noteFor(doc, id) ?? '';
  }

  function highlightText(id: string): string | null {
    return noteFreeHighlight(doc, id)?.inner ?? null;
  }

  // Root threads: endmatter entries with no re (reply-to) field, plus marks an
  // agent wrote inline without an endmatter entry — the same fallback the
  // suggestion list makes below, so a hand-written mark is still listed here.
  // Those carry no metadata, hence no Resolve. Notes belong in that fallback as
  // much as highlights do: the body renders one as a bare 💬, so leaving it
  // unlisted would put its text nowhere in the app at all.
  const roots: { id: string; meta: CommentMeta | null }[] = [
    ...Object.entries(comments)
      .filter(([, c]) => c.re === undefined)
      .map(([id, meta]) => ({ id, meta })),
    ...doc.spans.flatMap((s) =>
      (s.kind === 'highlight' || s.kind === 'comment') &&
      s.id !== undefined &&
      comments[s.id] === undefined
        ? [{ id: s.id, meta: null }]
        : [],
    ),
  ];

  // Collect suggestion IDs from both endmatter and inline spans
  const spanSuggestionIds = doc.spans
    .map((s) => s.id)
    .filter((id): id is string => id?.startsWith('s') === true);
  const suggestionIds = Array.from(
    new Set([...Object.keys(doc.endmatter.suggestions), ...spanSuggestionIds]),
  );

  // A note-free highlight is what separates the two kinds of root, so the same
  // call that picks the 🖍 label below also decides which tab an entry belongs to.
  const highlightRoots = roots.filter(({ id }) => highlightText(id) !== null);
  const commentRoots = roots.filter(({ id }) => highlightText(id) === null);

  const shownRoots =
    filter === 'all'
      ? roots
      : filter === 'highlights'
        ? highlightRoots
        : filter === 'comments'
          ? commentRoots
          : [];
  const shownSuggestionIds = filter === 'all' || filter === 'suggestions' ? suggestionIds : [];

  const selectedIsListed =
    selectedId !== null &&
    (roots.some((r) => r.id === selectedId) || suggestionIds.includes(selectedId));

  // Once per click, tracked by seq: the effect also runs on a filter change, and
  // without that guard it would answer the user's own tab click by snapping the
  // filter back to whatever the last selection needed.
  const handled = useRef(0);
  useEffect(() => {
    const aside = asideRef.current;
    if (selectedId === null || aside === null || handled.current === selectSeq) return;
    for (const el of aside.querySelectorAll<HTMLElement>('[data-thread-id]')) {
      if (el.dataset['threadId'] === selectedId) {
        handled.current = selectSeq;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    // Not on screen. Widen only for an entry the sidebar really has — a mark
    // whose id no row answers to (a reply's, say) would otherwise throw the
    // user's tab away and still show them nothing.
    if (selectedIsListed) setFilter('all');
    else handled.current = selectSeq;
  }, [selectedId, selectSeq, filter, selectedIsListed]);

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: roots.length + suggestionIds.length },
    { key: 'highlights', label: 'Highlights', count: highlightRoots.length },
    { key: 'comments', label: 'Comments', count: commentRoots.length },
    { key: 'suggestions', label: 'Suggestions', count: suggestionIds.length },
  ];

  return (
    <aside className="comment-sidebar" ref={asideRef}>
      <div className="sidebar-filter" role="group" aria-label="Filter sidebar entries">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={tab.key === filter ? 'filter-tab active' : 'filter-tab'}
            aria-pressed={tab.key === filter}
            onClick={() => {
              setFilter(tab.key);
            }}
          >
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>
      {/* Only while filtered: an unmarked document has always shown an empty
          sidebar, and saying "nothing" there would read as something broken. */}
      {filter !== 'all' && shownRoots.length === 0 && shownSuggestionIds.length === 0 && (
        <p className="sidebar-empty">Nothing to show.</p>
      )}
      {shownRoots.map(({ id, meta }) => {
        const replies = Object.entries(comments).filter(([, r]) => r.re === id);
        const highlighted = highlightText(id);
        const classes = ['thread'];
        if (highlighted !== null) classes.push('highlight');
        if (meta?.resolved === true) classes.push('resolved');
        if (id === selectedId) classes.push('selected');
        return (
          <div key={id} className={classes.join(' ')} data-thread-id={id}>
            <ScrollLabel
              className="comment"
              onSelect={() => {
                onSelect(id);
              }}
            >
              {highlighted !== null ? (
                <>🖍 {highlighted}</>
              ) : meta === null ? (
                // A note an agent wrote inline names no author, and a bare
                // ": text" reads as one whose name went missing.
                noteText(id)
              ) : (
                <>
                  <b>{meta.by}</b>: {noteText(id)}
                </>
              )}
            </ScrollLabel>
            {replies.map(([rid, r]) => (
              <div className="reply" key={rid}>
                <b>{r.by}</b>: {r.body}
              </div>
            ))}
            <ReplyBox
              onSend={(body) => {
                onReply(id, body);
              }}
            />
            {meta !== null && meta.resolved !== true && (
              <button
                onClick={() => {
                  onResolve(id);
                }}
              >
                Resolve
              </button>
            )}
            {/* Removing a bare highlight costs nothing but its markup, so it
                goes unasked. Prose — a note, a reply — is gone for good, and
                the thread reaches deeper than the replies rendered above. */}
            <button
              onClick={() => {
                const doomed = threadIds(doc, id).size - 1;
                if (highlighted !== null && doomed === 0) {
                  onRemove(id);
                  return;
                }
                const subject = highlighted !== null ? 'highlight' : 'comment';
                if (!window.confirm(removalPrompt(subject, doomed))) return;
                if (highlighted !== null) {
                  onRemove(id);
                } else {
                  onRemoveComment(id);
                }
              }}
            >
              Remove
            </button>
          </div>
        );
      })}
      {shownSuggestionIds.map((id) => {
        const span: Span | undefined = doc.spans.find((s) => s.id === id);
        let label: string;
        if (span === undefined) {
          label = id;
        } else if (span.kind === 'substitution') {
          label = `${span.oldText ?? ''} → ${span.newText ?? ''}`;
        } else if (span.kind === 'insertion') {
          label = `+ ${span.inner}`;
        } else if (span.kind === 'deletion') {
          label = `- ${span.inner}`;
        } else {
          label = id;
        }
        return (
          <div
            className={id === selectedId ? 'suggestion selected' : 'suggestion'}
            key={id}
            data-thread-id={id}
          >
            <ScrollLabel
              className="suggestion-label"
              onSelect={() => {
                onSelect(id);
              }}
            >
              {label}
            </ScrollLabel>
            <button
              onClick={() => {
                onSuggestion(id, 'accept');
              }}
            >
              Accept
            </button>
            <button
              onClick={() => {
                onSuggestion(id, 'reject');
              }}
            >
              Reject
            </button>
          </div>
        );
      })}
    </aside>
  );
}

// A div wearing the button role rather than a <button>: UA stylesheets make text
// inside a form control unselectable, and the comment's own words are the thing
// a reviewer most wants to copy. Firefox refuses to start a drag-selection in a
// <button> even with user-select: text, so styling the button was no way out.
function ScrollLabel({
  className,
  onSelect,
  children,
}: {
  className: string;
  onSelect: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      onClick={() => {
        if (hasTextSelection()) return;
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        // Space scrolls the page, and a held key would fire on every repeat.
        e.preventDefault();
        if (e.repeat) return;
        onSelect();
      }}
    >
      {children}
    </div>
  );
}

function ReplyBox({ onSend }: { onSend: (body: string) => void }): JSX.Element {
  const [text, setText] = useState('');
  return (
    <div className="reply-box">
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        placeholder="Reply…"
      />
      <button
        onClick={() => {
          if (text.trim().length > 0) {
            onSend(text.trim());
          }
          setText('');
        }}
      >
        Send
      </button>
    </div>
  );
}

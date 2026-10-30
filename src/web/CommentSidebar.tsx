import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  type CommentMeta,
  isSuggestion,
  noteFor,
  noteFreeHighlight,
  noteSpan,
  parse,
  type Span,
  threadIds,
} from '../rfm/index.js';
import { CommentEditor } from './CommentEditor.js';
import { hasTextSelection } from './textSelection.js';

type Filter = 'all' | 'highlights' | 'comments' | 'suggestions';

function removalPrompt(subject: string, replyCount: number): string {
  if (replyCount === 0) return `Delete this ${subject}?`;
  const replies = replyCount === 1 ? '1 reply' : `${String(replyCount)} replies`;
  return `Delete this ${subject} and its ${replies}?`;
}

/**
 * Every reply hanging off a root, however deep, in file order. `re:` may name another
 * reply (REFERENCE.md), so picking only the entries that name the root would leave a
 * grandchild's text nowhere on screen while `threadIds` still counts it in the delete
 * prompt. A parent always precedes its children: one written above its parent waits for
 * the next pass.
 */
function repliesUnder(
  comments: Record<string, CommentMeta>,
  rootId: string,
): [string, CommentMeta][] {
  const seen = new Set([rootId]);
  const replies: [string, CommentMeta][] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, meta] of Object.entries(comments)) {
      if (meta.re !== undefined && seen.has(meta.re) && !seen.has(id)) {
        seen.add(id);
        replies.push([id, meta]);
        grew = true;
      }
    }
  }
  return replies;
}

interface SidebarProps {
  source: string;
  selectedId: string | null;
  /** Bumped per click and never reset — the sidebar dates tab presses against it. */
  selectSeq: number;
  /**
   * Whether the selection was picked somewhere else (a body mark, the j/k tour) and so must be
   * scrolled into view here. False when the selection came from a row in this list: that row is
   * already under the reader's pointer, and centring it would shuffle the list under the click.
   */
  revealSelected: boolean;
  /** Resolves to whether the document was written; a refused save keeps the editor open. */
  onEdit: (id: string, body: string) => Promise<boolean>;
  onReply: (parentId: string, body: string) => Promise<boolean>;
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
  revealSelected,
  onEdit,
  onReply,
  onResolve,
  onRemove,
  onRemoveComment,
  onSelect,
  onSuggestion,
}: SidebarProps): JSX.Element {
  // Not a plain Filter: the press carries the selectSeq it was made at, so only
  // a mark click newer than the press may widen the filter. Unstamped, the
  // selection standing from before the press would keep pulling it back to All.
  const [chosen, setChosen] = useState<{ key: Filter; atSeq: number }>({ atSeq: 0, key: 'all' });
  // One at a time: an open editor holds unsaved text, and the sidebar has no
  // room to show several of them at once anyway.
  const [editingId, setEditingId] = useState<string | null>(null);
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

  // Collect suggestion IDs from both endmatter and inline spans, then put both sources
  // through the predicate the transform itself uses. `applySuggestion` declines a mark
  // that proposes no change, so an `sN` an agent wrote on a highlight — or a comment id
  // an agent listed under `suggestions:` — would otherwise draw Accept/Reject buttons
  // whose only possible outcome is a dialog saying nothing happened. An id with no span
  // at all is kept: its mark may sit inside a fence, where the tokenizer cannot see it,
  // and dropping the row would put the entry out of reach instead of merely unpressable.
  const spanById = new Map(
    doc.spans.flatMap((s) => (s.id === undefined ? [] : [[s.id, s] as const])),
  );
  const markedIds = new Set(spanById.keys());

  // Ids a reply names — "（s2, s3）を入れました" — kept only where the body carries that mark, so
  // every chip the sidebar offers has somewhere to scroll. An id with no mark (a suggestion inside
  // a fence, a reply's own id, one the agent has since dropped) stays prose instead of becoming a
  // control that does nothing. Boundaries exclude a path or a URL: "s3.amazonaws.com" is not a
  // suggestion, though a sentence-ending "s3." still is.
  function referenceIds(text: string): string[] {
    const found: string[] = [];
    for (const m of text.matchAll(
      /(?<![A-Za-z0-9_./-])([cs]\d+)(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])/g,
    )) {
      const id = m[1];
      if (id !== undefined && markedIds.has(id) && !found.includes(id)) found.push(id);
    }
    return found;
  }
  const spanSuggestionIds = doc.spans
    .map((s) => s.id)
    .filter((id): id is string => id?.startsWith('s') === true);
  const suggestionIds = Array.from(
    new Set([...Object.keys(doc.endmatter.suggestions), ...spanSuggestionIds]),
  ).filter((id) => {
    const span = spanById.get(id);
    return span === undefined || isSuggestion(span);
  });

  // A note-free highlight is what separates the two kinds of root, so the same
  // call that picks the 🖍 label below also decides which tab an entry belongs to.
  const highlightRoots = roots.filter(({ id }) => highlightText(id) !== null);
  const commentRoots = roots.filter(({ id }) => highlightText(id) === null);

  // Membership, not classification: an id can answer to two tabs at once (an
  // endmatter entry listed under both `comments:` and `suggestions:`, say), and
  // asking which single tab it belongs to would call such a row hidden while it
  // sits on screen.
  function rootsUnder(key: Filter): { id: string; meta: CommentMeta | null }[] {
    if (key === 'all') return roots;
    if (key === 'highlights') return highlightRoots;
    return key === 'comments' ? commentRoots : [];
  }
  function shows(key: Filter, id: string): boolean {
    if (rootsUnder(key).some((r) => r.id === id)) return true;
    return (key === 'all' || key === 'suggestions') && suggestionIds.includes(id);
  }

  // Widen only for an entry the sidebar really has — a mark whose id no row
  // answers to (a reply's, say) would otherwise throw the user's tab away and
  // still show them nothing.
  const selectedIsListed = selectedId !== null && shows('all', selectedId);

  // The selection that last forced the filter open, latched so the widening
  // outlives the click that caused it: re-deciding it every render would let
  // the next mark click — or removing the widened entry — pull the tab back out
  // from under the user. Set during render rather than from an effect so the
  // row is listed before the scroll effect below looks for it.
  const [widenedAt, setWidenedAt] = useState(0);
  if (
    selectedId !== null &&
    selectSeq > chosen.atSeq &&
    selectSeq > widenedAt &&
    selectedIsListed &&
    !shows(chosen.key, selectedId)
  ) {
    setWidenedAt(selectSeq);
  }
  const filter: Filter = widenedAt > chosen.atSeq ? 'all' : chosen.key;

  const shownRoots = rootsUnder(filter);
  const shownSuggestionIds = filter === 'all' || filter === 'suggestions' ? suggestionIds : [];

  // Not keyed on filter, though the rows it searches depend on it: a tab press
  // must not scroll, or filtering would drag the view back to the old selection.
  // Gated on revealSelected for the same reason from the other side: a row the
  // reader clicked is already where they are looking.
  useEffect(() => {
    const aside = asideRef.current;
    if (!revealSelected || selectedId === null || aside === null) return;
    for (const el of aside.querySelectorAll<HTMLElement>('[data-thread-id]')) {
      if (el.dataset['threadId'] === selectedId) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
  }, [revealSelected, selectedId, selectSeq]);

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: roots.length + suggestionIds.length },
    { key: 'highlights', label: 'Highlights', count: highlightRoots.length },
    { key: 'comments', label: 'Comments', count: commentRoots.length },
    { key: 'suggestions', label: 'Suggestions', count: suggestionIds.length },
  ];

  return (
    <aside id="comment-sidebar" className="comment-sidebar" ref={asideRef}>
      <div className="sidebar-filter" role="group" aria-label="Filter sidebar entries">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={tab.key === filter ? 'filter-tab active' : 'filter-tab'}
            aria-pressed={tab.key === filter}
            onClick={() => {
              setChosen({ atSeq: selectSeq, key: tab.key });
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
        const replies = repliesUnder(comments, id);
        const highlighted = highlightText(id);
        const classes = ['thread'];
        if (highlighted !== null) classes.push('highlight');
        if (meta?.resolved === true) classes.push('resolved');
        if (id === selectedId) classes.push('selected');
        return (
          <div key={id} className={classes.join(' ')} data-thread-id={id}>
            {editingId === id ? (
              <CommentEditor
                initial={noteText(id)}
                label="Edit this comment"
                submitLabel="Save"
                // Only an endmatter body can hold one: a note in the prose is part
                // of a paragraph, and a line break there would split it.
                multiline={noteSpan(doc, id) === null}
                onSubmit={async (body) => {
                  // save() reads an unchanged document as a mark gone astray and
                  // says so — not what closing an untouched editor should raise.
                  if (body === noteText(id).trim()) {
                    setEditingId(null);
                    return true;
                  }
                  const saved = await onEdit(id, body);
                  if (saved) setEditingId(null);
                  return saved;
                }}
                onCancel={() => {
                  setEditingId(null);
                }}
              />
            ) : (
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
            )}
            {replies.map(([rid, r]) => {
              const refs = referenceIds(r.body ?? '');
              return editingId === rid ? (
                <CommentEditor
                  key={rid}
                  initial={r.body ?? ''}
                  label={`Edit ${r.by}'s reply`}
                  submitLabel="Save"
                  multiline
                  onSubmit={async (body) => {
                    if (body === r.body?.trim()) {
                      setEditingId(null);
                      return true;
                    }
                    const saved = await onEdit(rid, body);
                    if (saved) setEditingId(null);
                    return saved;
                  }}
                  onCancel={() => {
                    setEditingId(null);
                  }}
                />
              ) : (
                <div className="reply" key={rid}>
                  <div className="reply-line">
                    <ScrollLabel
                      className="reply-text"
                      onSelect={() => {
                        onSelect(id);
                      }}
                    >
                      <b>{r.by}</b>: {r.body}
                    </ScrollLabel>
                    <button
                      className="icon-button"
                      aria-label="Edit reply"
                      title="Edit reply"
                      onClick={() => {
                        setEditingId(rid);
                      }}
                    >
                      <PencilIcon />
                    </button>
                  </div>
                  {refs.length > 0 && (
                    <div className="reply-refs">
                      {refs.map((ref) => (
                        <button
                          className="cm-ref"
                          key={ref}
                          onClick={() => {
                            onSelect(ref);
                          }}
                        >
                          {ref}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            <CommentEditor
              label="Write a reply"
              submitLabel="Send"
              placeholder="Reply…"
              multiline
              onSubmit={(body) => onReply(id, body)}
            />
            {/* The row of actions, kept apart from the field above it: laid out as bare
                siblings they sat flush against the reply box, one block of controls. */}
            <div className="thread-actions">
              {noteFor(doc, id) !== null && editingId !== id && (
                <button
                  className="icon-button"
                  aria-label="Edit comment"
                  title="Edit comment"
                  onClick={() => {
                    setEditingId(id);
                  }}
                >
                  <PencilIcon />
                </button>
              )}
              {meta !== null && meta.resolved !== true && (
                <button
                  className="icon-button"
                  aria-label="Resolve"
                  title="Resolve"
                  onClick={() => {
                    onResolve(id);
                  }}
                >
                  <CheckIcon />
                </button>
              )}
              {/* Removing a bare highlight costs nothing but its markup, so it
                  goes unasked. Prose — a note, a reply — is gone for good, and
                  the thread reaches deeper than the replies rendered above. */}
              <button
                className="icon-button"
                aria-label="Remove"
                title="Remove"
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
                <TrashIcon />
              </button>
            </div>
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

// A thread's three controls are icon-only, so each glyph carries the meaning the words used to
// (the name is on the button). Stroked rather than filled, to sit with the send arrow the field
// already draws, and drawn to a common optical size: a box of equal sides for the pencil and the
// bin, and the wider, shorter span a check wants, so no one of them crowds its neighbours.
function PencilIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M10.5 3.5 12.5 5.5 6 12 3.5 12.5 4 10zM9.1 4.9 11.1 6.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.6 8.5 6.2 12.1 13.4 4.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3.2 4.7h9.6M6.5 4.7V3.4h3v1.3M4.7 4.7 5.2 12.8h5.6l.5-8.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

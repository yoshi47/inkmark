import { type JSX, useState } from 'react';
import {
  type CommentMeta,
  noteFor,
  noteFreeHighlight,
  parse,
  type Span,
  threadIds,
} from '../rfm/index.js';

const LABEL_MAX = 80;

type Filter = 'all' | 'highlights' | 'comments' | 'suggestions';

function removalPrompt(subject: string, replyCount: number): string {
  if (replyCount === 0) return `Delete this ${subject}?`;
  const replies = replyCount === 1 ? '1 reply' : `${String(replyCount)} replies`;
  return `Delete this ${subject} and its ${replies}?`;
}

interface SidebarProps {
  source: string;
  onReply: (parentId: string, body: string) => void;
  onResolve: (id: string) => void;
  onRemove: (id: string) => void;
  onRemoveComment: (id: string) => void;
  onSelect: (id: string) => void;
  onSuggestion: (id: string, action: 'accept' | 'reject') => void;
}

export function CommentSidebar({
  source,
  onReply,
  onResolve,
  onRemove,
  onRemoveComment,
  onSelect,
  onSuggestion,
}: SidebarProps): JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');
  const doc = parse(source);
  const comments = doc.endmatter.comments;

  function noteText(id: string): string {
    return noteFor(doc, id) ?? '';
  }

  function highlightText(id: string): string | null {
    return noteFreeHighlight(doc, id)?.inner ?? null;
  }

  // Root threads: endmatter entries with no re (reply-to) field, plus highlights
  // an agent wrote inline without an endmatter entry — the same fallback the
  // suggestion list makes below, so a hand-written mark is still listed here.
  // Those carry no metadata, hence no Resolve.
  const roots: { id: string; meta: CommentMeta | null }[] = [
    ...Object.entries(comments)
      .filter(([, c]) => c.re === undefined)
      .map(([id, meta]) => ({ id, meta })),
    ...doc.spans.flatMap((s) =>
      s.kind === 'highlight' && s.id !== undefined && comments[s.id] === undefined
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

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: roots.length + suggestionIds.length },
    { key: 'highlights', label: 'Highlights', count: highlightRoots.length },
    { key: 'comments', label: 'Comments', count: commentRoots.length },
    { key: 'suggestions', label: 'Suggestions', count: suggestionIds.length },
  ];

  return (
    <aside className="comment-sidebar">
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
        return (
          <div key={id} className={classes.join(' ')}>
            <button
              className="comment"
              title={highlighted ?? undefined}
              onClick={() => {
                onSelect(id);
              }}
            >
              {highlighted !== null ? (
                <>🖍 {truncate(highlighted)}</>
              ) : (
                <>
                  <b>{meta?.by ?? ''}</b>: {noteText(id)}
                </>
              )}
            </button>
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
          <div className="suggestion" key={id}>
            <button
              className="suggestion-label"
              onClick={() => {
                onSelect(id);
              }}
            >
              {label}
            </button>
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

function truncate(text: string): string {
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX)}…` : text;
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

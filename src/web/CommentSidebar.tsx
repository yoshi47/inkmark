import { type JSX, useState } from 'react';
import { parse, type Span } from '../rfm/index.js';

interface SidebarProps {
  source: string;
  onReply: (parentId: string, body: string) => void;
  onResolve: (id: string) => void;
  onSelect: (id: string) => void;
  onSuggestion: (id: string, action: 'accept' | 'reject') => void;
}

export function CommentSidebar({
  source,
  onReply,
  onResolve,
  onSelect,
  onSuggestion,
}: SidebarProps): JSX.Element {
  const doc = parse(source);
  const comments = doc.endmatter.comments;

  // Root comment threads: entries with no re (reply-to) field
  const roots = Object.entries(comments).filter(([, c]) => c.re === undefined);

  const inlineBody = (id: string): string =>
    doc.spans.find((s) => s.id === id && s.kind === 'comment')?.inner ?? '';

  // Collect suggestion IDs from both endmatter and inline spans
  const spanSuggestionIds = doc.spans
    .map((s) => s.id)
    .filter((id): id is string => id?.startsWith('s') === true);
  const suggestionIds = Array.from(
    new Set([...Object.keys(doc.endmatter.suggestions), ...spanSuggestionIds]),
  );

  return (
    <aside className="comment-sidebar">
      {roots.map(([id, c]) => {
        const replies = Object.entries(comments).filter(([, r]) => r.re === id);
        return (
          <div key={id} className={c.resolved === true ? 'thread resolved' : 'thread'}>
            <button
              className="comment"
              onClick={() => {
                onSelect(id);
              }}
            >
              <b>{c.by}</b>: {inlineBody(id)}
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
            {c.resolved !== true && (
              <button
                onClick={() => {
                  onResolve(id);
                }}
              >
                Resolve
              </button>
            )}
          </div>
        );
      })}
      {suggestionIds.map((id) => {
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

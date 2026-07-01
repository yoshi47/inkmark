import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { addReply, applySuggestion, insertComment, parse, setResolved } from '../rfm/index.js';
import { tokenize } from '../rfm/tokenize.js';
import { getFile, putFile, subscribe } from './api.js';
import { CommentSidebar } from './CommentSidebar.js';
import { MarkdownView } from './MarkdownView.js';
import { SelectionPopover } from './SelectionPopover.js';

export function App(): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const version = useRef('');
  const doc = useMemo(() => (content === null ? null : parse(content)), [content]);
  const spans = useMemo(() => (doc === null ? [] : tokenize(doc.body)), [doc]);
  const articleRef = useRef<HTMLElement | null>(null);

  // Apply a pure (content) -> content transform, re-applying against fresh
  // content on a 409 (Success Criterion #5: re-apply, not just reload).
  async function save(transform: (src: string) => string): Promise<void> {
    try {
      let base = content ?? '';
      let baseVersion = version.current;
      for (let attempt = 0; attempt < 3; attempt++) {
        const next = transform(base);
        const res = await putFile(next, baseVersion);
        if (res.ok) {
          version.current = res.version;
          setContent(next);
          return;
        }
        if (res.status === 409) {
          // Someone (AI) wrote concurrently — refetch and re-apply the transform
          const fresh = await getFile();
          base = fresh.content;
          baseVersion = fresh.version;
          continue;
        }
        alert(`save failed (${String(res.status)})`);
        return;
      }
      alert('save failed after retries (conflicts)');
    } catch (err) {
      if (err instanceof Error && err.message === 'selection moved') {
        alert('The text moved while you were commenting — please re-select and try again.');
      } else if (err instanceof Error && err.message.includes('overlap')) {
        alert('既存のマークと重なる範囲にはコメントできません。');
      } else {
        alert('save failed (network or server error)');
      }
    }
  }

  useEffect(() => {
    const doRefresh = async (): Promise<void> => {
      const r = await getFile();
      setContent(r.content);
      version.current = r.version;
    };
    void doRefresh();
    return subscribe(() => void doRefresh());
  }, []);

  if (content === null || doc === null) return <div>Loading…</div>;
  return (
    <div className="layout">
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
      />
      <CommentSidebar
        source={content}
        onReply={(pid, body) =>
          void save((src) => addReply(src, pid, body, 'user', new Date().toISOString()).md)
        }
        onResolve={(id) => void save((src) => setResolved(src, id, true))}
        onSuggestion={(id, action) => void save((src) => applySuggestion(src, id, action))}
      />
    </div>
  );
}

import { type JSX, useEffect, useRef, useState } from 'react';
import { addReply, applySuggestion, parse, setResolved } from '../rfm/index.js';
import { getFile, putFile, subscribe } from './api.js';
import { CommentSidebar } from './CommentSidebar.js';
import { MarkdownView } from './MarkdownView.js';

export function App(): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const version = useRef('');

  // Apply a pure (content) -> content transform, re-applying against fresh
  // content on a 409 (Success Criterion #5: re-apply, not just reload).
  async function save(transform: (src: string) => string): Promise<void> {
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

  if (content === null) return <div>Loading…</div>;
  const now = new Date().toISOString();
  return (
    <div className="layout">
      <MarkdownView source={parse(content).body} />
      <CommentSidebar
        source={content}
        onReply={(pid, body) => void save((src) => addReply(src, pid, body, 'user', now).md)}
        onResolve={(id) => void save((src) => setResolved(src, id, true))}
        onSuggestion={(id, action) => void save((src) => applySuggestion(src, id, action))}
      />
    </div>
  );
}

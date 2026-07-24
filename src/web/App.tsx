import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import {
  addReply,
  applySuggestion,
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
import { MarkdownView } from './MarkdownView.js';
import { SelectionPopover } from './SelectionPopover.js';

export function App(): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const version = useRef('');
  const doc = useMemo(() => (content === null ? null : parse(content)), [content]);
  const spans = useMemo(() => (doc === null ? [] : tokenize(doc.body)), [doc]);
  const articleRef = useRef<HTMLElement | null>(null);
  // seq, not the id alone: clicking the same mark twice must scroll again.
  const [selected, setSelected] = useState<{ id: string; seq: number } | null>(null);

  // Apply a pure (content) -> content transform, re-applying against fresh
  // content on a 409 (Success Criterion #5: re-apply, not just reload).
  async function save(transform: (src: string) => string): Promise<void> {
    try {
      let base = content ?? '';
      let baseVersion = version.current;
      for (let attempt = 0; attempt < 3; attempt++) {
        const next = transform(base);
        if (next === base) {
          // Every rfm transform declines by returning its input, so an unchanged
          // document means the mark was not what the sidebar took it for —
          // usually because an agent rewrote it. Writing it back would report a
          // save that did nothing at all.
          setContent(base);
          version.current = baseVersion;
          alert(
            'その操作はファイルを変更しませんでした（マークが書き換えられた可能性があります）。',
          );
          return;
        }
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
      // The rfm transforms run here, so this catch sees content errors as well as network ones.
      // Naming only the two it recognised reported the rest as a network failure — something the
      // user would retry forever over a document that will never save. Anything unrecognised now
      // says what it was instead of guessing why.
      if (err instanceof Error && err.message === 'selection moved') {
        alert('The text moved while you were commenting — please re-select and try again.');
      } else if (err instanceof Error && err.message.includes('overlap')) {
        alert('既存のマークと重なる範囲にはマークを付けられません。');
      } else if (err instanceof Error && err.message.includes('may not contain')) {
        alert(
          `この範囲にはマークを付けられません（CriticMarkup の終端記号を含んでいます）: ${err.message}`,
        );
      } else if (err instanceof Error) {
        alert(`save failed: ${err.message}`);
      } else {
        alert('save failed (network or server error)');
      }
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
      const r = await getFile();
      setContent(r.content);
      setPath(r.path);
      version.current = r.version;
    }
    void doRefresh();
    return subscribe(() => void doRefresh());
  }, []);

  useEffect(() => {
    if (path === null) return;
    const base = path.slice(path.lastIndexOf('/') + 1);
    document.title = `${base} — inkmark`;
  }, [path]);

  if (content === null || doc === null) return <div>Loading…</div>;
  return (
    <div className="layout">
      <header className="app-header" title={path ?? ''}>
        {path ?? ''}
      </header>
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
        onReply={(pid, body) =>
          void save((src) => addReply(src, pid, body, 'user', new Date().toISOString()).md)
        }
        onResolve={(id) => void save((src) => setResolved(src, id, true))}
        onSelect={scrollToSpan}
        onSuggestion={(id, action) => void save((src) => applySuggestion(src, id, action))}
        onRemove={(id) => void save((src) => removeHighlight(src, id))}
        onRemoveComment={(id) => void save((src) => removeComment(src, id))}
      />
    </div>
  );
}

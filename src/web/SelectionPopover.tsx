import { type JSX, type RefObject, useEffect, useState } from 'react';
import { resolveSelectionRange, type SelectionResult } from './sourceOffset.js';

interface PopoverState {
  result: SelectionResult;
  x: number;
  y: number;
}

export function SelectionPopover({
  body,
  rootRef,
  onComment,
  onHighlight,
}: {
  body: string;
  rootRef: RefObject<HTMLElement | null>;
  onComment: (range: [number, number], commentBody: string, selectedText: string) => void;
  onHighlight: (range: [number, number], selectedText: string) => void;
}): JSX.Element | null {
  const [state, setState] = useState<PopoverState | null>(null);

  useEffect(() => {
    function offerFromSelection(): void {
      const sel = window.getSelection();
      const root = rootRef.current;
      if (sel === null || root === null || sel.rangeCount === 0) {
        setState(null);
        return;
      }
      const result = resolveSelectionRange(sel, body, root);
      if (result === null) {
        setState(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setState({ x: rect.left + window.scrollX, y: rect.bottom + window.scrollY, result });
    }

    // Touch has no mouseup: the platform sends pointerup when a drag ends, but a selection
    // finished by its grab handles can stream selectionchange and never deliver one. So the
    // popover is offered from both — the pointer event keeps the mouse path instant, and a short
    // pause on selectionchange catches whatever the pointer event missed. Debounced because
    // selectionchange also fires mid-drag, and a popover chasing the cursor is unusable.
    let timer: number | null = null;
    function onSelectionChange(): void {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(offerFromSelection, 150);
    }

    // A popover is pinned to the rect it was measured at, and scrolling slides the text out from
    // under it. Dismissing is cheaper than chasing the mark, and a scroll is not a selection.
    function onScroll(): void {
      setState(null);
    }

    document.addEventListener('mouseup', offerFromSelection);
    document.addEventListener('pointerup', offerFromSelection);
    document.addEventListener('selectionchange', onSelectionChange);
    // Capture, because the document scrolls inside <article> and scroll does not bubble.
    document.addEventListener('scroll', onScroll, true);
    return (): void => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('mouseup', offerFromSelection);
      document.removeEventListener('pointerup', offerFromSelection);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [body, rootRef]);

  if (state === null) return null;
  const { result } = state;

  function dismiss(): void {
    setState(null);
    window.getSelection()?.removeAllRanges();
  }

  return (
    <div
      className="selection-popover"
      style={{ position: 'absolute', left: state.x, top: state.y }}
    >
      {result.ok ? (
        <>
          <button
            onClick={() => {
              const commentBody = window.prompt('Comment:');
              if (commentBody !== null && commentBody.trim().length > 0)
                onComment([result.start, result.end], commentBody.trim(), result.text);
              dismiss();
            }}
          >
            💬 Comment
          </button>
          <button
            onClick={() => {
              onHighlight([result.start, result.end], result.text);
              dismiss();
            }}
          >
            🖍 Highlight
          </button>
        </>
      ) : (
        <span className="selection-hint">
          {result.reason === 'crosses-code-block'
            ? 'コードブロックをまたぐ選択にはマークを付けられません'
            : result.reason === 'overlaps-mark'
              ? '既存のマークと重なる範囲にはマークを付けられません'
              : 'この範囲は選択できません'}
        </span>
      )}
    </div>
  );
}

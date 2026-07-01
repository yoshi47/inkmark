import { type JSX, useEffect, useState } from 'react';
import { resolveSelectionRange } from './sourceOffset.js';

interface PopoverState {
  range: [number, number];
  selectedText: string;
  x: number;
  y: number;
}

export function SelectionPopover({
  body,
  onComment,
}: {
  body: string;
  onComment: (range: [number, number], commentBody: string, selectedText: string) => void;
}): JSX.Element | null {
  const [state, setState] = useState<PopoverState | null>(null);

  useEffect(() => {
    function onMouseUp(): void {
      const sel = window.getSelection();
      const root = document.querySelector<HTMLElement>('.markdown-body');
      if (sel === null || root === null) {
        setState(null);
        return;
      }
      const r = resolveSelectionRange(sel, body, root);
      if (r?.ok !== true) {
        setState(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setState({
        x: rect.left + window.scrollX,
        y: rect.bottom + window.scrollY,
        range: [r.start, r.end],
        selectedText: sel.toString(),
      });
    }
    document.addEventListener('mouseup', onMouseUp);
    return (): void => {
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [body]);

  if (state === null) return null;
  return (
    <div
      className="selection-popover"
      style={{ position: 'absolute', left: state.x, top: state.y }}
    >
      <button
        onClick={() => {
          const commentBody = window.prompt('Comment:');
          if (commentBody !== null && commentBody.trim().length > 0)
            onComment(state.range, commentBody.trim(), state.selectedText);
          setState(null);
          window.getSelection()?.removeAllRanges();
        }}
      >
        💬 Comment
      </button>
    </div>
  );
}

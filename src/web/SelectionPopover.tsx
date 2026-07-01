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
}: {
  body: string;
  rootRef: RefObject<HTMLElement | null>;
  onComment: (range: [number, number], commentBody: string, selectedText: string) => void;
}): JSX.Element | null {
  const [state, setState] = useState<PopoverState | null>(null);

  useEffect(() => {
    function onMouseUp(): void {
      const sel = window.getSelection();
      const root = rootRef.current;
      if (sel === null || root === null) {
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
    document.addEventListener('mouseup', onMouseUp);
    return (): void => {
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [body, rootRef]);

  if (state === null) return null;
  const { result } = state;
  return (
    <div
      className="selection-popover"
      style={{ position: 'absolute', left: state.x, top: state.y }}
    >
      {result.ok ? (
        <button
          onClick={() => {
            const commentBody = window.prompt('Comment:');
            if (commentBody !== null && commentBody.trim().length > 0)
              onComment([result.start, result.end], commentBody.trim(), result.text);
            setState(null);
            window.getSelection()?.removeAllRanges();
          }}
        >
          💬 Comment
        </button>
      ) : (
        <span className="selection-hint">
          {result.reason === 'cross-block'
            ? '段落をまたぐ選択にはコメントできません'
            : result.reason === 'overlaps-mark'
              ? '既存のマークと重なる範囲にはコメントできません'
              : 'この範囲は選択できません'}
        </span>
      )}
    </div>
  );
}

import { type JSX, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { CommentEditor } from './CommentEditor.js';
import { resolveSelectionRange, type SelectionResult } from './sourceOffset.js';

/** Wider than the pair of buttons it replaces, and capped so it never runs off the viewport. */
const MAX_WIDTH = 320;
/** A one-line box plus its buttons: below this much room, the editor would spill past the fold. */
const ROOM_FOR_EDITOR = 140;

interface PopoverState {
  result: SelectionResult;
  /** Viewport x of the popover's left edge, clamped inside the viewport. */
  left: number;
  /** Top of the selection, in viewport coordinates. */
  top: number;
  /** Bottom of the selection, in viewport coordinates. */
  bottom: number;
  width: number;
  /** Whether the popover hangs off the selection's top edge instead of its bottom. */
  above: boolean;
}

export function SelectionPopover({
  body,
  rootRef,
  onComment,
  onHighlight,
}: {
  body: string;
  rootRef: RefObject<HTMLElement | null>;
  /** Resolves to whether the document was written; a refused save keeps the editor open. */
  onComment: (
    range: [number, number],
    commentBody: string,
    selectedText: string,
  ) => Promise<boolean>;
  onHighlight: (range: [number, number], selectedText: string) => void;
}): JSX.Element | null {
  const [state, setState] = useState<PopoverState | null>(null);
  const [editing, setEditing] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Drop the popover and whatever it was showing. Stable, so the listeners below can hold it
  // without re-registering.
  const dismiss = useCallback((): void => {
    setEditing(false);
    setState(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  useEffect(() => {
    // The pointer landing on the box itself — a button, or the textarea mid-sentence — is the
    // user's own. Reading the caret there as a new selection would throw the editor away.
    function insidePopover(node: EventTarget | null): boolean {
      const el = popoverRef.current;
      return node instanceof Node && el?.contains(node) === true;
    }

    function offerFromSelection(e?: Event): void {
      // The debounced selectionchange path passes no event; only a real pointer event can land
      // on the box itself.
      if (e !== undefined && insidePopover(e.target)) return;
      // The pointer came down somewhere else while the editor was open: the writer has moved on.
      if (editing) {
        dismiss();
        return;
      }
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
      const width = Math.min(MAX_WIDTH, window.innerWidth - 16);
      const roomBelow = window.innerHeight - rect.bottom;
      setState({
        result,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: rect.top,
        bottom: rect.bottom,
        width,
        // The editor grows downward, so a selection low on the screen leaves it nowhere to go.
        // Flip above when the room below is short and there is more of it above.
        above: roomBelow < ROOM_FOR_EDITOR && rect.top > roomBelow,
      });
    }

    // Touch has no mouseup: the platform sends pointerup when a drag ends, but a selection
    // finished by its grab handles can stream selectionchange and never deliver one. So the
    // popover is offered from both — the pointer event keeps the mouse path instant, and a short
    // pause on selectionchange catches whatever the pointer event missed. Debounced because
    // selectionchange also fires mid-drag, and a popover chasing the cursor is unusable.
    let timer: number | null = null;
    function onSelectionChange(): void {
      // While the editor is open the selection is the writer's caret, not a new anchor.
      if (editing) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(offerFromSelection, 150);
    }

    // A popover is pinned to the rect it was measured at, and scrolling slides the text out from
    // under it. Dismissing is cheaper than chasing the mark, and a scroll is not a selection —
    // but it would take the editor's text with it, so while editing the box stays where it is.
    function onScroll(): void {
      if (editing) return;
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
  }, [body, rootRef, editing, dismiss]);

  if (state === null) return null;
  const { result } = state;

  return (
    <div
      ref={popoverRef}
      className={editing ? 'selection-popover selection-popover--editing' : 'selection-popover'}
      style={{
        position: 'absolute',
        left: state.left,
        maxWidth: state.width,
        // Anchoring by bottom lets the growing editor hang upward from the selection's top edge.
        ...(state.above ? { bottom: window.innerHeight - state.top } : { top: state.bottom }),
      }}
    >
      {!result.ok ? (
        <span className="selection-hint">
          {result.reason === 'crosses-code-block'
            ? 'You cannot mark a selection that crosses a code block'
            : result.reason === 'overlaps-mark'
              ? 'You cannot mark a range that overlaps an existing mark'
              : 'This range cannot be selected'}
        </span>
      ) : editing ? (
        <CommentEditor
          focusOnMount
          label="Write a comment"
          submitLabel="Send comment"
          placeholder="Add a comment…"
          // A note in the body cannot hold a line break, so Enter always sends.
          multiline={false}
          onSubmit={async (commentBody) => {
            const saved = await onComment([result.start, result.end], commentBody, result.text);
            if (saved) dismiss();
            return saved;
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      ) : (
        <>
          <button
            onClick={() => {
              setEditing(true);
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
      )}
    </div>
  );
}

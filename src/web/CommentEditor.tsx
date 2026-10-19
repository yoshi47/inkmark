import { type JSX, useLayoutEffect, useRef, useState } from 'react';

/**
 * The box a comment is written in: a reply, an edit of an existing note, and a new
 * comment opened on a selection in the body. A textarea rather than an input, because
 * one line scrolls what the writer has already typed out of sight — it grows to fit its
 * text and scrolls past 12rem (see .reply-box).
 *
 * Enter sends; `multiline` decides what Shift+Enter is for. A note in the body sits
 * inside a paragraph, which a line break would split, so its editor — the one that is not
 * `multiline` — sends on Enter whether or not Shift is down; an endmatter body may hold
 * line breaks, so Shift+Enter opens one there.
 *
 * An Enter that only commits an IME conversion belongs to the IME, not to the send. Most
 * browsers report it as `isComposing`, but Safari ends the composition before the keydown
 * and hands it over with that flag already cleared; there `keyCode` 229 — the code an IME
 * stamps on its own keystrokes — is the only sign it is not a send.
 *
 * `onCancel` is what tells the two roles apart — an editor closes on save, so it must
 * not also clear itself, and it is the only one Escape has anything to do in.
 *
 * One shape wherever the box appears — the popover, a reply, an edit: a field holding the
 * growing textarea with the send inside it, the form Figma, Notion and Linear give a comment.
 * The send is an icon, so `submitLabel` is its accessible name, and it is drawn only while the
 * field is focused or holds text; Escape and, in the popover, a click away are the way out, so
 * no Cancel button argues with the placeholder for the eye.
 *
 * `focusOnMount` is for the popover, which mounts this in place of two buttons the user
 * just pressed and wants the caret already in the box.
 */
export function CommentEditor({
  focusOnMount = false,
  initial = '',
  label,
  submitLabel,
  placeholder,
  multiline,
  onSubmit,
  onCancel,
}: {
  focusOnMount?: boolean;
  initial?: string;
  label: string;
  submitLabel: string;
  placeholder?: string;
  multiline: boolean;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
}): JSX.Element {
  const [text, setText] = useState(initial);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Focused from script rather than the autoFocus attribute: the attribute is flagged by
  // jsx-a11y for the page-load case, but this box opens from a click, where the caret belongs.
  useLayoutEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  // Back to auto first: scrollHeight only ever reports the taller of the two, so
  // measuring against the current height would let the box grow and never shrink.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    // scrollHeight stops at the padding, and the box is sized border-box, so the
    // border has to be added back or the last line sits 2px behind the edge.
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${String(el.scrollHeight + border)}px`;
  }, [text]);
  const empty = text.trim().length === 0;
  // An accent-filled square parked on every thread's empty reply box turns a sidebar of threads
  // into a column of identical buttons, so the send is kept for a field the writer is actually
  // in: focused, or holding text. It cannot eat a click either — a send worth pressing implies
  // text in the box, which keeps it drawn through the blur the press itself causes.
  const showSend = focused || !empty;
  function submit(): void {
    if (empty) return;
    // Clear only once the document is written: a save the server refused would
    // otherwise take the text with it, and there is nowhere to type it back from.
    void onSubmit(text.trim()).then((saved) => {
      if (saved && onCancel === undefined) setText('');
    });
  }
  return (
    <div className="reply-box">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && onCancel !== undefined) {
            // Why not let it bubble: the window listener in App treats Escape as a drawer-dismiss,
            // so at a narrow width cancelling an edit would also close the whole comment drawer.
            e.stopPropagation();
            onCancel();
            return;
          }
          if (e.key !== 'Enter') return;
          // Enter closing an IME conversion commits the candidate; it is not a send.
          // `isComposing` catches it everywhere but Safari, which fires `compositionend`
          // first and hands the keydown over with the flag already cleared — there the
          // IME's own keyCode 229 is what gives it away.
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- 229 is the only marker Safari leaves on that Enter
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (multiline && e.shiftKey) return;
          e.preventDefault();
          submit();
        }}
      />
      {/* Disabled rather than quietly refusing: an empty comment is not a way to delete one, and
          a button that swallows the click reads as broken. Icon only, so the name is spelled out
          for a screen reader. */}
      {showSend && (
        <button className="reply-send" aria-label={submitLabel} disabled={empty} onClick={submit}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M8 13V3M8 3 4 7M8 3l4 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

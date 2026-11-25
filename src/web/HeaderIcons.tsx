import type { JSX } from 'react';

// The header's icon-only controls carry their names on the button, so each glyph only has to be
// recognisable. Drawn like the thread icons in CommentSidebar: stroked, on the same 16px grid.

export function ContentsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 3.5h11M4.5 8h9M4.5 12.5h7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CommentsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 3h11v7.5H8L5 13v-2.5H2.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ViewIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2 4h12M2 8h12M2 12h12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* Knobs on the sliders: filled with the header's own background so each one cuts its line. */}
      <g fill="var(--sidebar-bg)" stroke="currentColor" strokeWidth="1.5">
        <circle cx="5" cy="4" r="1.6" />
        <circle cx="11" cy="8" r="1.6" />
        <circle cx="7" cy="12" r="1.6" />
      </g>
    </svg>
  );
}

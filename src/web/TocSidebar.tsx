import { type CSSProperties, type JSX, useEffect, useRef } from 'react';
import type { TocEntry } from './toc.js';

export function TocSidebar({
  entries,
  activeId,
  onSelect,
}: {
  entries: TocEntry[];
  activeId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const navRef = useRef<HTMLElement | null>(null);

  // The column scrolls on its own, so in a long document the entry scroll-spy just lit up can sit
  // outside it — the highlight would be doing its work where nobody can see it. 'nearest' keeps a
  // row that is already visible exactly where it is, so reading down the body does not make the
  // table of contents twitch.
  useEffect(() => {
    const nav = navRef.current;
    if (nav === null || activeId === null) return;
    for (const el of nav.querySelectorAll<HTMLElement>('[data-toc-id]')) {
      if (el.dataset['tocId'] === activeId) {
        el.scrollIntoView({ block: 'nearest' });
        return;
      }
    }
  }, [activeId]);

  return (
    <nav className="toc-sidebar" aria-label="目次" ref={navRef}>
      <ul className="toc-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              className={entry.id === activeId ? 'toc-item active' : 'toc-item'}
              style={{ '--toc-level': entry.level } as CSSProperties}
              data-toc-id={entry.id}
              aria-current={entry.id === activeId ? 'location' : undefined}
              onClick={() => {
                onSelect(entry.id);
              }}
            >
              {entry.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

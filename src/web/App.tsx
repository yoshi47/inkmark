import { type JSX, useEffect, useRef, useState } from 'react';
import { parse } from '../rfm/index.js';
import { getFile, subscribe } from './api.js';
import { MarkdownView } from './MarkdownView.js';

export function App(): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const version = useRef('');

  useEffect(() => {
    const refresh = async (): Promise<void> => {
      const r = await getFile();
      setContent(r.content);
      version.current = r.version;
    };
    void refresh();
    return subscribe((): void => {
      void refresh();
    });
  }, []);

  if (content === null) return <div>Loading…</div>;
  const body = parse(content).body;
  return (
    <div className="layout">
      <MarkdownView source={body} />
    </div>
  );
}

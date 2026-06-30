import chokidar, { type FSWatcher } from 'chokidar';
import { basename, dirname } from 'node:path';
import type { FileStore } from './fileStore.js';

export class FileWatcher {
  private readonly store: FileStore;
  private watcher: FSWatcher | null = null;
  private readonly listeners = new Set<(version: string) => void>();
  /**
   * Last version seen from the file — used to suppress spurious OS events
   * (e.g. macOS FSEvents delivers a buffered change shortly after watch starts)
   * as well as genuine "no-op" events where content hasn't actually changed.
   * Updated on every handled event (suppressed or emitted).
   */
  private knownVersion: string | null = null;

  constructor(store: FileStore) {
    this.store = store;
  }

  start(): void {
    const dir = dirname(this.store.absPath);
    const name = basename(this.store.absPath);

    // Eagerly read the initial version so that spurious OS events that fire
    // right after the watcher starts (common on macOS/FSEvents) are suppressed.
    void this.store
      .read()
      .then(({ version }) => {
        this.knownVersion = version;
      })
      .catch(() => {
        // File might not exist yet; knownVersion stays null.
      });

    // Watch the directory (depth 0) so a save-by-rename does not break the watch.
    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
    });

    const handler = async (changedPath: string): Promise<void> => {
      if (basename(changedPath) !== name) return;
      try {
        const { version } = await this.store.read();
        if (version === this.store.lastWritten) {
          // Self-echo: we wrote this version; update knownVersion and suppress.
          this.knownVersion = version;
          return;
        }
        if (version === this.knownVersion) {
          // Content unchanged (spurious OS event); suppress.
          return;
        }
        this.knownVersion = version;
        for (const cb of this.listeners) cb(version);
      } catch {
        /* file briefly missing during rename; ignore */
      }
    };

    this.watcher
      .on('add', (p: string) => {
        void handler(p);
      })
      .on('change', (p: string) => {
        void handler(p);
      });
  }

  onChange(cb: (version: string) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.listeners.clear();
  }
}

import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { computeVersion } from './version.js';

export class FileStore {
  readonly absPath: string;
  lastWritten: string | null = null;

  constructor(absPath: string) {
    this.absPath = absPath;
  }

  async read(): Promise<{ content: string; version: string }> {
    const content = await readFile(this.absPath, 'utf8');
    return { content, version: computeVersion(content) };
  }

  /** Atomic write via temp file + rename. Returns the new version. */
  async write(content: string): Promise<string> {
    const tmp = join(
      dirname(this.absPath),
      `.inkmark-${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`,
    );
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, this.absPath);
    const version = computeVersion(content);
    this.lastWritten = version;
    return version;
  }
}

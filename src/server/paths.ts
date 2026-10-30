import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * inkmark's own directory: the server registry, the logs and the config all live here.
 * `INKMARK_HOME` exists so tests — and anyone who wants the state somewhere else — do not
 * have to write into the real one.
 */
export function homeDir(): string {
  return process.env['INKMARK_HOME'] ?? join(homedir(), '.inkmark');
}

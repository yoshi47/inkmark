import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import open from 'open';
import { startServer } from '../server/start.js';
import { findFreePort } from './port.js';

const STATE = join(homedir(), '.inkmark', 'server.json');
const DEFAULT_PORT = 4747;

async function cmdOpen(fileArg: string | undefined): Promise<number> {
  if (fileArg === undefined) {
    console.error('usage: inkmark open <file.md>');
    return 2;
  }
  const absPath = resolve(process.cwd(), fileArg);
  if (!absPath.endsWith('.md')) {
    console.error(`not a markdown file: ${absPath}`);
    return 2;
  }
  try {
    await stat(absPath);
  } catch {
    console.error(`file not found: ${absPath}`);
    return 2;
  }
  const port = await findFreePort(DEFAULT_PORT);
  const server = await startServer(absPath, port);
  await mkdir(join(homedir(), '.inkmark'), { recursive: true });
  await writeFile(
    STATE,
    JSON.stringify({ file: absPath, pid: process.pid, port, url: server.url }),
  );
  console.log(`inkmark serving ${absPath}\n  ${server.url}`);
  await open(server.url);

  const shutdown = async (): Promise<void> => {
    await server.close();
    await rm(STATE, { force: true });
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  await new Promise<void>(() => {
    /* run until a signal handler exits the process */
  });
  return 0;
}

async function cmdStatus(): Promise<number> {
  try {
    const s = JSON.parse(await readFile(STATE, 'utf8')) as {
      file: string;
      pid: number;
      port: number;
      url: string;
    };
    console.log(`running: ${s.url} (pid ${String(s.pid)}, file ${s.file})`);
  } catch {
    console.log('not running');
  }
  return 0;
}

async function cmdStop(): Promise<number> {
  try {
    const s = JSON.parse(await readFile(STATE, 'utf8')) as {
      file: string;
      pid: number;
      port: number;
      url: string;
    };
    process.kill(s.pid, 'SIGTERM');
    console.log('stopped');
  } catch {
    console.log('not running');
  }
  await rm(STATE, { force: true });
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const arg = argv[1];
  if (cmd === undefined) {
    console.error('usage: inkmark <open|status|stop> [file.md]');
    return 2;
  }
  switch (cmd) {
    case 'open':
      return cmdOpen(arg);
    case 'status':
      return cmdStatus();
    case 'stop':
      return cmdStop();
    default:
      console.error('usage: inkmark <open|status|stop> [file.md]');
      return 2;
  }
}

void main(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });

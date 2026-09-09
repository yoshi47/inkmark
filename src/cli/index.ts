import { main } from './commands.js';

void main(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });

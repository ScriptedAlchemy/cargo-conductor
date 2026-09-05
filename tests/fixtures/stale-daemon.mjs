import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';

const [socketPath, logPath, mode] = process.argv.slice(2);
if (socketPath === undefined || logPath === undefined || (mode !== 'replaceable' && mode !== 'stubborn')) {
  throw new Error('usage: stale-daemon.mjs <socket> <log> <replaceable|stubborn>');
}

mkdirSync(dirname(socketPath), { recursive: true });
rmSync(socketPath, { force: true });

const log = (message) => {
  appendFileSync(logPath, `${message}\n`);
};

const server = createServer((socket) => {
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line);
      log(message.type);
      if (message.type === 'ping') {
        socket.write(`${JSON.stringify({
          id: message.id,
          pid: process.pid,
          startedAtMs: 1,
          type: 'pong',
          version: '0.6.0',
        })}\n`);
      } else if (message.type === 'status') {
        socket.write(`${JSON.stringify({
          id: message.id,
          report: {
            active: [],
            recent: [{ ticket: 'cc-old' }],
            version: '0.6.0',
          },
          type: 'status-result',
        })}\n`);
      } else if (message.type === 'shutdown') {
        socket.write(`${JSON.stringify({ id: message.id, type: 'shutting-down' })}\n`);
        if (mode === 'replaceable') {
          server.close(() => process.exit(0));
        }
      }
    }
  });
});

server.listen(socketPath, () => {
  process.stdout.write('ready\n');
});

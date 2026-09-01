#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const appHtml = join(repoRoot, 'artifact', 'plugin', 'mcp-apps', 'dashboard.html');
const conductorCli = join(repoRoot, 'artifact', 'plugin', 'scripts', 'conductor.mjs');
const portFlag = process.argv.indexOf('--port');
const port = portFlag === -1 ? 4941 : Number(process.argv[portFlag + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error('--port requires an integer from 1 to 65535');
  process.exit(1);
}

const harness = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>cargo-conductor dashboard (live preview)</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style></head>
<body>
<iframe id="app" src="/app"></iframe>
<script>
const app = document.getElementById('app');
window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || msg.jsonrpc !== '2.0') return;
  const reply = (payload) => app.contentWindow.postMessage({ jsonrpc: '2.0', ...payload }, '*');
  if (msg.method === 'ui/initialize' && typeof msg.id === 'number') {
    reply({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'tools/call' && typeof msg.id === 'number') {
    try {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      let url = '/status';
      if (name === 'conductor_result') {
        url = '/result?ticket=' + encodeURIComponent(args.ticket ?? '');
      } else if (name === 'conductor_await') {
        url = '/await?ticket=' + encodeURIComponent(args.ticket ?? '');
        if (typeof args.maxWaitMs === 'number') url += '&maxWaitMs=' + args.maxWaitMs;
      }
      const payload = await (await fetch(url)).json();
      reply({ id: msg.id, result: { structuredContent: payload } });
    } catch (error) {
      reply({ id: msg.id, error: { message: String(error) } });
    }
  }
});
</script>
</body>
</html>`;

const runConductor = (args, response) => {
  execFile(process.execPath, [conductorCli, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
    if (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(stdout);
  });
};

const badRequest = (response, message) => {
  response.writeHead(400, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: message }));
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(harness);
    return;
  }
  if (url.pathname === '/app') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(readFileSync(appHtml));
    return;
  }
  if (url.pathname === '/status') {
    runConductor(['status'], response);
    return;
  }
  // The widget's ticket drawer follow-up: status payloads strip outputTail,
  // conductor result reads the full ledger record.
  if (url.pathname === '/result' || url.pathname === '/await') {
    const ticket = url.searchParams.get('ticket');
    if (ticket === null || ticket.length === 0) {
      badRequest(response, 'ticket query parameter is required');
      return;
    }
    if (url.pathname === '/result') {
      runConductor(['result', ticket], response);
      return;
    }
    const maxWaitMs = url.searchParams.get('maxWaitMs');
    runConductor(
      ['await', ticket, ...(maxWaitMs === null ? [] : ['--max-wait-ms', maxWaitMs])],
      response,
    );
    return;
  }
  response.writeHead(404);
  response.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`dashboard preview at http://127.0.0.1:${port}`);
});

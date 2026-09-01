#!/usr/bin/env node
// Serve the built dashboard MCP App against the live daemon, outside any MCP
// host. The page iframes the real artifact HTML and answers its JSON-RPC
// postMessage traffic; tools/call is backed by `conductor.mjs status`.
// Usage: node scripts/preview-dashboard.mjs [--port 4941]
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
      const status = await (await fetch('/status')).json();
      reply({ id: msg.id, result: { structuredContent: status } });
    } catch (error) {
      reply({ id: msg.id, error: { message: String(error) } });
    }
  }
});
</script>
</body>
</html>`;

const server = createServer((request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(harness);
    return;
  }
  if (request.url === '/app') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(readFileSync(appHtml));
    return;
  }
  if (request.url === '/status') {
    execFile(process.execPath, [conductorCli, 'status'], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: String(error) }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(stdout);
    });
    return;
  }
  response.writeHead(404);
  response.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`dashboard preview at http://127.0.0.1:${port}`);
});

import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const types = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'};
export function serve(port = 4175) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(root) || !types[path.extname(file)]) {res.writeHead(404).end(); return;}
      const body = await readFile(file);
      res.writeHead(200, {'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store'}).end(body);
    } catch {res.writeHead(404).end();}
  });
  server.listen(port, '127.0.0.1');
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = serve(Number(process.env.CARDGRID_A0_PORT ?? 4175));
  server.on('listening', () => console.log(`A0 synthetic preview: http://127.0.0.1:${server.address().port}`));
  server.on('error', error => {console.error(error.message); process.exitCode = 1;});
}

import { createServer } from 'node:http';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

export function createStaticServer({ root = projectRoot } = {}) {
  root = path.resolve(root);
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    const fail = (status, text) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : text);
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      fail(405, 'Method not allowed');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(request.url.split('?')[0]);
    } catch {
      fail(400, 'Invalid URL');
      return;
    }
    // Inspect the original path: URL normalization would silently erase "..".
    if (!pathname.startsWith('/') || /[\\:\x00-\x1f\x7f]/u.test(pathname)
      || pathname.split('/').some(part => part.startsWith('.'))
      || pathname.split('/').some(part => /[. ]$/u.test(part))) {
      fail(403, 'Forbidden');
      return;
    }

    // Expose only site assets, never scripts, tests, package files or secrets.
    let base;
    let filename;
    if (pathname === '/' || pathname === '/index.html') {
      base = root;
      filename = path.join(root, 'index.html');
    } else if (pathname.startsWith('/src/')) {
      base = path.join(root, 'src');
      filename = path.resolve(base, `.${pathname.slice(4)}`);
    } else {
      base = path.join(root, 'public');
      filename = path.resolve(base, `.${pathname}`);
    }

    let handle;
    try {
      const [canonicalRoot, canonicalBase, canonicalFile] = await Promise.all([
        realpath(root), realpath(base), realpath(filename),
      ]);
      if (!isWithin(canonicalRoot, canonicalBase)
        || !isWithin(canonicalBase, canonicalFile)
        || !isWithin(base, filename)) {
        fail(403, 'Forbidden');
        return;
      }
      handle = await open(canonicalFile, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) {
        fail(404, 'Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(filename).toLowerCase()]
          ?? 'application/octet-stream',
        'Content-Length': stat.size,
      });
      if (request.method === 'HEAD') {
        response.end();
      } else {
        await pipeline(handle.createReadStream({ autoClose: false }), response);
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
      } else {
        const status = ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404
          : ['EACCES', 'EPERM', 'ELOOP'].includes(error.code) ? 403 : 500;
        fail(status, status === 404 ? 'Not found' : status === 403 ? 'Forbidden' : 'Server error');
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex === -1 ? 4173 : Number(process.argv[portIndex + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('Укажите порт от 1024 до 65535: npm run dev -- --port 4180');
    process.exit(1);
  }
  const server = createStaticServer();
  server.on('error', error => {
    console.error(`Не удалось запустить сервер: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Limitless: http://127.0.0.1:${port}`);
  });
}

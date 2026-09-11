import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createStaticServer } from '../scripts/serve.mjs';
import { build } from '../scripts/build.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'limitless-test-'));
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'public', 'images'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<h1>Привет</h1>');
  await writeFile(path.join(root, 'src', 'app.js'), 'export const ready = true;');
  await writeFile(path.join(root, 'src', 'style.css'), 'body { color: black; }');
  await writeFile(path.join(root, 'public', 'images', 'logo.svg'), '<svg/>');
  await writeFile(path.join(root, 'public', 'data.bin'), Buffer.from([0, 255]));
  await writeFile(path.join(root, 'private.txt'), 'private');
  return root;
}

function get(port, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: url, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('сервер: страницы, MIME, HEAD, ошибки и traversal', async t => {
  const root = await fixture();
  const server = createStaticServer({ root });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  for (const [url, type] of [
    ['/', 'text/html; charset=utf-8'],
    ['/src/app.js?v=1', 'text/javascript; charset=utf-8'],
    ['/src/style.css', 'text/css; charset=utf-8'],
    ['/images/logo.svg', 'image/svg+xml'],
    ['/data.bin', 'application/octet-stream'],
  ]) {
    const response = await get(port, url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers['content-type'], type);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
  const head = await get(port, '/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength('<h1>Привет</h1>'));
  for (const url of ['/missing', '/private.txt', '/scripts/serve.mjs', '/src/', '/images/']) {
    assert.equal((await get(port, url)).status, 404, url);
  }
  for (const url of ['/../private.txt', '/%2e%2e/private.txt', '/src/%2e%2e/private.txt',
    '/src/%2e%2e%2fprivate.txt', '/src\\..\\private.txt', '/.env',
    '/%00', '/src/app.js:stream', '/src/..%20/private.txt']) {
    assert.equal((await get(port, url)).status, 403, url);
  }
  assert.equal((await get(port, '/%ZZ')).status, 400);
  const post = await get(port, '/api/leads', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('сервер запрещает выход через ссылку на внешний каталог', async t => {
  const root = await fixture();
  const outside = await fixture();
  await symlink(outside, path.join(root, 'public', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const server = createStaticServer({ root });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  assert.equal((await get(server.address().port, '/escape/private.txt')).status, 403);
});

test('сборка копирует ресурсы, обновляет свои файлы и сохраняет посторонние', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'dist', 'foreign'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'foreign', 'keep.txt'), 'keep');
  const result = await build({ root });
  assert.equal(result.files, 5);
  assert.equal(await readFile(path.join(root, 'dist', 'index.html'), 'utf8'), '<h1>Привет</h1>');
  assert.equal(await readFile(path.join(root, 'dist', 'images', 'logo.svg'), 'utf8'), '<svg/>');
  await assert.rejects(readFile(path.join(root, 'dist', 'public', 'images', 'logo.svg')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, 'dist', 'private.txt')), { code: 'ENOENT' });
  await writeFile(path.join(root, 'src', 'app.js'), 'updated');
  await build({ root });
  assert.equal(await readFile(path.join(root, 'dist', 'src', 'app.js'), 'utf8'), 'updated');
  assert.equal(await readFile(path.join(root, 'dist', 'foreign', 'keep.txt'), 'utf8'), 'keep');
});

test('сборка отклоняет конфликт public/index.html до записи', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'public', 'index.html'), 'collision');
  await assert.rejects(build({ root }), /Конфликт/);
  await assert.rejects(readFile(path.join(root, 'dist', 'index.html')), { code: 'ENOENT' });
});

test('сборка не пишет через ссылки назначения и не копирует ссылки источника', async () => {
  for (const target of ['dist', path.join('dist', 'src'), path.join('public', 'escape')]) {
    const root = await fixture();
    const outside = await fixture();
    if (target.startsWith(`dist${path.sep}`)) await mkdir(path.join(root, 'dist'));
    await symlink(outside, path.join(root, target), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(build({ root }), /ссылки|Небезопасный/);
    assert.equal(await readFile(path.join(outside, 'index.html'), 'utf8'), '<h1>Привет</h1>');
  }
});

test('сборка не перезаписывает файл через жёсткую ссылку', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'dist'));
  await link(path.join(root, 'private.txt'), path.join(root, 'dist', 'index.html'));
  await assert.rejects(build({ root }), /Небезопасный/);
  assert.equal(await readFile(path.join(root, 'private.txt'), 'utf8'), 'private');
});

test('сборка сообщает о незавершённом интерфейсе, public необязателен', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'limitless-empty-'));
  await assert.rejects(build({ root }), /index.html/);
  await writeFile(path.join(root, 'index.html'), 'ready');
  await assert.rejects(build({ root }), /src/);
  await mkdir(path.join(root, 'src'));
  assert.equal((await build({ root })).files, 1);
});

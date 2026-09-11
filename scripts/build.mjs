import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

async function inspect(filename) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function build({ root = projectRoot } = {}) {
  root = path.resolve(root);
  const output = path.join(root, 'dist');
  const files = new Map();
  const directories = new Set(['']);

  async function collect(source, relative, optional = false) {
    const stat = await inspect(source);
    if (!stat && optional) return;
    if (!stat) throw new Error(`Не найден обязательный источник: ${source}`);
    if (stat.isSymbolicLink()) throw new Error(`Символические ссылки не копируются: ${source}`);
    if (stat.isDirectory()) {
      if (files.has(relative)) throw new Error(`Конфликт путей сборки: ${relative}`);
      directories.add(relative);
      for (const name of await readdir(source)) {
        await collect(path.join(source, name), path.join(relative, name));
      }
    } else if (stat.isFile()) {
      // Case-insensitive matching also protects builds deployed on Windows.
      const key = relative.toLowerCase();
      if ([...files.keys(), ...directories].some(item => item.toLowerCase() === key)) {
        throw new Error(`Конфликт путей сборки: ${relative}`);
      }
      files.set(relative, source);
    } else {
      throw new Error(`Неподдерживаемый тип файла: ${source}`);
    }
  }

  const index = await inspect(path.join(root, 'index.html'));
  const src = await inspect(path.join(root, 'src'));
  if (!index?.isFile() || index.isSymbolicLink()) {
    throw new Error('Для сборки требуется обычный файл index.html');
  }
  if (!src?.isDirectory() || src.isSymbolicLink()) {
    throw new Error('Для сборки требуется каталог src без символической ссылки');
  }
  await collect(path.join(root, 'index.html'), 'index.html');
  await collect(path.join(root, 'src'), 'src');
  await collect(path.join(root, 'public'), '', true);

  // Preflight every destination before writes; never follow destination links.
  for (const relative of directories) {
    const stat = await inspect(path.join(output, relative));
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`Небезопасный каталог назначения: ${path.join(output, relative)}`);
    }
  }
  for (const relative of files.keys()) {
    const stat = await inspect(path.join(output, relative));
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) {
      throw new Error(`Небезопасный файл назначения: ${path.join(output, relative)}`);
    }
  }
  for (const relative of directories) {
    await mkdir(path.join(output, relative), { recursive: true });
  }
  for (const [relative, source] of files) {
    await copyFile(source, path.join(output, relative));
  }
  return { output, files: files.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await build();
    console.log(`Сборка готова: ${result.output} (${result.files} файлов)`);
  } catch (error) {
    console.error(`Ошибка сборки: ${error.message}`);
    process.exitCode = 1;
  }
}

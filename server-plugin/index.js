const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { version } = require('./package.json');

const CAPABILITIES = ['archive', 'open-folder'];

function isSinglePathSegment(value) {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && path.basename(value) === value
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

function uniqueDestination(directory, filename) {
  const extension = path.extname(filename);
  const base = path.basename(filename, extension);
  let candidate = path.join(directory, filename);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base}-${suffix}${extension}`);
    suffix += 1;
  }
  return candidate;
}

function resolveGalleryDirectory(imagesRoot, folder) {
  if (typeof imagesRoot !== 'string' || !isSinglePathSegment(folder)) return null;
  const resolvedRoot = path.resolve(imagesRoot);
  const directory = path.resolve(resolvedRoot, folder);
  const relative = path.relative(resolvedRoot, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return directory;
}

async function init(router) {
  router.get('/health', (_request, response) => {
    response.json({ ok: true, version, capabilities: CAPABILITIES });
  });

  router.post('/archive', async (request, response) => {
    try {
      const { folder, filename } = request.body ?? {};
      if (!isSinglePathSegment(folder) || !isSinglePathSegment(filename)) {
        return response.status(400).send('Invalid gallery folder or filename.');
      }

      const imagesRoot = request.user?.directories?.userImages;
      if (!imagesRoot) {
        return response.status(500).send('The user images directory is unavailable.');
      }

      const sourceDirectory = resolveGalleryDirectory(imagesRoot, folder);
      if (!sourceDirectory) {
        return response.status(400).send('Invalid gallery folder.');
      }
      const source = path.resolve(sourceDirectory, filename);
      const relativeSource = path.relative(sourceDirectory, source);
      if (relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) {
        return response.status(400).send('Invalid source path.');
      }

      const stat = await fs.promises.stat(source).catch(() => null);
      if (!stat?.isFile()) {
        return response.status(404).send('Gallery file not found.');
      }

      const archiveDirectory = path.join(sourceDirectory, 'deprecated');
      await fs.promises.mkdir(archiveDirectory, { recursive: true });
      const destination = uniqueDestination(archiveDirectory, filename);
      await fs.promises.rename(source, destination);

      return response.json({
        ok: true,
        filename: path.basename(destination),
        relativePath: path.join(folder, 'deprecated', path.basename(destination)).replaceAll('\\', '/'),
      });
    } catch (error) {
      console.error('[GalleryPlus] Failed to archive gallery image', error);
      return response.status(500).send('Failed to move the gallery file.');
    }
  });

  router.post('/open-folder', async (request, response) => {
    try {
      if (process.platform !== 'win32') {
        return response.status(501).send('Opening the source folder is only supported on Windows.');
      }

      const imagesRoot = request.user?.directories?.userImages;
      if (!imagesRoot) {
        return response.status(500).send('The user images directory is unavailable.');
      }

      const sourceDirectory = resolveGalleryDirectory(imagesRoot, request.body?.folder);
      if (!sourceDirectory) {
        return response.status(400).send('Invalid gallery folder.');
      }

      const stat = await fs.promises.stat(sourceDirectory).catch(() => null);
      if (!stat?.isDirectory()) {
        return response.status(404).send('Gallery folder not found.');
      }

      await new Promise((resolve, reject) => {
        const child = spawn('explorer.exe', [sourceDirectory], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });

      return response.sendStatus(204);
    } catch (error) {
      console.error('[GalleryPlus] Failed to open gallery source folder', error);
      return response.status(500).send('Failed to open the gallery source folder.');
    }
  });

  console.log('[GalleryPlus] Server plugin loaded');
  return Promise.resolve();
}

async function exit() {
  return Promise.resolve();
}

module.exports = {
  init,
  exit,
  info: {
    id: 'galleryplus',
    name: 'GalleryPlus',
    description: 'Organizes gallery images and opens gallery source folders.',
  },
  resolveGalleryDirectory,
  CAPABILITIES,
};


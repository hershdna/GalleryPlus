const fs = require('node:fs');
const path = require('node:path');

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

async function init(router) {
  router.get('/health', (_request, response) => {
    response.json({ ok: true });
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

      const sourceDirectory = path.resolve(imagesRoot, folder);
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
    description: 'Safely moves removed gallery images into a deprecated folder.',
  },
};


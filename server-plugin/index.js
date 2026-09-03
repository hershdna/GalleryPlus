const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { version } = require('./package.json');

const CAPABILITIES = ['archive', 'open-folder', 'external-media'];
const FRONTEND_FILES = ['manifest.json', 'index.js', 'style.css', 'settings.html'];
const EXTENSION_HOME_PAGE = 'https://github.com/theFisher86/GalleryPlus';
const USABLE_MEDIA_EXTENSIONS = new Set([
  '.bmp', '.gif', '.jfif', '.jpeg', '.jpg', '.png', '.webp',
  '.mov', '.mp4', '.webm',
]);
const externalMediaFiles = new Map();

async function findFrontendTarget(extensionsRoot) {
  const defaultTarget = path.join(extensionsRoot, 'GalleryPlus');
  const entries = await fs.promises.readdir(extensionsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extensionsRoot, entry.name);
    const manifestPath = path.join(candidate, 'manifest.json');
    try {
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      if (manifest?.display_name === 'GalleryPlus'
        || String(manifest?.homePage || '').replace(/\/$/, '') === EXTENSION_HOME_PAGE) {
        return candidate;
      }
    } catch {
      // Ignore unrelated or malformed extension manifests.
    }
  }
  return defaultTarget;
}

async function syncFrontendFiles(sourceRoot, sillyTavernRoot) {
  const sources = FRONTEND_FILES.map(file => path.join(sourceRoot, file));
  const sourceStats = await Promise.all(sources.map(source => fs.promises.stat(source).catch(() => null)));
  if (sourceStats.some(stat => !stat?.isFile())) return null;

  const extensionsRoot = path.join(
    sillyTavernRoot,
    'public',
    'scripts',
    'extensions',
    'third-party',
  );
  await fs.promises.mkdir(extensionsRoot, { recursive: true });
  const target = await findFrontendTarget(extensionsRoot);
  await fs.promises.mkdir(target, { recursive: true });
  await Promise.all(FRONTEND_FILES.map(file => (
    fs.promises.copyFile(path.join(sourceRoot, file), path.join(target, file))
  )));
  return target;
}

async function syncBundledFrontend() {
  const sourceRoot = path.resolve(__dirname, '..');
  const pluginsRoot = path.dirname(sourceRoot);
  if (path.basename(pluginsRoot).toLowerCase() !== 'plugins') return null;
  return syncFrontendFiles(sourceRoot, path.dirname(pluginsRoot));
}

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

function normalizeSourceAddress(value) {
  if (typeof value !== 'string') return null;
  let address = value.trim();
  if ((address.startsWith('"') && address.endsWith('"'))
    || (address.startsWith("'") && address.endsWith("'"))) {
    address = address.slice(1, -1).trim();
  }
  if (!address) return null;
  address = address.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
  if (address === '~') address = os.homedir();
  else if (address.startsWith(`~${path.sep}`) || address.startsWith('~/') || address.startsWith('~\\')) {
    address = path.join(os.homedir(), address.slice(2));
  }
  return path.resolve(address);
}

function isUsableMediaFile(filePath) {
  return USABLE_MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function mediaToken(filePath) {
  return crypto.createHash('sha256').update(filePath).digest('hex');
}

async function collectMediaFromDirectory(directory, files, limit) {
  if (files.length >= limit) return;
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (files.length >= limit) break;
    if (entry.isSymbolicLink()) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectMediaFromDirectory(candidate, files, limit);
    } else if (entry.isFile() && isUsableMediaFile(candidate)) {
      files.push(candidate);
    }
  }
}

async function collectExternalMedia(sources) {
  const files = [];
  const errors = [];
  const seen = new Set();

  for (const source of sources.slice(0, 100)) {
    const resolved = normalizeSourceAddress(source);
    if (!resolved) continue;
    const stat = await fs.promises.stat(resolved).catch(() => null);
    if (!stat) {
      errors.push({ source, message: 'Path not found.' });
      continue;
    }

    let candidates = [];
    if (stat.isFile()) {
      candidates = [resolved];
    } else if (stat.isDirectory()) {
      await collectMediaFromDirectory(resolved, candidates, 10000 - files.length);
    } else {
      errors.push({ source, message: 'Path is not a file or folder.' });
      continue;
    }

    for (const candidate of candidates) {
      if (files.length >= 10000) break;
      if (!isUsableMediaFile(candidate)) continue;
      const normalized = path.resolve(candidate);
      const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(normalized);
    }
  }

  const items = files.map((filePath) => {
    const token = mediaToken(filePath);
    externalMediaFiles.set(token, filePath);
    const name = path.basename(filePath);
    return {
      name,
      url: `/api/plugins/galleryplus/external-media/file/${token}${path.extname(name).toLowerCase()}`,
    };
  });
  return { items, errors };
}

async function init(router) {
  try {
    const frontendTarget = await syncBundledFrontend();
    if (frontendTarget) {
      console.log(`[GalleryPlus] Frontend synchronized to ${frontendTarget}`);
    }
  } catch (error) {
    console.error('[GalleryPlus] Failed to synchronize bundled frontend', error);
  }

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

  router.post('/external-media/list', async (request, response) => {
    try {
      const sources = request.body?.sources;
      if (!Array.isArray(sources) || sources.some(source => typeof source !== 'string')) {
        return response.status(400).send('External sources must be an array of file or folder addresses.');
      }
      return response.json(await collectExternalMedia(sources));
    } catch (error) {
      console.error('[GalleryPlus] Failed to list external media', error);
      return response.status(500).send('Failed to list external media.');
    }
  });

  const serveExternalMedia = async (tokenValue, response) => {
    const token = String(tokenValue || '');
    const filePath = externalMediaFiles.get(token);
    if (!/^[a-f0-9]{64}$/.test(token) || !filePath || !isUsableMediaFile(filePath)) {
      return response.sendStatus(404);
    }
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) return response.sendStatus(404);
    // The browser validates external files before adding them to the gallery.
    // A short private cache prevents that validation and thumbnail rendering
    // from reading the same large file twice.
    response.set('Cache-Control', 'private, max-age=300');
    return response.sendFile(filePath);
  };

  router.get('/external-media/file/:tokenFile', async (request, response) => {
    const match = String(request.params?.tokenFile || '').match(/^([a-f0-9]{64})\.[a-z0-9]+$/i);
    if (!match) return response.sendStatus(404);
    return serveExternalMedia(match[1].toLowerCase(), response);
  });

  // Keep links created by GalleryPlus 0.80 working until the gallery refreshes.
  router.get('/external-media/file/:token/:name', async (request, response) => {
    return serveExternalMedia(request.params?.token, response);
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
    description: 'Organizes galleries, opens source folders, and serves configured external media.',
  },
  resolveGalleryDirectory,
  CAPABILITIES,
  FRONTEND_FILES,
  syncFrontendFiles,
  normalizeSourceAddress,
  collectExternalMedia,
  externalMediaFiles,
};

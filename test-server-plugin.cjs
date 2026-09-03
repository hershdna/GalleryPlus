const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const plugin = require('./server-plugin');

(async () => {
  let archiveHandler;
  let openFolderHandler;
  let healthHandler;
  let externalListHandler;
  let externalFileHandler;
  let legacyExternalFileHandler;
  await plugin.init({
    get(route, handler) {
      if (route === '/health') healthHandler = handler;
      if (route === '/external-media/file/:tokenFile') externalFileHandler = handler;
      if (route === '/external-media/file/:token/:name') legacyExternalFileHandler = handler;
    },
    post(route, handler) {
      if (route === '/archive') archiveHandler = handler;
      if (route === '/open-folder') openFolderHandler = handler;
      if (route === '/external-media/list') externalListHandler = handler;
    },
  });
  assert.equal(typeof archiveHandler, 'function');
  assert.equal(typeof openFolderHandler, 'function');
  assert.equal(typeof healthHandler, 'function');
  assert.equal(typeof externalListHandler, 'function');
  assert.equal(typeof externalFileHandler, 'function');
  assert.equal(typeof legacyExternalFileHandler, 'function');
  const healthResult = { body: null };
  healthHandler({}, { json(bodyValue) { healthResult.body = bodyValue; } });
  assert.equal(healthResult.body.version, '1.4.1');
  assert.deepEqual(healthResult.body.capabilities, ['archive', 'open-folder', 'external-media']);

  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'galleryplus-'));
  const imagesRoot = path.join(testRoot, 'images');
  const sourceFolder = path.join(imagesRoot, 'Character');
  fs.mkdirSync(sourceFolder, { recursive: true });
  assert.equal(plugin.resolveGalleryDirectory(imagesRoot, 'Character'), sourceFolder);
  assert.equal(plugin.resolveGalleryDirectory(imagesRoot, '..'), null);
  assert.equal(plugin.resolveGalleryDirectory(imagesRoot, 'Character/elsewhere'), null);
  if (process.platform === 'win32') {
    assert.equal(plugin.normalizeSourceAddress('"E:\\Media\\clip.mp4"'), 'E:\\Media\\clip.mp4');
  }

  const invoke = async (body) => {
    const result = { status: 200, body: null };
    const response = {
      status(code) { result.status = code; return response; },
      send(bodyValue) { result.body = bodyValue; return response; },
      json(bodyValue) { result.body = bodyValue; return response; },
    };
    await archiveHandler({
      body,
      user: { directories: { userImages: imagesRoot } },
    }, response);
    return result;
  };

  try {
    const sillyTavernRoot = path.join(testRoot, 'SillyTavern');
    const existingExtension = path.join(
      sillyTavernRoot,
      'public',
      'scripts',
      'extensions',
      'third-party',
      'existing-galleryplus',
    );
    fs.mkdirSync(existingExtension, { recursive: true });
    fs.writeFileSync(path.join(existingExtension, 'manifest.json'), JSON.stringify({
      display_name: 'GalleryPlus',
      homePage: 'https://github.com/theFisher86/GalleryPlus',
    }));
    const syncedTarget = await plugin.syncFrontendFiles(__dirname, sillyTavernRoot);
    assert.equal(syncedTarget, existingExtension);
    for (const file of plugin.FRONTEND_FILES) {
      assert.equal(
        fs.readFileSync(path.join(syncedTarget, file), 'utf8'),
        fs.readFileSync(path.join(__dirname, file), 'utf8'),
      );
    }

    fs.writeFileSync(path.join(sourceFolder, 'image.png'), 'first');
    const first = await invoke({ folder: 'Character', filename: 'image.png' });
    assert.equal(first.status, 200);
    assert.equal(fs.existsSync(path.join(sourceFolder, 'image.png')), false);
    assert.equal(fs.readFileSync(path.join(sourceFolder, 'deprecated', 'image.png'), 'utf8'), 'first');

    fs.writeFileSync(path.join(sourceFolder, 'image.png'), 'second');
    const second = await invoke({ folder: 'Character', filename: 'image.png' });
    assert.equal(second.status, 200);
    assert.equal(second.body.filename, 'image-1.png');
    assert.equal(fs.readFileSync(path.join(sourceFolder, 'deprecated', 'image-1.png'), 'utf8'), 'second');

    const traversal = await invoke({ folder: '..', filename: 'image.png' });
    assert.equal(traversal.status, 400);

    const externalFolder = path.join(testRoot, 'outside');
    const nestedFolder = path.join(externalFolder, 'nested');
    fs.mkdirSync(nestedFolder, { recursive: true });
    fs.writeFileSync(path.join(externalFolder, 'photo.jpg'), 'photo');
    fs.writeFileSync(path.join(externalFolder, 'clip.webm'), 'clip');
    fs.writeFileSync(path.join(externalFolder, 'ignore.txt'), 'ignore');
    fs.writeFileSync(path.join(nestedFolder, 'movie.mp4'), 'movie');
    const directMovie = path.join(testRoot, 'direct.mov');
    fs.writeFileSync(directMovie, 'direct');

    const externalResult = { status: 200, body: null };
    const externalResponse = {
      status(code) { externalResult.status = code; return externalResponse; },
      send(bodyValue) { externalResult.body = bodyValue; return externalResponse; },
      json(bodyValue) { externalResult.body = bodyValue; return externalResponse; },
    };
    await externalListHandler({
      body: { sources: [externalFolder, directMovie, path.join(testRoot, 'missing')] },
    }, externalResponse);
    assert.equal(externalResult.status, 200);
    assert.deepEqual(
      externalResult.body.items.map(item => item.name).sort(),
      ['clip.webm', 'direct.mov', 'movie.mp4', 'photo.jpg'],
    );
    assert.equal(externalResult.body.errors.length, 1);
    assert.equal(externalResult.body.errors[0].message, 'Path not found.');

    const mediaItem = externalResult.body.items.find(item => item.name === 'movie.mp4');
    assert.match(mediaItem.url, /\/external-media\/file\/[a-f0-9]{64}\.mp4$/);
    const tokenFile = mediaItem.url.split('/').at(-1);
    const served = { status: 200, path: '', cache: '' };
    const fileResponse = {
      sendStatus(code) { served.status = code; return fileResponse; },
      set(name, value) { if (name === 'Cache-Control') served.cache = value; return fileResponse; },
      sendFile(filePath) { served.path = filePath; return fileResponse; },
    };
    await externalFileHandler({ params: { tokenFile } }, fileResponse);
    assert.equal(served.path, path.join(nestedFolder, 'movie.mp4'));
    assert.equal(served.cache, 'private, max-age=300');
    console.log('server plugin archive and external-media tests passed');
  } finally {
    const resolved = path.resolve(testRoot);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})();

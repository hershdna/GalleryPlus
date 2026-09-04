import { FAVORITES_CHANGED_EVENT, gpFavoriteGalleryKey, gpFavoriteIdentity, gpGetFavoriteSet, gpSettings, gpSaveSettings, gpToggleFavorite } from './settings.js';

const CUSTOM_SORT = 'custom';
const ARCHIVE_ENDPOINT = '/api/plugins/galleryplus/archive';
const OPEN_FOLDER_ENDPOINT = '/api/plugins/galleryplus/open-folder';
const EXTERNAL_LIST_ENDPOINT = '/api/plugins/galleryplus/external-media/list';
const EXTERNAL_FILE_PREFIX = '/api/plugins/galleryplus/external-media/file/';
const SERVER_HEALTH_ENDPOINT = '/api/plugins/galleryplus/health';
const IMAGE_FILE_TYPES = ['bmp', 'gif', 'jfif', 'jpeg', 'jpg', 'png', 'webp'];
const VIDEO_FILE_TYPES = ['mov', 'mp4', 'webm'];
const SUPPORTED_FILE_TYPES = [...IMAGE_FILE_TYPES, ...VIDEO_FILE_TYPES];
const EXTERNAL_CACHE_TTL_MS = 5000;
const EXTERNAL_VALIDATION_BATCH_SIZE = 12;
const EXTERNAL_MEDIA_TIMEOUT_MS = 10000;
const EXTERNAL_STATUS_EVENT = 'galleryplus:external-media-status';
const PAGINATION_ICON_SELECTOR = [
  '.nGY2paginationRectangle',
  '.nGY2paginationRectangleCurrentPage',
  '.nGY2paginationDot',
  '.nGY2paginationDotCurrentPage',
  '.nGY2paginationItem',
  '.nGY2paginationItemCurrentPage',
].join(',');
const VIDEO_THUMBNAIL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent([
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 150">',
  '<rect width="240" height="150" fill="#171717"/>',
  '<path d="M96 46v58l53-29z" fill="#eee"/>',
  '</svg>',
].join(''));
let archiveModeActive = false;
let fetchHookInstalled = false;
let externalItemSequence = 0;
const externalEntriesByName = new Map();
const externalMediaCache = new Map();
const externalMediaLoads = new Map();
const externalMediaStatus = new Map();
const externalGallerySyncTimers = new Map();
const externalValidationCache = new Map();

export function installCustomOrderFetchHook() {
  if (fetchHookInstalled) return;
  fetchHookInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function galleryPlusFetch(input, init) {
    let effectiveInit = init;
    let pathname = '';
    let requestBody = null;
    try {
      const url = typeof input === 'string' ? input : input?.url;
      pathname = new URL(url, location.href).pathname;
      if (pathname === '/api/images/list' && typeof init?.body === 'string') {
        requestBody = JSON.parse(init.body);
        effectiveInit = {
          ...init,
          body: JSON.stringify({ ...requestBody, type: 0b011 }),
        };
      }
    } catch (error) {
      console.warn('[GalleryPlus] Could not add videos to gallery request', error);
    }

    const response = await nativeFetch(input, effectiveInit);
    try {
      if (pathname !== '/api/images/list' || !response.ok) {
        return response;
      }

      const body = requestBody
        ?? (typeof effectiveInit?.body === 'string' ? JSON.parse(effectiveInit.body) : null);
      const folder = typeof body?.folder === 'string' ? body.folder : '';
      if (!folder) return response;

      const files = await response.clone().json();
      if (!Array.isArray(files)) return response;

      const localFiles = files.map(String);
      const sources = getExternalSources(folder);
      if (sources.length) {
        const cached = getExternalMediaCache(folder, sources);
        if (!cached || Date.now() - cached.checkedAt >= EXTERNAL_CACHE_TTL_MS) {
          void loadExternalMediaInBackground(folder, sources, nativeFetch);
        }
      } else if (externalMediaCache.has(folder)) {
        externalMediaCache.delete(folder);
        queueOpenGalleryExternalSync(folder, []);
      }

      // External entries must never be returned here. SillyTavern waits for every
      // returned item (including video thumbnail generation) before creating the
      // gallery window. They are validated and inserted progressively instead.
      const filtered = filterFilesByType(folder, localFiles);
      const result = getGallerySort() === CUSTOM_SORT
        ? applyStoredOrder(folder, filtered, sources.length > 0 || !areAllFileTypesEnabled(folder))
        : filtered;
      if (sameList(files.map(String), result)) return response;
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(result), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      console.warn('[GalleryPlus] Could not apply custom gallery order', error);
      return response;
    }
  };
}

export function getCachedExternalGalleryPaths(folder) {
  const sources = getExternalSources(folder);
  const cached = getExternalMediaCache(folder, sources);
  return cached ? getVisibleExternalItems(folder, cached.items).map(item => item.galleryPath) : [];
}

export function wireGallery(root) {
  if (!(root instanceof HTMLElement) || root.dataset.gpGalleryWired === '1') return;

  const sortSelect = root.querySelector('.gallery-sort-select');
  const gallery = root.querySelector('#dragGallery');
  if (!(sortSelect instanceof HTMLSelectElement) || !(gallery instanceof HTMLElement)) return;

  root.dataset.gpGalleryWired = '1';
  ensureCustomSortOption(sortSelect);
  installOpenFolderControl(root);
  installExternalSourcesControl(root);
  installFileTypeFilterControl(root, sortSelect);
  installGalleryFavorites(root, gallery);
  installArchiveControl(root, gallery, sortSelect);
  installReordering(root, gallery, sortSelect);
  disableGalleryPageSwipe(root, gallery);
  installPaginationScrubbing(root, gallery);
  installFailedMediaHandling(root, gallery);
  updateCustomOrderHint(root, sortSelect);

  const folder = getGalleryFolder(root);
  const sources = getExternalSources(folder);
  const cached = getExternalMediaCache(folder, sources);
  if (cached) queueOpenGalleryExternalSync(folder, getVisibleExternalItems(folder, cached.items));
  const currentStatus = externalMediaStatus.get(folder);
  if (currentStatus) applyExternalMediaStatus(root, currentStatus);

  sortSelect.addEventListener('change', () => updateCustomOrderHint(root, sortSelect));
}

function getThumbnailFavoriteSource(root, thumbnail) {
  const filename = getThumbnailFilename(thumbnail);
  if (!filename) return '';

  const visibleSource = thumbnail.querySelector('img, video')?.src || '';
  const visibleFilename = filenameFromSource(visibleSource);
  if (visibleSource && !visibleSource.startsWith('data:')
    && (isExternalGalleryPath(filename) || visibleFilename === filename)) {
    return visibleSource;
  }

  const folder = getGalleryFolder(root);
  try {
    const base = new URL(`/user/images/${encodeURIComponent(folder)}/`, location.origin);
    return isExternalGalleryPath(filename)
      ? new URL(filename, base).href
      : new URL(encodeURIComponent(filename), base).href;
  } catch {
    return filename;
  }
}

function installGalleryFavorites(root, gallery) {
  const refresh = () => {
    const folder = getGalleryFolder(root);
    const favorites = gpGetFavoriteSet(folder);
    gallery.querySelectorAll('.nGY2GThumbnail').forEach((thumbnail) => {
      if (!(thumbnail instanceof HTMLElement)) return;
      let button = thumbnail.querySelector(':scope > .gp-thumbnail-favorite');
      if (!(button instanceof HTMLButtonElement)) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'gp-thumbnail-favorite';
        button.draggable = false;
        thumbnail.appendChild(button);
      }
      const source = getThumbnailFavoriteSource(root, thumbnail);
      const favorite = Boolean(source) && favorites.has(gpFavoriteIdentity(source));
      const icon = favorite ? '★' : '☆';
      if (button.textContent !== icon) button.textContent = icon;
      button.classList.toggle('active', favorite);
      button.setAttribute('aria-pressed', String(favorite));
      button.setAttribute('aria-label', favorite ? 'Remove from favorites' : 'Add to favorites');
      button.title = favorite ? 'Remove from favorites' : 'Add to favorites';
    });
  };

  gallery.addEventListener('click', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest('.gp-thumbnail-favorite')
      : null;
    if (!(button instanceof HTMLButtonElement) || !gallery.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const thumbnail = button.closest('.nGY2GThumbnail');
    if (!(thumbnail instanceof HTMLElement)) return;
    const source = getThumbnailFavoriteSource(root, thumbnail);
    if (source) gpToggleFavorite(getGalleryFolder(root), source);
  }, true);

  const onFavoritesChanged = (event) => {
    if (event.detail?.galleryKey !== gpFavoriteGalleryKey(getGalleryFolder(root))) return;
    refresh();
  };
  document.addEventListener(FAVORITES_CHANGED_EVENT, onFavoritesChanged);

  const galleryObserver = new MutationObserver(refresh);
  galleryObserver.observe(gallery, { childList: true, subtree: true });
  refresh();

  const lifecycleObserver = new MutationObserver(() => {
    if (document.body.contains(root)) return;
    galleryObserver.disconnect();
    document.removeEventListener(FAVORITES_CHANGED_EVENT, onFavoritesChanged);
    lifecycleObserver.disconnect();
  });
  lifecycleObserver.observe(document.body, { childList: true, subtree: true });
}

function disableGalleryPageSwipe(root, gallery, attempt = 0) {
  if (!root.isConnected) return;

  const jq = window.jQuery;
  const plugin = typeof jq === 'function' ? jq(gallery)?.data?.('nanogallery2data') : null;
  const options = plugin?.options;
  const runtimeOptions = plugin?.nG2?.O;
  if (options || runtimeOptions) {
    if (options) {
      options.paginationSwipe = false;
      options.galleryNavigationOverlayButtons = false;
    }
    if (runtimeOptions) {
      runtimeOptions.paginationSwipe = false;
      runtimeOptions.galleryNavigationOverlayButtons = false;
    }
    root.dataset.gpPageSwipeDisabled = '1';
    return;
  }

  // GalleryPlus can wire the window just before nanogallery finishes starting.
  // Retry briefly so only the pagination icons change pages; thumbnail clicks
  // and GalleryPlus drag-to-reorder remain untouched.
  if (attempt < 50) {
    setTimeout(() => disableGalleryPageSwipe(root, gallery, attempt + 1), 100);
  }
}

function getPaginationPageNumber(gallery, icon) {
  const jq = window.jQuery;
  const stored = typeof jq === 'function' ? jq(icon)?.data?.('pageNumber') : undefined;
  const pageNumber = Number(stored ?? icon.dataset.pageNumber);
  if (Number.isFinite(pageNumber)) return pageNumber;
  return [...gallery.querySelectorAll(PAGINATION_ICON_SELECTOR)].indexOf(icon);
}

function installPaginationScrubbing(root, gallery) {
  if (gallery.dataset.gpPaginationScrubbing === '1') return;
  gallery.dataset.gpPaginationScrubbing = '1';

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let lastPage = null;
  let moved = false;
  let suppressNextClick = false;

  const paginationIconFromPoint = (x, y) => {
    const target = document.elementFromPoint(x, y);
    const icon = target instanceof Element ? target.closest(PAGINATION_ICON_SELECTOR) : null;
    return icon instanceof HTMLElement && gallery.contains(icon) ? icon : null;
  };

  const stopScrubbing = (event) => {
    if (pointerId === null || (event && event.pointerId !== pointerId)) return;
    pointerId = null;
    lastPage = null;
    root.classList.remove('gp-pagination-scrubbing');
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', stopScrubbing, true);
    document.removeEventListener('pointercancel', stopScrubbing, true);
    if (moved) {
      suppressNextClick = true;
      setTimeout(() => { suppressNextClick = false; }, 0);
    }
  };

  const onPointerMove = (event) => {
    if (event.pointerId !== pointerId) return;
    if (!moved && Math.hypot(event.clientX - startX, event.clientY - startY) < 4) return;
    moved = true;
    root.classList.add('gp-pagination-scrubbing');
    const icon = paginationIconFromPoint(event.clientX, event.clientY);
    if (!icon) return;
    const pageNumber = getPaginationPageNumber(gallery, icon);
    if (pageNumber < 0 || pageNumber === lastPage) return;
    lastPage = pageNumber;
    event.preventDefault();
    icon.click();
  };

  gallery.addEventListener('pointerdown', (event) => {
    const icon = event.target instanceof Element ? event.target.closest(PAGINATION_ICON_SELECTOR) : null;
    if (!(icon instanceof HTMLElement) || !gallery.contains(icon)) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    lastPage = getPaginationPageNumber(gallery, icon);
    moved = false;
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
    document.addEventListener('pointerup', stopScrubbing, true);
    document.addEventListener('pointercancel', stopScrubbing, true);
  });

  gallery.addEventListener('click', (event) => {
    if (!suppressNextClick || !event.isTrusted) return;
    const icon = event.target instanceof Element ? event.target.closest(PAGINATION_ICON_SELECTOR) : null;
    if (!icon) return;
    suppressNextClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function installOpenFolderControl(root) {
  const folderInput = root.querySelector('.gallery-folder-input');
  const topBar = folderInput?.parentElement;
  if (!(topBar instanceof HTMLElement) || topBar.querySelector('.gp-open-folder')) return;

  const button = document.createElement('div');
  button.className = 'right_menu_button fa-solid fa-folder-open fa-fw gp-open-folder';
  button.title = 'Open source folder in Windows Explorer';
  button.setAttribute('role', 'button');
  button.setAttribute('aria-label', button.title);
  button.setAttribute('tabindex', '0');

  const openFolder = async () => {
    if (button.classList.contains('gp-busy')) return;
    const folder = getGalleryFolder(root);
    if (!folder) {
      notify('error', 'Choose a gallery folder first.');
      return;
    }

    button.classList.add('gp-busy');
    try {
      const response = await fetch(OPEN_FOLDER_ENDPOINT, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ folder }),
      });
      if (!response.ok) {
        throw new Error(await getServerError(
          response,
          'open-folder',
          `Could not open the folder (status ${response.status}).`,
        ));
      }
      notify('success', `Opened the "${folder}" source folder.`);
    } catch (error) {
      console.error('[GalleryPlus] Failed to open gallery source folder', error);
      notify('error', error?.message || 'Failed to open the gallery source folder.');
    } finally {
      button.classList.remove('gp-busy');
    }
  };

  button.addEventListener('click', openFolder);
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openFolder();
  });

  const folderAccept = topBar.querySelector('.fa-check');
  if (folderAccept) folderAccept.insertAdjacentElement('afterend', button);
  else topBar.appendChild(button);
}

function installExternalSourcesControl(root) {
  const folderInput = root.querySelector('.gallery-folder-input');
  const topBar = folderInput?.parentElement;
  if (!(topBar instanceof HTMLElement) || topBar.querySelector('.gp-external-sources-button')) return;

  const button = document.createElement('div');
  button.className = 'right_menu_button fa-solid fa-link fa-fw gp-external-sources-button';
  button.title = 'Open external files and folders';
  button.setAttribute('role', 'button');
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('tabindex', '0');

  const dialog = document.createElement('dialog');
  dialog.className = 'gp-external-sources-window';
  dialog.setAttribute('aria-labelledby', 'gp-external-sources-title');

  const panel = document.createElement('div');
  panel.className = 'gp-external-sources-panel';

  const header = document.createElement('div');
  header.className = 'gp-external-sources-header';
  const heading = document.createElement('strong');
  heading.id = 'gp-external-sources-title';
  heading.textContent = 'External files and folders';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'gp-external-sources-close';
  closeButton.title = 'Close';
  closeButton.setAttribute('aria-label', 'Close external files and folders');
  closeButton.textContent = '×';
  header.append(heading, closeButton);
  panel.appendChild(header);

  const label = document.createElement('div');
  label.className = 'gp-external-sources-label';
  label.textContent = 'File and folder addresses';

  const sourcesList = document.createElement('div');
  sourcesList.className = 'gp-external-sources-list';
  label.appendChild(sourcesList);

  const addSourceButton = document.createElement('button');
  addSourceButton.type = 'button';
  addSourceButton.className = 'menu_button gp-external-source-add';
  addSourceButton.textContent = 'Add address';
  label.appendChild(addSourceButton);
  panel.appendChild(label);

  const help = document.createElement('small');
  help.className = 'gp-external-sources-help';
  help.textContent = 'Uncheck an address to keep it saved but omit its files. Folders include supported images and videos in all subfolders; files remain in their original locations.';
  panel.appendChild(help);

  const status = document.createElement('div');
  status.className = 'gp-external-sources-status';
  status.setAttribute('aria-live', 'polite');
  panel.appendChild(status);

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'menu_button gp-external-sources-save';
  saveButton.textContent = 'Apply';
  panel.appendChild(saveButton);
  dialog.appendChild(panel);
  document.body.appendChild(dialog);

  const closeWindow = () => {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else {
      dialog.removeAttribute('open');
      button.classList.remove('active');
      button.setAttribute('aria-expanded', 'false');
    }
  };
  const onExternalMediaStatus = (event) => {
    if (event.detail?.folder !== getGalleryFolder(root)) return;
    applyExternalMediaStatus(root, event.detail, status);
  };
  window.addEventListener(EXTERNAL_STATUS_EVENT, onExternalMediaStatus);

  const addSourceRow = (entry = { address: '', enabled: true }) => {
    const row = document.createElement('div');
    row.className = 'gp-external-source-row';

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'gp-external-source-enabled';
    enabled.checked = entry.enabled !== false;
    enabled.title = 'Enable this address';
    enabled.setAttribute('aria-label', 'Enable this external address');

    const address = document.createElement('input');
    address.type = 'text';
    address.className = 'gp-external-source-address text_pole';
    address.value = entry.address || '';
    address.placeholder = 'File or folder address';
    address.spellcheck = false;
    address.setAttribute('aria-label', 'External file or folder address');
    address.addEventListener('paste', (event) => {
      const values = event.clipboardData?.getData('text')
        .split(/\r?\n/)
        .map(value => value.trim())
        .filter(Boolean) || [];
      if (values.length < 2) return;
      event.preventDefault();
      address.value = values.shift();
      values.forEach(value => addSourceRow({ address: value, enabled: true }));
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'gp-external-source-remove';
    remove.textContent = '×';
    remove.title = 'Remove address';
    remove.setAttribute('aria-label', 'Remove external address');
    remove.addEventListener('click', () => {
      row.remove();
      if (!sourcesList.children.length) addSourceRow();
    });

    row.append(enabled, address, remove);
    sourcesList.appendChild(row);
    return address;
  };

  const renderSourceRows = (entries) => {
    sourcesList.replaceChildren();
    const values = entries.length ? entries : [{ address: '', enabled: true }];
    values.forEach(addSourceRow);
  };

  const readSourceRows = () => {
    const entries = [];
    const seen = new Set();
    sourcesList.querySelectorAll('.gp-external-source-row').forEach((row) => {
      const address = row.querySelector('.gp-external-source-address')?.value?.trim() || '';
      if (!address || seen.has(address)) return;
      seen.add(address);
      entries.push({
        address,
        enabled: row.querySelector('.gp-external-source-enabled')?.checked !== false,
      });
    });
    return entries;
  };

  addSourceButton.addEventListener('click', () => addSourceRow().focus());
  const openWindow = () => {
    document.querySelectorAll('.gp-file-types-window[open]').forEach((fileTypes) => {
      if (typeof fileTypes.close === 'function') fileTypes.close();
      else fileTypes.removeAttribute('open');
    });
    const folder = getGalleryFolder(root);
    const entries = getExternalSourceEntries(folder);
    renderSourceRows(entries);
    const enabledCount = entries.filter(entry => entry.enabled).length;
    status.textContent = folder
      ? `${enabledCount} of ${entries.length} saved address${entries.length === 1 ? '' : 'es'} enabled.`
      : 'Choose a gallery folder first.';
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    button.classList.add('active');
    button.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => sourcesList.querySelector('.gp-external-source-address')?.focus());
  };

  button.addEventListener('click', openWindow);
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openWindow();
  });
  closeButton.addEventListener('click', closeWindow);
  dialog.addEventListener('close', () => {
    button.classList.remove('active');
    button.setAttribute('aria-expanded', 'false');
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeWindow();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeWindow();
  });
  dialog.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.target === dialog) closeWindow();
  });
  ['pointerdown', 'mousedown', 'mouseup'].forEach((eventName) => {
    dialog.addEventListener(eventName, event => event.stopPropagation());
  });
  saveButton.addEventListener('click', () => {
    if (saveButton.disabled) return;
    const folder = getGalleryFolder(root);
    if (!folder) {
      status.textContent = 'Choose a gallery folder first.';
      return;
    }

    const entries = readSourceRows();
    const sources = entries.filter(entry => entry.enabled).map(entry => entry.address);
    try {
      saveExternalSourceEntries(folder, entries);
      externalMediaCache.delete(folder);
      closeWindow();
      if (sources.length) {
        notify('info', 'External sources saved. Media is loading in the background.');
        void loadExternalMediaInBackground(folder, sources, window.fetch, true);
      } else {
        queueOpenGalleryExternalSync(folder, []);
        publishExternalMediaStatus(folder, { loading: false, count: 0, errors: [] });
        notify('success', entries.length
          ? 'External gallery addresses saved; all are disabled.'
          : 'External gallery sources cleared.');
      }
    } catch (error) {
      console.error('[GalleryPlus] Failed to update external gallery sources', error);
      status.textContent = error?.message || 'Could not read the external sources.';
      notify('error', status.textContent);
    }
  });

  const openFolderButton = topBar.querySelector('.gp-open-folder');
  if (openFolderButton) openFolderButton.insertAdjacentElement('afterend', button);
  else topBar.appendChild(button);

  const lifecycleObserver = new MutationObserver(() => {
    if (document.body.contains(root)) return;
    closeWindow();
    dialog.remove();
    window.removeEventListener(EXTERNAL_STATUS_EVENT, onExternalMediaStatus);
    lifecycleObserver.disconnect();
  });
  lifecycleObserver.observe(document.body, { childList: true, subtree: true });
}

function installFileTypeFilterControl(root, sortSelect) {
  const folderInput = root.querySelector('.gallery-folder-input');
  const topBar = folderInput?.parentElement;
  if (!(topBar instanceof HTMLElement) || topBar.querySelector('.gp-file-types-button')) return;

  const button = document.createElement('div');
  button.className = 'right_menu_button fa-solid fa-filter fa-fw gp-file-types-button';
  button.title = 'Choose gallery and slideshow file types';
  button.setAttribute('role', 'button');
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('tabindex', '0');

  const dialog = document.createElement('dialog');
  dialog.className = 'gp-file-types-window';
  dialog.setAttribute('aria-labelledby', 'gp-file-types-title');

  const panel = document.createElement('div');
  panel.className = 'gp-file-types-panel';

  const header = document.createElement('div');
  header.className = 'gp-file-types-header';
  const heading = document.createElement('strong');
  heading.id = 'gp-file-types-title';
  heading.textContent = 'Visible file types';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'gp-file-types-close';
  closeButton.title = 'Close';
  closeButton.setAttribute('aria-label', 'Close file type filters');
  closeButton.textContent = '×';
  header.append(heading, closeButton);
  panel.appendChild(header);

  const groups = document.createElement('div');
  groups.className = 'gp-file-types-groups';
  const inputs = new Map();
  for (const [name, types] of [['Images', IMAGE_FILE_TYPES], ['Videos', VIDEO_FILE_TYPES]]) {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = name;
    fieldset.appendChild(legend);
    types.forEach((type) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = type;
      input.className = 'gp-file-type-checkbox';
      label.appendChild(input);
      label.append(` .${type}`);
      inputs.set(type, input);
      fieldset.appendChild(label);
    });
    groups.appendChild(fieldset);
  }
  panel.appendChild(groups);

  const status = document.createElement('div');
  status.className = 'gp-file-types-status';
  status.setAttribute('aria-live', 'polite');
  panel.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'gp-file-types-actions';
  const allButton = document.createElement('button');
  allButton.type = 'button';
  allButton.className = 'menu_button';
  allButton.textContent = 'All';
  const noneButton = document.createElement('button');
  noneButton.type = 'button';
  noneButton.className = 'menu_button';
  noneButton.textContent = 'None';
  const applyButton = document.createElement('button');
  applyButton.type = 'button';
  applyButton.className = 'menu_button gp-file-types-apply';
  applyButton.textContent = 'Apply';
  actions.append(allButton, noneButton, applyButton);
  panel.appendChild(actions);
  dialog.appendChild(panel);
  document.body.appendChild(dialog);

  const updateStatus = () => {
    const count = [...inputs.values()].filter(input => input.checked).length;
    status.textContent = `${count} of ${SUPPORTED_FILE_TYPES.length} file types selected`;
  };
  const setAll = (checked) => {
    inputs.forEach(input => { input.checked = checked; });
    updateStatus();
  };
  const closeWindow = () => {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else {
      dialog.removeAttribute('open');
      button.classList.remove('active');
      button.setAttribute('aria-expanded', 'false');
    }
  };
  const openWindow = () => {
    document.querySelectorAll('.gp-external-sources-window[open]').forEach((externalWindow) => {
      if (typeof externalWindow.close === 'function') externalWindow.close();
      else externalWindow.removeAttribute('open');
    });
    const folder = getGalleryFolder(root);
    const enabled = new Set(getEnabledFileTypes(folder));
    inputs.forEach((input, type) => { input.checked = enabled.has(type); });
    updateStatus();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    button.classList.add('active');
    button.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => inputs.values().next().value?.focus());
  };

  button.addEventListener('click', openWindow);
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openWindow();
  });
  closeButton.addEventListener('click', closeWindow);
  dialog.addEventListener('close', () => {
    button.classList.remove('active');
    button.setAttribute('aria-expanded', 'false');
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeWindow();
  });
  dialog.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.target === dialog) closeWindow();
  });
  ['pointerdown', 'mousedown', 'mouseup'].forEach((eventName) => {
    dialog.addEventListener(eventName, event => event.stopPropagation());
  });
  inputs.forEach(input => input.addEventListener('change', updateStatus));
  allButton.addEventListener('click', () => setAll(true));
  noneButton.addEventListener('click', () => setAll(false));
  applyButton.addEventListener('click', () => {
    const folder = getGalleryFolder(root);
    if (!folder) {
      notify('error', 'Choose a gallery folder first.');
      return;
    }
    const enabled = SUPPORTED_FILE_TYPES.filter(type => inputs.get(type)?.checked);
    saveEnabledFileTypes(folder, enabled);
    closeWindow();
    notify('success', `Showing ${enabled.length} of ${SUPPORTED_FILE_TYPES.length} file types.`);
    setTimeout(() => {
      if (sortSelect.isConnected) refreshGallery(sortSelect);
    }, 0);
  });

  const externalSources = topBar.querySelector('.gp-external-sources-button');
  if (externalSources) externalSources.insertAdjacentElement('afterend', button);
  else topBar.appendChild(button);

  const lifecycleObserver = new MutationObserver(() => {
    if (document.body.contains(root)) return;
    closeWindow();
    dialog.remove();
    lifecycleObserver.disconnect();
  });
  lifecycleObserver.observe(document.body, { childList: true, subtree: true });
}

function getEnabledFileTypes(folder) {
  const filters = gpSettings().fileTypeFilters;
  if (!folder || !filters || !Object.prototype.hasOwnProperty.call(filters, folder)) {
    return [...SUPPORTED_FILE_TYPES];
  }
  const stored = filters[folder];
  if (!Array.isArray(stored)) return [...SUPPORTED_FILE_TYPES];
  const enabled = new Set(stored.map(type => String(type).toLowerCase()));
  return SUPPORTED_FILE_TYPES.filter(type => enabled.has(type));
}

function saveEnabledFileTypes(folder, enabled) {
  if (!folder) return;
  const fileTypeFilters = { ...(gpSettings().fileTypeFilters || {}), [folder]: [...enabled] };
  gpSaveSettings({ fileTypeFilters });
}

function areAllFileTypesEnabled(folder) {
  return getEnabledFileTypes(folder).length === SUPPORTED_FILE_TYPES.length;
}

function getFileExtension(file) {
  try {
    const pathname = new URL(String(file), location.href).pathname;
    const name = decodeURIComponent(pathname.split('/').pop() || '');
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  } catch {
    const clean = String(file).split(/[?#]/, 1)[0];
    const dot = clean.lastIndexOf('.');
    return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
  }
}

function filterFilesByType(folder, files) {
  const enabled = new Set(getEnabledFileTypes(folder));
  return files.filter(file => enabled.has(getFileExtension(file)));
}

function getExternalSources(folder) {
  return getExternalSourceEntries(folder)
    .filter(entry => entry.enabled)
    .map(entry => entry.address);
}

function getExternalSourceEntries(folder) {
  const stored = gpSettings().externalSources?.[folder];
  if (!Array.isArray(stored)) return [];
  const entries = [];
  const seen = new Set();
  stored.forEach((value) => {
    const address = typeof value === 'string'
      ? value.trim()
      : (typeof value?.address === 'string' ? value.address.trim() : '');
    if (!address || seen.has(address)) return;
    seen.add(address);
    entries.push({ address, enabled: typeof value === 'string' || value.enabled !== false });
  });
  return entries;
}

function saveExternalSourceEntries(folder, entries) {
  if (!folder) return;
  const externalSources = { ...(gpSettings().externalSources || {}) };
  if (entries.length) externalSources[folder] = entries.map(entry => ({
    address: entry.address,
    enabled: entry.enabled !== false,
  }));
  else delete externalSources[folder];
  gpSaveSettings({ externalSources });
}

async function fetchExternalMedia(sources, fetchImpl = window.fetch, diagnose = false) {
  const response = await fetchImpl(EXTERNAL_LIST_ENDPOINT, {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({ sources }),
  });
  if (!response.ok) {
    const message = diagnose
      ? await getServerError(response, 'external-media', `Could not read external media (status ${response.status}).`)
      : `Could not read external media (status ${response.status}).`;
    throw new Error(message);
  }
  const payload = await response.json();
  return {
    items: Array.isArray(payload?.items) ? payload.items : [],
    errors: Array.isArray(payload?.errors) ? payload.errors : [],
  };
}

function getExternalSourceSignature(sources) {
  return JSON.stringify(sources);
}

function getExternalMediaCache(folder, sources) {
  const cached = externalMediaCache.get(folder);
  return cached?.signature === getExternalSourceSignature(sources) ? cached : null;
}

function getVisibleExternalItems(folder, items) {
  const enabled = new Set(getEnabledFileTypes(folder));
  return items.filter(item => enabled.has(getFileExtension(item.galleryPath)));
}

function publishExternalMediaStatus(folder, detail) {
  const next = { folder, ...detail };
  externalMediaStatus.set(folder, next);
  window.dispatchEvent(new CustomEvent(EXTERNAL_STATUS_EVENT, { detail: next }));
}

function applyExternalMediaStatus(root, detail, dialogStatus = null) {
  const button = root.querySelector('.gp-external-sources-button');
  if (!(button instanceof HTMLElement)) return;
  button.classList.toggle('gp-busy', Boolean(detail.loading));
  button.setAttribute('aria-busy', String(Boolean(detail.loading)));
  button.title = detail.loading
    ? 'External media is loading in the background'
    : 'Open external files and folders';

  if (!(dialogStatus instanceof HTMLElement)) return;
  if (detail.loading) {
    const progress = Number.isFinite(detail.checked) && Number.isFinite(detail.total)
      ? ` ${detail.checked} of ${detail.total} checked; ${detail.count ?? 0} available.`
      : '';
    dialogStatus.textContent = `Loading media in the background…${progress}`;
  } else if (detail.error) {
    dialogStatus.textContent = detail.error;
  } else {
    dialogStatus.textContent = `${detail.count ?? 0} external media file${detail.count === 1 ? '' : 's'} found.`;
  }
}

async function loadExternalMediaInBackground(folder, sources, fetchImpl, diagnose = false) {
  const signature = getExternalSourceSignature(sources);
  const loadKey = `${folder}\n${signature}`;
  let load = externalMediaLoads.get(loadKey);

  if (!load) {
    publishExternalMediaStatus(folder, { loading: true });
    load = (async () => {
      try {
        const external = await fetchExternalMedia(sources, fetchImpl, true);
        if (getExternalSourceSignature(getExternalSources(folder)) !== signature) return null;
        const rawItems = external.items.map(item => ({
          ...item,
          galleryPath: externalItemToGalleryPath(item),
        })).filter(item => item.galleryPath);
        return await validateExternalMediaProgressively(folder, signature, rawItems, external.errors);
      } catch (error) {
        console.warn('[GalleryPlus] Could not add external media to gallery', error);
        if (getExternalSourceSignature(getExternalSources(folder)) === signature) {
          publishExternalMediaStatus(folder, {
            loading: false,
            error: error?.message || 'Could not read the external sources.',
          });
        }
        return null;
      } finally {
        externalMediaLoads.delete(loadKey);
      }
    })();
    externalMediaLoads.set(loadKey, load);
  }

  const result = await load;
  if (diagnose) reportExternalMediaResult(result);
  return result;
}

async function validateExternalMediaProgressively(folder, signature, rawItems, sourceErrors) {
  const previous = externalMediaCache.get(folder);
  const sourcePaths = rawItems.map(item => item.galleryPath);
  if (previous?.signature === signature
    && previous.complete
    && sameList(previous.sourcePaths || [], sourcePaths)) {
    const cached = { ...previous, checkedAt: Date.now() };
    externalMediaCache.set(folder, cached);
    queueOpenGalleryExternalSync(folder, getVisibleExternalItems(folder, cached.items));
    publishExternalMediaStatus(folder, {
      loading: false,
      count: getVisibleExternalItems(folder, cached.items).length,
      errors: cached.errors,
    });
    return cached;
  }

  const availablePaths = new Set(sourcePaths);
  const validPaths = new Set((previous?.signature === signature ? previous.items : [])
    .map(item => item.galleryPath)
    .filter(path => availablePaths.has(path)));
  const failed = [];

  for (let start = 0; start < rawItems.length; start += EXTERNAL_VALIDATION_BATCH_SIZE) {
    if (getExternalSourceSignature(getExternalSources(folder)) !== signature) return null;
    const batch = rawItems.slice(start, start + EXTERNAL_VALIDATION_BATCH_SIZE);
    const results = await Promise.all(batch.map(validateExternalMediaItem));
    batch.forEach((item, index) => {
      if (results[index].valid) {
        item.thumbnail = results[index].thumbnail || '';
        validPaths.add(item.galleryPath);
      }
      else {
        validPaths.delete(item.galleryPath);
        failed.push({ source: item.name || item.url, message: 'File could not be displayed or played.' });
      }
    });

    const items = rawItems.filter(item => validPaths.has(item.galleryPath));
    const cached = {
      signature,
      checkedAt: Date.now(),
      sourcePaths,
      items,
      errors: [...sourceErrors, ...failed],
      complete: false,
    };
    externalMediaCache.set(folder, cached);
    const visibleItems = getVisibleExternalItems(folder, items);
    queueOpenGalleryExternalSync(folder, visibleItems);
    publishExternalMediaStatus(folder, {
      loading: true,
      count: visibleItems.length,
      checked: Math.min(start + batch.length, rawItems.length),
      total: rawItems.length,
      errors: cached.errors,
    });
    await new Promise(resolve => requestAnimationFrame(resolve));
  }

  const items = rawItems.filter(item => validPaths.has(item.galleryPath));
  const cached = {
    signature,
    checkedAt: Date.now(),
    sourcePaths,
    items,
    errors: [...sourceErrors, ...failed],
    complete: true,
  };
  externalMediaCache.set(folder, cached);
  const visibleItems = getVisibleExternalItems(folder, items);
  queueOpenGalleryExternalSync(folder, visibleItems);
  publishExternalMediaStatus(folder, {
    loading: false,
    count: visibleItems.length,
    errors: cached.errors,
  });
  return cached;
}

function validateExternalMediaItem(item) {
  const mediaUrl = new URL(String(item.url), location.origin).href;
  const cached = externalValidationCache.get(mediaUrl);
  if (cached !== undefined) {
    return Promise.resolve(typeof cached === 'object' ? cached : { valid: Boolean(cached), thumbnail: '' });
  }

  const isVideo = VIDEO_FILE_TYPES.includes(getFileExtension(item.galleryPath));
  return new Promise((resolve) => {
    const media = isVideo ? document.createElement('video') : new Image();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      media.onload = null;
      media.onerror = null;
      media.onloadedmetadata = null;
      media.onloadeddata = null;
      media.onseeked = null;
      if (media instanceof HTMLVideoElement) {
        media.removeAttribute('src');
        media.load();
      }
      externalValidationCache.set(mediaUrl, result);
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ valid: false, thumbnail: '' }), EXTERNAL_MEDIA_TIMEOUT_MS);
    media.onerror = () => finish({ valid: false, thumbnail: '' });
    if (media instanceof HTMLVideoElement) {
      const captureFrame = () => {
        if (settled || media.readyState < 2 || media.videoWidth <= 0 || media.videoHeight <= 0) return;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 240;
          canvas.height = 150;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas is unavailable.');
          context.fillStyle = '#171717';
          context.fillRect(0, 0, canvas.width, canvas.height);
          const scale = Math.min(canvas.width / media.videoWidth, canvas.height / media.videoHeight);
          const width = Math.max(1, Math.round(media.videoWidth * scale));
          const height = Math.max(1, Math.round(media.videoHeight * scale));
          context.drawImage(media, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
          finish({ valid: true, thumbnail: canvas.toDataURL('image/jpeg', 0.82) });
        } catch (error) {
          console.warn('[GalleryPlus] Could not capture a video thumbnail', error);
          finish({ valid: true, thumbnail: VIDEO_THUMBNAIL });
        }
      };
      media.preload = 'auto';
      media.muted = true;
      media.playsInline = true;
      media.onloadedmetadata = () => {
        if (!Number.isFinite(media.duration) || media.duration <= 0) {
          finish({ valid: false, thumbnail: '' });
          return;
        }
        const frameTime = Math.min(5, Math.max(0.05, media.duration * 0.1), Math.max(0, media.duration - 0.05));
        media.onloadeddata = captureFrame;
        media.onseeked = captureFrame;
        try {
          media.currentTime = frameTime;
          if (media.readyState >= 2) captureFrame();
        } catch {
          captureFrame();
        }
      };
    } else {
      media.decoding = 'async';
      media.onload = () => finish({
        valid: media.naturalWidth > 0 && media.naturalHeight > 0,
        thumbnail: '',
      });
    }
    media.src = mediaUrl;
    if (media instanceof HTMLVideoElement) media.load();
  });
}

function reportExternalMediaResult(result) {
  if (!result) {
    notify('error', 'Could not read the external sources.');
    return;
  }
  if (result.errors.length) {
    const details = result.errors.slice(0, 3)
      .map(error => `${error.source}: ${error.message}`)
      .join('\n');
    notify('info', `Loaded ${result.items.length} media files; ${result.errors.length} item${result.errors.length === 1 ? '' : 's'} could not be read or played and were omitted.\n${details}`);
  } else {
    notify('success', `${result.items.length} external media file${result.items.length === 1 ? '' : 's'} loaded.`);
  }
}

function queueOpenGalleryExternalSync(folder, items, attempt = 0) {
  if (attempt === 0) clearTimeout(externalGallerySyncTimers.get(folder));
  const timer = setTimeout(() => {
    externalGallerySyncTimers.delete(folder);
    if (syncOpenGalleryExternalMedia(folder, items)) return;
    const matchingGallery = [...document.querySelectorAll('#gallery')]
      .some(root => root instanceof HTMLElement && getGalleryFolder(root) === folder);
    if (matchingGallery && attempt < 20) {
      queueOpenGalleryExternalSync(folder, items, attempt + 1);
    }
  }, attempt === 0 ? 40 : 100);
  externalGallerySyncTimers.set(folder, timer);
}

function syncOpenGalleryExternalMedia(folder, items) {
  const root = [...document.querySelectorAll('#gallery')]
    .find(element => element instanceof HTMLElement && getGalleryFolder(element) === folder);
  const gallery = root?.querySelector('#dragGallery');
  const jq = window.jQuery || window.$;
  const itemFactory = window.NGY2Item;
  if (!(gallery instanceof HTMLElement) || typeof jq !== 'function' || typeof itemFactory?.New !== 'function') {
    return false;
  }

  try {
    const galleryApi = jq(gallery);
    const data = galleryApi.nanogallery2('data');
    const instance = galleryApi.nanogallery2('instance');
    if (!Array.isArray(data?.items) || !instance) return false;

    const desired = new Map(items.map(item => [item.galleryPath, item]));
    const existing = new Map();
    [...data.items].forEach((item) => {
      const filename = filenameFromGalleryItem(item);
      if (isExternalGalleryPath(filename)) existing.set(filename, item);
    });

    const operations = [];
    existing.forEach((item, filename) => {
      if (!desired.has(filename) && typeof item.delete === 'function') {
        operations.push(() => item.delete());
      }
    });
    desired.forEach((item, filename) => {
      if (existing.has(filename)) return;
      operations.push(() => {
        const mediaUrl = new URL(String(item.url), location.origin).href;
        const extension = getFileExtension(filename);
        const isVideo = VIDEO_FILE_TYPES.includes(extension);
        const id = `gp-external-${Date.now()}-${externalItemSequence++}`;
        const newItem = itemFactory.New(instance, String(item.name || ''), '', id, '0', 'image', '');
        newItem.thumbSet(isVideo ? (item.thumbnail || VIDEO_THUMBNAIL) : mediaUrl, 240, 150);
        newItem.setMediaURL(mediaUrl, isVideo ? 'video' : 'img');
        newItem.addToGOM();
      });
    });

    const generation = (Number(root._gpExternalSyncGeneration) || 0) + 1;
    root._gpExternalSyncGeneration = generation;
    const runBatch = () => {
      if (!root.isConnected || root._gpExternalSyncGeneration !== generation) return;
      const batch = operations.splice(0, 24);
      batch.forEach(operation => operation());
      if (batch.length) galleryApi.nanogallery2('resize');
      if (operations.length) setTimeout(runBatch, 0);
    };
    runBatch();
    return true;
  } catch (error) {
    console.warn('[GalleryPlus] Could not update the open gallery in place', error);
    return false;
  }
}

function installFailedMediaHandling(root, gallery) {
  gallery.addEventListener('error', (event) => {
    const media = event.target;
    if (!(media instanceof HTMLImageElement) && !(media instanceof HTMLVideoElement)) return;
    const galleryPath = filenameFromSource(media.currentSrc || media.src);
    if (!isExternalGalleryPath(galleryPath)) return;
    markExternalMediaFailed(getGalleryFolder(root), galleryPath);
  }, true);
}

function markExternalMediaFailed(folder, galleryPath) {
  const cached = externalMediaCache.get(folder);
  if (!cached?.items.some(item => item.galleryPath === galleryPath)) return;
  const failedItem = cached.items.find(item => item.galleryPath === galleryPath);
  if (failedItem?.url) {
    externalValidationCache.set(
      new URL(String(failedItem.url), location.origin).href,
      { valid: false, thumbnail: '' },
    );
  }
  const items = cached.items.filter(item => item.galleryPath !== galleryPath);
  const next = {
    ...cached,
    items,
    errors: [...cached.errors, {
      source: failedItem?.name || galleryPath,
      message: 'File could not be displayed or played.',
    }],
  };
  externalMediaCache.set(folder, next);
  queueOpenGalleryExternalSync(folder, getVisibleExternalItems(folder, items));
  publishExternalMediaStatus(folder, {
    loading: !next.complete,
    count: getVisibleExternalItems(folder, items).length,
    errors: next.errors,
  });
}

export function omitFailedExternalMedia(folder, source) {
  const galleryPath = filenameFromSource(source);
  if (isExternalGalleryPath(galleryPath)) markExternalMediaFailed(folder, galleryPath);
}

function externalItemToGalleryPath(item) {
  try {
    const url = new URL(String(item?.url || ''), location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith(EXTERNAL_FILE_PREFIX)) return '';
    const name = String(item?.name || decodeURIComponent(url.pathname.split('/').pop() || ''));
    const galleryPath = `../../..${url.pathname}${url.search}`;
    if (name) externalEntriesByName.set(name, galleryPath);
    return galleryPath;
  } catch {
    return '';
  }
}

function isExternalGalleryPath(filename) {
  return typeof filename === 'string'
    && filename.startsWith(`../../..${EXTERNAL_FILE_PREFIX}`);
}

function ensureCustomSortOption(select) {
  if (!select.querySelector(`option[value="${CUSTOM_SORT}"]`)) {
    const option = document.createElement('option');
    option.value = CUSTOM_SORT;
    option.textContent = 'Custom';
    select.appendChild(option);
  }
  select.value = getGallerySort();
}

function updateCustomOrderHint(root, select) {
  let hint = root.querySelector('.gp-custom-order-hint');
  if (select.value !== CUSTOM_SORT) {
    hint?.remove();
    return;
  }
  if (!hint) {
    hint = document.createElement('span');
    hint.className = 'gp-custom-order-hint';
    hint.textContent = 'Drag thumbnails to reorder';
    select.insertAdjacentElement('afterend', hint);
  }
}

function installArchiveControl(root, gallery, sortSelect) {
  const folderInput = root.querySelector('.gallery-folder-input');
  const topBar = folderInput?.parentElement;
  const nativeDelete = topBar?.querySelector('.fa-trash');
  const button = nativeDelete?.cloneNode(false) ?? document.createElement('div');
  button.classList.add('right_menu_button', 'fa-solid', 'fa-box-archive', 'fa-fw', 'gp-archive-mode');
  button.classList.remove('fa-trash');
  button.classList.toggle('warning', archiveModeActive);
  button.title = 'Remove mode (moves images to the deprecated folder)';
  button.setAttribute('role', 'button');
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(archiveModeActive));

  button.addEventListener('click', () => {
    archiveModeActive = !archiveModeActive;
    button.classList.toggle('warning', archiveModeActive);
    button.setAttribute('aria-pressed', String(archiveModeActive));
    if (archiveModeActive) {
      notify('info', 'Remove mode is ON. Click an image to move it into the deprecated folder.');
    }
  });

  if (nativeDelete) nativeDelete.replaceWith(button);
  else topBar?.appendChild(button);

  gallery.addEventListener('click', async (event) => {
    if (!archiveModeActive) return;
    if (event.target instanceof Element && event.target.closest('.gp-thumbnail-favorite')) return;
    const thumbnail = event.target instanceof Element ? event.target.closest('.nGY2GThumbnail') : null;
    if (!(thumbnail instanceof HTMLElement)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const filename = getThumbnailFilename(thumbnail);
    const folder = getGalleryFolder(root);
    if (!filename || !folder) {
      notify('error', 'Could not determine the gallery file to remove.');
      return;
    }
    if (isExternalGalleryPath(filename)) {
      notify('info', 'This file is referenced from an external location. Remove its address from External Sources instead.');
      return;
    }
    if (!window.confirm(`Move "${filename}" to "${folder}/deprecated"?`)) return;

    button.classList.add('gp-busy');
    try {
      const response = await fetch(ARCHIVE_ENDPOINT, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ folder, filename }),
      });
      if (!response.ok) {
        throw new Error(await getServerError(
          response,
          'archive',
          `Archive failed with status ${response.status}.`,
        ));
      }

      removeFromStoredOrder(folder, filename);
      notify('success', `Moved "${filename}" to the deprecated folder.`);
      refreshGallery(sortSelect);
    } catch (error) {
      console.error('[GalleryPlus] Failed to archive gallery image', error);
      notify('error', error?.message || 'Failed to move the image.');
    } finally {
      button.classList.remove('gp-busy');
    }
  }, true);
}

function installReordering(root, gallery, sortSelect) {
  let pageSwitchTimer = null;
  let pendingPage = null;

  const clearPendingPageSwitch = () => {
    clearTimeout(pageSwitchTimer);
    pageSwitchTimer = null;
    pendingPage = null;
    gallery.querySelectorAll('.gp-page-drop-target').forEach((element) => {
      element.classList.remove('gp-page-drop-target');
    });
  };

  const decorate = () => {
    gallery.querySelectorAll('.nGY2GThumbnail').forEach((thumbnail) => {
      if (thumbnail instanceof HTMLElement) {
        thumbnail.draggable = true;
        thumbnail.classList.add('gp-reorderable-thumbnail');
      }
    });
  };

  const observer = new MutationObserver(decorate);
  observer.observe(gallery, { childList: true, subtree: true });
  decorate();

  gallery.addEventListener('dragstart', (event) => {
    if (event.target instanceof Element && event.target.closest('.gp-thumbnail-favorite')) {
      event.preventDefault();
      return;
    }
    const thumbnail = event.target instanceof Element ? event.target.closest('.nGY2GThumbnail') : null;
    if (!(thumbnail instanceof HTMLElement)) return;
    const filename = getThumbnailFilename(thumbnail);
    if (!filename) return;
    root.dataset.gpDraggedFilename = filename;
    thumbnail.classList.add('gp-dragging');
    event.dataTransfer?.setData('text/plain', filename);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });

  gallery.addEventListener('dragover', (event) => {
    const pageIcon = event.target instanceof Element ? event.target.closest(PAGINATION_ICON_SELECTOR) : null;
    if (pageIcon instanceof HTMLElement && root.dataset.gpDraggedFilename) {
      event.preventDefault();
      const pageNumber = getPaginationPageNumber(gallery, pageIcon);
      if (pageNumber >= 0 && pageNumber !== pendingPage) {
        clearPendingPageSwitch();
        pendingPage = pageNumber;
        pageIcon.classList.add('gp-page-drop-target');
        pageSwitchTimer = setTimeout(() => {
          if (!root.dataset.gpDraggedFilename || !pageIcon.isConnected) return;
          pageIcon.click();
          clearPendingPageSwitch();
        }, 450);
      }
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      return;
    }

    const thumbnail = event.target instanceof Element ? event.target.closest('.nGY2GThumbnail') : null;
    if (!(thumbnail instanceof HTMLElement) || !root.dataset.gpDraggedFilename) return;
    event.preventDefault();
    clearPendingPageSwitch();
    gallery.querySelectorAll('.gp-drop-target').forEach(el => el.classList.remove('gp-drop-target'));
    thumbnail.classList.add('gp-drop-target');
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  });

  gallery.addEventListener('drop', (event) => {
    clearPendingPageSwitch();
    const thumbnail = event.target instanceof Element ? event.target.closest('.nGY2GThumbnail') : null;
    const dragged = root.dataset.gpDraggedFilename || event.dataTransfer?.getData('text/plain');
    const target = thumbnail instanceof HTMLElement ? getThumbnailFilename(thumbnail) : '';
    clearDragState(root, gallery);
    if (!dragged || !target || dragged === target) return;
    event.preventDefault();

    const folder = getGalleryFolder(root);
    const allFiles = readGalleryFilenames();
    const order = getStoredOrder(folder, allFiles);
    const rect = thumbnail.getBoundingClientRect();
    const placeAfter = event.clientX > rect.left + rect.width / 2;
    const reordered = reorderFiles(order, dragged, target, placeAfter);
    if (sameList(order, reordered)) return;
    saveVisibleStoredOrder(folder, reordered);
    setGallerySort(CUSTOM_SORT);
    sortSelect.value = CUSTOM_SORT;
    refreshGallery(sortSelect);
  });

  gallery.addEventListener('dragend', () => {
    clearPendingPageSwitch();
    clearDragState(root, gallery);
  });
}

function clearDragState(root, gallery) {
  delete root.dataset.gpDraggedFilename;
  gallery.querySelectorAll('.gp-dragging, .gp-drop-target, .gp-page-drop-target').forEach((el) => {
    el.classList.remove('gp-dragging', 'gp-drop-target', 'gp-page-drop-target');
  });
}

function refreshGallery(select) {
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function getGalleryFolder(root) {
  const input = root.querySelector('.gallery-folder-input');
  return input && 'value' in input ? String(input.value || '') : '';
}

function getThumbnailFilename(thumbnail) {
  const source = thumbnail.querySelector('img, video')?.src || '';
  const sourceFilename = filenameFromSource(source);
  if (isExternalGalleryPath(sourceFilename)) return sourceFilename;
  const title = thumbnail.getAttribute('title') || '';
  if (title) return externalEntriesByName.get(title) ?? title;
  return sourceFilename;
}

function filenameFromSource(source) {
  try {
    const url = new URL(source, location.href);
    if (url.pathname.startsWith(EXTERNAL_FILE_PREFIX)) {
      return `../../..${url.pathname}${url.search}`;
    }
    const name = decodeURIComponent(url.pathname.split('/').pop() || '');
    return externalEntriesByName.get(name) ?? name;
  } catch {
    return '';
  }
}

function filenameFromGalleryItem(item) {
  const source = typeof item?.responsiveURL === 'function' ? item.responsiveURL() : item?.src;
  return filenameFromSource(source);
}

function readGalleryFilenames() {
  const jq = window.jQuery || window.$;
  if (typeof jq !== 'function') return [];
  try {
    const items = jq('#dragGallery').nanogallery2('data')?.items;
    if (!Array.isArray(items)) return [];
    return items.map(filenameFromGalleryItem).filter(Boolean);
  } catch {
    return [];
  }
}

function getGallerySort() {
  return window.SillyTavern?.getContext?.()?.extensionSettings?.gallery?.sort ?? 'dateAsc';
}

function setGallerySort(sort) {
  const context = window.SillyTavern?.getContext?.();
  if (!context?.extensionSettings?.gallery) return;
  context.extensionSettings.gallery.sort = sort;
  context.saveSettingsDebounced?.();
}

function getStoredOrder(folder, fallback = []) {
  const stored = gpSettings().customOrders?.[folder];
  const order = Array.isArray(stored) ? stored.filter(item => typeof item === 'string') : [];
  return applyOrder(order, fallback);
}

function saveStoredOrder(folder, order) {
  if (!folder) return;
  const customOrders = { ...(gpSettings().customOrders || {}), [folder]: [...order] };
  gpSaveSettings({ customOrders });
}

function saveVisibleStoredOrder(folder, visibleOrder) {
  if (areAllFileTypesEnabled(folder)) {
    saveStoredOrder(folder, visibleOrder);
    return;
  }

  const stored = gpSettings().customOrders?.[folder];
  if (!Array.isArray(stored)) {
    saveStoredOrder(folder, visibleOrder);
    return;
  }
  const visible = new Set(visibleOrder);
  const queue = [...visibleOrder];
  const merged = stored.map(item => (visible.has(item) ? queue.shift() : item));
  merged.push(...queue);
  saveStoredOrder(folder, merged);
}

function removeFromStoredOrder(folder, filename) {
  const current = gpSettings().customOrders?.[folder];
  if (!Array.isArray(current)) return;
  saveStoredOrder(folder, current.filter(item => item !== filename));
}

function applyStoredOrder(folder, files, preserveHidden = false) {
  const order = getStoredOrder(folder, files);
  const stored = gpSettings().customOrders?.[folder];
  if (preserveHidden) {
    if (!Array.isArray(stored)) saveStoredOrder(folder, order);
    else {
      const included = new Set(stored);
      const added = files.filter(file => !included.has(file));
      if (added.length) saveStoredOrder(folder, [...stored, ...added]);
    }
  } else if (!Array.isArray(stored) || !sameList(stored, order)) {
    saveStoredOrder(folder, order);
  }
  return order;
}

function applyOrder(order, files) {
  const available = new Set(files);
  const result = order.filter((item, index) => available.has(item) && order.indexOf(item) === index);
  const included = new Set(result);
  for (const file of files) {
    if (!included.has(file)) {
      included.add(file);
      result.push(file);
    }
  }
  return result;
}

function sameList(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function reorderFiles(order, dragged, target, placeAfter = false) {
  const next = [...order];
  const from = next.indexOf(dragged);
  if (from < 0 || !next.includes(target) || dragged === target) return next;

  next.splice(from, 1);
  let insertAt = next.indexOf(target);
  if (placeAfter) insertAt += 1;
  next.splice(insertAt, 0, dragged);
  return next;
}

function getRequestHeaders() {
  const context = window.SillyTavern?.getContext?.();
  return context?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
}

async function getServerError(response, capability, fallback) {
  const message = (await response.text()).trim();
  const routeMissing = response.status === 404
    && (!message || /Cannot\s+(?:GET|POST)\s+\/api\/plugins\/galleryplus\//i.test(message));

  if (!routeMissing) return message || fallback;

  try {
    const healthResponse = await fetch(SERVER_HEALTH_ENDPOINT, {
      method: 'GET',
      headers: getRequestHeaders(),
    });
    if (healthResponse.ok) {
      const health = await healthResponse.json().catch(() => ({}));
      const capabilities = Array.isArray(health?.capabilities) ? health.capabilities : [];
      if (!capabilities.includes(capability)) {
        return 'GalleryPlus server plugin is installed but out of date. Update it and restart SillyTavern.';
      }
      return fallback;
    }
  } catch {
    // The health probe is best-effort; use the actionable fallback below.
  }

  return 'GalleryPlus server plugin is not loaded. Enable server plugins, install GalleryPlus under SillyTavern/plugins, and restart SillyTavern.';
}

function notify(level, message) {
  const toaster = window.toastr?.[level];
  if (typeof toaster === 'function') toaster(message, 'GalleryPlus');
  else console[level === 'error' ? 'error' : 'info'](`[GalleryPlus] ${message}`);
}


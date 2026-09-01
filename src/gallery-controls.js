import { gpSettings, gpSaveSettings } from './settings.js';

const CUSTOM_SORT = 'custom';
const ARCHIVE_ENDPOINT = '/api/plugins/galleryplus/archive';
const OPEN_FOLDER_ENDPOINT = '/api/plugins/galleryplus/open-folder';
const SERVER_HEALTH_ENDPOINT = '/api/plugins/galleryplus/health';
let archiveModeActive = false;
let fetchHookInstalled = false;

export function installCustomOrderFetchHook() {
  if (fetchHookInstalled) return;
  fetchHookInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function galleryPlusFetch(input, init) {
    const response = await nativeFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const pathname = new URL(url, location.href).pathname;
      if (pathname !== '/api/images/list' || getGallerySort() !== CUSTOM_SORT || !response.ok) {
        return response;
      }

      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      const folder = typeof body?.folder === 'string' ? body.folder : '';
      if (!folder) return response;

      const files = await response.clone().json();
      if (!Array.isArray(files)) return response;

      const ordered = applyStoredOrder(folder, files.map(String));
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(ordered), {
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

export function wireGallery(root) {
  if (!(root instanceof HTMLElement) || root.dataset.gpGalleryWired === '1') return;

  const sortSelect = root.querySelector('.gallery-sort-select');
  const gallery = root.querySelector('#dragGallery');
  if (!(sortSelect instanceof HTMLSelectElement) || !(gallery instanceof HTMLElement)) return;

  root.dataset.gpGalleryWired = '1';
  ensureCustomSortOption(sortSelect);
  installOpenFolderControl(root);
  installArchiveControl(root, gallery, sortSelect);
  installReordering(root, gallery, sortSelect);
  updateCustomOrderHint(root, sortSelect);

  sortSelect.addEventListener('change', () => updateCustomOrderHint(root, sortSelect));
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
    const thumbnail = event.target instanceof Element ? event.target.closest('.nGY2GThumbnail') : null;
    if (!(thumbnail instanceof HTMLElement) || !root.dataset.gpDraggedFilename) return;
    event.preventDefault();
    gallery.querySelectorAll('.gp-drop-target').forEach(el => el.classList.remove('gp-drop-target'));
    thumbnail.classList.add('gp-drop-target');
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  });

  gallery.addEventListener('drop', (event) => {
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
    saveStoredOrder(folder, reordered);
    setGallerySort(CUSTOM_SORT);
    sortSelect.value = CUSTOM_SORT;
    refreshGallery(sortSelect);
  });

  gallery.addEventListener('dragend', () => clearDragState(root, gallery));
}

function clearDragState(root, gallery) {
  delete root.dataset.gpDraggedFilename;
  gallery.querySelectorAll('.gp-dragging, .gp-drop-target').forEach((el) => {
    el.classList.remove('gp-dragging', 'gp-drop-target');
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
  const title = thumbnail.getAttribute('title') || '';
  if (title) return title;
  const source = thumbnail.querySelector('img')?.src || '';
  try {
    return decodeURIComponent(new URL(source, location.href).pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

function readGalleryFilenames() {
  const jq = window.jQuery || window.$;
  if (typeof jq !== 'function') return [];
  try {
    const items = jq('#dragGallery').nanogallery2('data')?.items;
    if (!Array.isArray(items)) return [];
    return items.map(item => {
      const source = typeof item?.responsiveURL === 'function' ? item.responsiveURL() : item?.src;
      try {
        return decodeURIComponent(new URL(source, location.href).pathname.split('/').pop() || '');
      } catch {
        return '';
      }
    }).filter(Boolean);
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

function removeFromStoredOrder(folder, filename) {
  const current = gpSettings().customOrders?.[folder];
  if (!Array.isArray(current)) return;
  saveStoredOrder(folder, current.filter(item => item !== filename));
}

function applyStoredOrder(folder, files) {
  const order = getStoredOrder(folder, files);
  const stored = gpSettings().customOrders?.[folder];
  if (!Array.isArray(stored) || !sameList(stored, order)) {
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


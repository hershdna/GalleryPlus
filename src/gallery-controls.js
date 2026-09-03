import { gpSettings, gpSaveSettings } from './settings.js';

const CUSTOM_SORT = 'custom';
const ARCHIVE_ENDPOINT = '/api/plugins/galleryplus/archive';
const OPEN_FOLDER_ENDPOINT = '/api/plugins/galleryplus/open-folder';
const EXTERNAL_LIST_ENDPOINT = '/api/plugins/galleryplus/external-media/list';
const EXTERNAL_FILE_PREFIX = '/api/plugins/galleryplus/external-media/file/';
const SERVER_HEALTH_ENDPOINT = '/api/plugins/galleryplus/health';
const IMAGE_FILE_TYPES = ['bmp', 'gif', 'jfif', 'jpeg', 'jpg', 'png', 'webp'];
const VIDEO_FILE_TYPES = ['mov', 'mp4', 'webm'];
const SUPPORTED_FILE_TYPES = [...IMAGE_FILE_TYPES, ...VIDEO_FILE_TYPES];
let archiveModeActive = false;
let fetchHookInstalled = false;
const externalEntriesByName = new Map();

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

      const augmented = files.map(String);
      const sources = getExternalSources(folder);
      if (sources.length) {
        try {
          const external = await fetchExternalMedia(sources, nativeFetch);
          external.items.forEach((item) => {
            const galleryPath = externalItemToGalleryPath(item);
            if (galleryPath && !augmented.includes(galleryPath)) augmented.push(galleryPath);
          });
        } catch (error) {
          console.warn('[GalleryPlus] Could not add external media to gallery', error);
        }
      }

      const filtered = filterFilesByType(folder, augmented);
      const result = getGallerySort() === CUSTOM_SORT
        ? applyStoredOrder(folder, filtered, !areAllFileTypesEnabled(folder))
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

export function wireGallery(root) {
  if (!(root instanceof HTMLElement) || root.dataset.gpGalleryWired === '1') return;

  const sortSelect = root.querySelector('.gallery-sort-select');
  const gallery = root.querySelector('#dragGallery');
  if (!(sortSelect instanceof HTMLSelectElement) || !(gallery instanceof HTMLElement)) return;

  root.dataset.gpGalleryWired = '1';
  ensureCustomSortOption(sortSelect);
  installOpenFolderControl(root);
  installExternalSourcesControl(root, sortSelect);
  installFileTypeFilterControl(root, sortSelect);
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

function installExternalSourcesControl(root, sortSelect) {
  const folderInput = root.querySelector('.gallery-folder-input');
  const topBar = folderInput?.parentElement;
  if (!(topBar instanceof HTMLElement) || topBar.querySelector('.gp-external-sources')) return;

  const dropdown = document.createElement('details');
  dropdown.className = 'gp-external-sources';

  const summary = document.createElement('summary');
  summary.className = 'right_menu_button fa-solid fa-link fa-fw gp-external-sources-button';
  summary.title = 'Add external files and folders';
  summary.setAttribute('aria-label', summary.title);
  dropdown.appendChild(summary);

  const panel = document.createElement('div');
  panel.className = 'gp-external-sources-panel';

  const label = document.createElement('label');
  label.className = 'gp-external-sources-label';
  label.textContent = 'External files and folders';

  const textarea = document.createElement('textarea');
  textarea.className = 'gp-external-sources-input text_pole';
  textarea.rows = 7;
  textarea.placeholder = 'One file or folder address per line';
  textarea.spellcheck = false;
  label.appendChild(textarea);
  panel.appendChild(label);

  const help = document.createElement('small');
  help.className = 'gp-external-sources-help';
  help.textContent = 'Folders include supported images and videos in all subfolders. Files remain in their original locations.';
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
  dropdown.appendChild(panel);

  const positionPanel = () => {
    const anchor = summary.getBoundingClientRect();
    const galleryRect = root.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(420, window.innerWidth - margin * 2, Math.max(240, galleryRect.width - margin * 2));
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(margin, Math.min(
      galleryRect.left + (galleryRect.width - width) / 2,
      window.innerWidth - width - margin,
    ))}px`;
    panel.style.top = `${anchor.bottom + 6}px`;
    requestAnimationFrame(() => {
      const panelRect = panel.getBoundingClientRect();
      if (panelRect.bottom > window.innerHeight - margin && anchor.top > panelRect.height + margin) {
        panel.style.top = `${anchor.top - panelRect.height - 6}px`;
      }
    });
  };

  dropdown.addEventListener('toggle', () => {
    if (!dropdown.open) {
      window.removeEventListener('resize', positionPanel);
      panel.hidden = true;
      dropdown.appendChild(panel);
      return;
    }
    root.querySelectorAll('.gp-external-sources[open], .gp-file-types[open]').forEach((other) => {
      if (other !== dropdown) other.open = false;
    });
    document.body.appendChild(panel);
    panel.hidden = false;
    const folder = getGalleryFolder(root);
    textarea.value = getExternalSources(folder).join('\n');
    status.textContent = folder ? '' : 'Choose a gallery folder first.';
    positionPanel();
    window.addEventListener('resize', positionPanel);
    requestAnimationFrame(() => textarea.focus());
  });

  panel.addEventListener('click', event => event.stopPropagation());
  saveButton.addEventListener('click', async () => {
    if (saveButton.disabled) return;
    const folder = getGalleryFolder(root);
    if (!folder) {
      status.textContent = 'Choose a gallery folder first.';
      return;
    }

    const sources = [...new Set(textarea.value
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean))];
    saveButton.disabled = true;
    status.textContent = 'Checking addresses…';
    try {
      const external = await fetchExternalMedia(sources, window.fetch, true);
      saveExternalSources(folder, sources);
      status.textContent = `${external.items.length} external media file${external.items.length === 1 ? '' : 's'} found.`;
      if (external.errors.length) {
        const details = external.errors.slice(0, 3)
          .map(error => `${error.source}: ${error.message}`)
          .join('\n');
        notify('info', `Saved, but ${external.errors.length} address${external.errors.length === 1 ? '' : 'es'} could not be read.\n${details}`);
      } else {
        notify('success', 'External gallery sources updated.');
      }
      dropdown.open = false;
      refreshGallery(sortSelect);
    } catch (error) {
      console.error('[GalleryPlus] Failed to update external gallery sources', error);
      status.textContent = error?.message || 'Could not read the external sources.';
      notify('error', status.textContent);
    } finally {
      saveButton.disabled = false;
    }
  });

  const openFolderButton = topBar.querySelector('.gp-open-folder');
  if (openFolderButton) openFolderButton.insertAdjacentElement('afterend', dropdown);
  else topBar.appendChild(dropdown);
}

function installFileTypeFilterControl(root, sortSelect) {
  const folderInput = root.querySelector('.gallery-folder-input');
  const topBar = folderInput?.parentElement;
  if (!(topBar instanceof HTMLElement) || topBar.querySelector('.gp-file-types')) return;

  const dropdown = document.createElement('details');
  dropdown.className = 'gp-file-types';

  const summary = document.createElement('summary');
  summary.className = 'right_menu_button fa-solid fa-filter fa-fw gp-file-types-button';
  summary.title = 'Choose gallery and slideshow file types';
  summary.setAttribute('aria-label', summary.title);
  dropdown.appendChild(summary);

  const panel = document.createElement('div');
  panel.className = 'gp-file-types-panel';

  const heading = document.createElement('strong');
  heading.textContent = 'Visible file types';
  panel.appendChild(heading);

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
  dropdown.appendChild(panel);

  const updateStatus = () => {
    const count = [...inputs.values()].filter(input => input.checked).length;
    status.textContent = `${count} of ${SUPPORTED_FILE_TYPES.length} file types selected`;
  };
  const setAll = (checked) => {
    inputs.forEach(input => { input.checked = checked; });
    updateStatus();
  };
  const positionPanel = () => {
    const anchor = summary.getBoundingClientRect();
    const galleryRect = root.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(420, window.innerWidth - margin * 2, Math.max(240, galleryRect.width - margin * 2));
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(margin, Math.min(
      galleryRect.left + (galleryRect.width - width) / 2,
      window.innerWidth - width - margin,
    ))}px`;
    panel.style.top = `${anchor.bottom + 6}px`;
    requestAnimationFrame(() => {
      const panelRect = panel.getBoundingClientRect();
      if (panelRect.bottom > window.innerHeight - margin && anchor.top > panelRect.height + margin) {
        panel.style.top = `${anchor.top - panelRect.height - 6}px`;
      }
    });
  };

  dropdown.addEventListener('toggle', () => {
    if (!dropdown.open) {
      window.removeEventListener('resize', positionPanel);
      panel.hidden = true;
      dropdown.appendChild(panel);
      return;
    }
    root.querySelectorAll('.gp-external-sources[open], .gp-file-types[open]').forEach((other) => {
      if (other !== dropdown) other.open = false;
    });
    document.body.appendChild(panel);
    panel.hidden = false;
    const folder = getGalleryFolder(root);
    const enabled = new Set(getEnabledFileTypes(folder));
    inputs.forEach((input, type) => { input.checked = enabled.has(type); });
    updateStatus();
    positionPanel();
    window.addEventListener('resize', positionPanel);
  });
  panel.addEventListener('click', event => event.stopPropagation());
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
    dropdown.open = false;
    notify('success', `Showing ${enabled.length} of ${SUPPORTED_FILE_TYPES.length} file types.`);
    refreshGallery(sortSelect);
  });

  const externalSources = topBar.querySelector('.gp-external-sources');
  if (externalSources) externalSources.insertAdjacentElement('afterend', dropdown);
  else topBar.appendChild(dropdown);
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
  const stored = gpSettings().externalSources?.[folder];
  return Array.isArray(stored) ? stored.filter(source => typeof source === 'string' && source.trim()) : [];
}

function saveExternalSources(folder, sources) {
  if (!folder) return;
  const externalSources = { ...(gpSettings().externalSources || {}) };
  if (sources.length) externalSources[folder] = [...sources];
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
    saveVisibleStoredOrder(folder, reordered);
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

function readGalleryFilenames() {
  const jq = window.jQuery || window.$;
  if (typeof jq !== 'function') return [];
  try {
    const items = jq('#dragGallery').nanogallery2('data')?.items;
    if (!Array.isArray(items)) return [];
    return items.map(item => {
      const source = typeof item?.responsiveURL === 'function' ? item.responsiveURL() : item?.src;
      return filenameFromSource(source);
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

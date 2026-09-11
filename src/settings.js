const EXT_ID = 'GalleryPlus';

export const FAVORITES_CHANGED_EVENT = 'galleryplus:favorites-changed';
export const RESUME_SESSION_CHANGED_EVENT = 'galleryplus:resume-session-changed';
const RESUME_STORAGE_KEY = 'GalleryPlus.resumeSessions.v1';
let resumeSessionMemory = {};
let pendingResumeRequest = null;

const DEFAULTS = {
  enabled: true,
  diag: Date.now(),
  openHeight: 800,
  hoverZoom: false,
  hoverZoomScale: 1.08,
  zoomLock: false,
  viewerRect: null,
  masonryDense: false,
  showCaptions: true,
  webpOnly: false,
  slideshowSpeedSec: 3,
  slideshowTransition: 'fade',
  videoMuted: false,
  videoControlsVisible: true,
  videoLoopTimeSec: 10,
  autoHideControls: false,
  presentationMode: 'all',
  favoritesByGallery: {},
  externalSources: {},
  groupGalleryFolders: {},
  fileTypeFilters: {},
  customOrders: {},
};

function ctx() {
  try {
    return window.SillyTavern?.getContext?.();
  } catch {
    return null;
  }
}

function _settingsBag() {
  const c = ctx();
  if (c?.extensionSettings) {
    if (!c.extensionSettings[EXT_ID]) {
      c.extensionSettings[EXT_ID] = { ...DEFAULTS };
    }
    return c.extensionSettings[EXT_ID];
  }
  const raw = localStorage.getItem('GP_SETTINGS');
  if (!raw) {
    const init = { ...DEFAULTS };
    localStorage.setItem('GP_SETTINGS', JSON.stringify(init));
    return init;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const init = { ...DEFAULTS };
    localStorage.setItem('GP_SETTINGS', JSON.stringify(init));
    return init;
  }
}

export function gpSettings() {
  return _settingsBag();
}

export function gpSaveSettings(partial = {}) {
  const c = ctx();
  if (c?.extensionSettings) {
    c.extensionSettings[EXT_ID] = { ..._settingsBag(), ...partial };
    c.saveSettingsDebounced?.();
  } else {
    const merged = { ..._settingsBag(), ...partial };
    localStorage.setItem('GP_SETTINGS', JSON.stringify(merged));
  }
}

export function gpGetGroupGalleryFolder(groupId = '') {
  const key = String(groupId || '').trim();
  if (!key) return '';
  const stored = gpSettings().groupGalleryFolders;
  const folder = stored && typeof stored === 'object' ? stored[key] : '';
  return typeof folder === 'string' ? folder.trim() : '';
}

export function gpSetGroupGalleryFolder(groupId, folder = '') {
  const key = String(groupId || '').trim();
  if (!key) return;

  const stored = gpSettings().groupGalleryFolders;
  const groupGalleryFolders = stored && typeof stored === 'object' ? { ...stored } : {};
  const value = String(folder || '').trim();
  if (value) groupGalleryFolders[key] = value;
  else delete groupGalleryFolders[key];

  gpSaveSettings({ groupGalleryFolders });
}

export function gpClearGroupGalleryFolder(groupId) {
  gpSetGroupGalleryFolder(groupId, '');
}

export function gpFavoriteGalleryKey(folder = '') {
  return String(folder || '') || '__default__';
}

export function gpFavoriteIdentity(source) {
  try {
    const url = new URL(String(source), location.href);
    return `${url.pathname}${url.search}`;
  } catch {
    return String(source || '');
  }
}

export function gpGetFavoriteSet(folder = '') {
  const favorites = gpSettings().favoritesByGallery;
  const entries = favorites && typeof favorites === 'object'
    ? favorites[gpFavoriteGalleryKey(folder)]
    : null;
  return new Set(Array.isArray(entries) ? entries.map(String) : []);
}

export function gpToggleFavorite(folder, source) {
  const identity = gpFavoriteIdentity(source);
  if (!identity) return false;

  const galleryKey = gpFavoriteGalleryKey(folder);
  const stored = gpSettings().favoritesByGallery;
  const favoritesByGallery = stored && typeof stored === 'object' ? { ...stored } : {};
  const favorites = new Set(Array.isArray(favoritesByGallery[galleryKey])
    ? favoritesByGallery[galleryKey].map(String)
    : []);
  const favorite = !favorites.has(identity);
  if (favorite) favorites.add(identity);
  else favorites.delete(identity);
  favoritesByGallery[galleryKey] = [...favorites];
  gpSaveSettings({ favoritesByGallery });
  document.dispatchEvent(new CustomEvent(FAVORITES_CHANGED_EVENT, {
    detail: { galleryKey, identity, favorite },
  }));
  return favorite;
}

function readResumeSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESUME_STORAGE_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      resumeSessionMemory = parsed;
    }
  } catch {
    // Use the in-memory copy if storage is unavailable or corrupt.
  }
  return resumeSessionMemory;
}

function writeResumeSessions(sessions) {
  resumeSessionMemory = sessions;
  try {
    localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(sessions));
  } catch (error) {
    console.warn('[GalleryPlus] Could not persist the complete resume session', error);
  }
}

export function gpGetResumeSession(folder = '') {
  const session = readResumeSessions()[gpFavoriteGalleryKey(folder)];
  return session && typeof session === 'object' ? session : null;
}

export function gpSaveResumeSession(folder, session) {
  const galleryKey = gpFavoriteGalleryKey(folder);
  const sessions = { ...readResumeSessions(), [galleryKey]: session };
  writeResumeSessions(sessions);
  document.dispatchEvent(new CustomEvent(RESUME_SESSION_CHANGED_EVENT, {
    detail: { galleryKey, session },
  }));
}

export function gpClearResumeSession(folder = '') {
  const galleryKey = gpFavoriteGalleryKey(folder);
  const sessions = { ...readResumeSessions() };
  delete sessions[galleryKey];
  writeResumeSessions(sessions);
  document.dispatchEvent(new CustomEvent(RESUME_SESSION_CHANGED_EVENT, {
    detail: { galleryKey, session: null },
  }));
}

export function gpQueueResumeRequest(folder, autoPlay = false) {
  pendingResumeRequest = {
    galleryKey: gpFavoriteGalleryKey(folder),
    autoPlay: Boolean(autoPlay),
    expiresAt: Date.now() + 5000,
  };
}

export function gpConsumeResumeRequest(folder) {
  const request = pendingResumeRequest;
  pendingResumeRequest = null;
  if (!request || request.expiresAt < Date.now()) return null;
  return request.galleryKey === gpFavoriteGalleryKey(folder) ? request : null;
}

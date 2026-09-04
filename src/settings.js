const EXT_ID = 'GalleryPlus';

export const FAVORITES_CHANGED_EVENT = 'galleryplus:favorites-changed';

const DEFAULTS = {
  enabled: true,
  diag: Date.now(),
  openHeight: 800,
  hoverZoom: false,
  hoverZoomScale: 1.08,
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


const EXT_ID = 'GalleryPlus';

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
  videoLoopTimeSec: 10,
  externalSources: {},
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

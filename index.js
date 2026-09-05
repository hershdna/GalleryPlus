(function () {
  'use strict';

  const EXT_ID = 'GalleryPlus';
  
  const FAVORITES_CHANGED_EVENT = 'galleryplus:favorites-changed';
  
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
  
  function gpSettings() {
    return _settingsBag();
  }
  
  function gpSaveSettings(partial = {}) {
    const c = ctx();
    if (c?.extensionSettings) {
      c.extensionSettings[EXT_ID] = { ..._settingsBag(), ...partial };
      c.saveSettingsDebounced?.();
    } else {
      const merged = { ..._settingsBag(), ...partial };
      localStorage.setItem('GP_SETTINGS', JSON.stringify(merged));
    }
  }
  
  function gpFavoriteGalleryKey(folder = '') {
    return String(folder || '') || '__default__';
  }
  
  function gpFavoriteIdentity(source) {
    try {
      const url = new URL(String(source), location.href);
      return `${url.pathname}${url.search}`;
    } catch {
      return String(source || '');
    }
  }
  
  function gpGetFavoriteSet(folder = '') {
    const favorites = gpSettings().favoritesByGallery;
    const entries = favorites && typeof favorites === 'object'
      ? favorites[gpFavoriteGalleryKey(folder)]
      : null;
    return new Set(Array.isArray(entries) ? entries.map(String) : []);
  }
  
  function gpToggleFavorite(folder, source) {
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

  const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm'];
  const MEDIA_DISPLAYED_EVENT = 'galleryplus:media-displayed';
  
  function isVideoSource(src) {
    try {
      const pathname = new URL(String(src), location.href).pathname;
      const extension = pathname.split('.').pop()?.toLowerCase();
      return VIDEO_EXTENSIONS.includes(extension);
    } catch {
      return VIDEO_EXTENSIONS.some(extension => new RegExp(`\\.${extension}(?:$|[?#])`, 'i').test(String(src)));
    }
  }
  
  function getTransitionMs() {
    const delay = gpSettings().slideshowSpeedSec || 3;
    let ms = Math.round((delay * 1000) / 3);
    if (!Number.isFinite(ms) || ms < 450) ms = 450;
    if (ms < 1000) ms = 1000;
    return ms;
  }
  
  function configureMedia(media, src) {
    media.src = src;
    if (media instanceof HTMLVideoElement) {
      media.controls = gpSettings().videoControlsVisible !== false;
      media.autoplay = false;
      media.playsInline = true;
      media.preload = 'auto';
      media.loop = false;
      media.muted = !!gpSettings().videoMuted;
    } else if (media instanceof HTMLImageElement) {
      media.decoding = 'async';
    }
    return media;
  }
  
  function createMedia(src) {
    return configureMedia(
      isVideoSource(src) ? document.createElement('video') : document.createElement('img'),
      src,
    );
  }
  
  function ensureLayerWrap(baseMedia) {
    let wrap = baseMedia.parentElement;
    if (!wrap || !wrap.classList?.contains('gp-layer-wrap')) {
      const nextWrap = document.createElement('div');
      nextWrap.className = 'gp-layer-wrap';
      baseMedia.replaceWith(nextWrap);
      nextWrap.appendChild(baseMedia);
      wrap = nextWrap;
    }
    baseMedia.classList.add('gp-layer', 'base');
    return wrap;
  }
  
  function settleCurrentMedia(root, fallbackMedia) {
    const active = root._gpDisplayedMedia instanceof Element && root._gpDisplayedMedia.isConnected
      ? root._gpDisplayedMedia
      : (root._gpActiveMedia instanceof Element && root._gpActiveMedia.isConnected
        ? root._gpActiveMedia
        : fallbackMedia);
    const wrap = active?.parentElement;
    if (wrap?.classList?.contains('gp-layer-wrap')) {
      wrap.querySelectorAll('.gp-layer').forEach((layer) => {
        if (layer === active) return;
        if (layer instanceof HTMLVideoElement) layer.pause();
        layer.remove();
      });
      active.classList.remove('next');
      active.classList.add('base');
      active.style.opacity = '';
      active.style.transition = '';
    }
    root._gpDisplayedMedia = active;
    return active;
  }
  
  function beginTransition(root, fallbackMedia) {
    const baseMedia = settleCurrentMedia(root, fallbackMedia);
    const id = (Number(root._gpTransitionId) || 0) + 1;
    root._gpTransitionId = id;
    return { id, baseMedia };
  }
  
  function waitForMediaReady(media) {
    if (media instanceof HTMLImageElement) {
      const decode = () => typeof media.decode === 'function'
        ? media.decode().catch(() => {})
        : Promise.resolve();
      if (media.complete && media.naturalWidth > 0) return decode();
      return new Promise((resolve, reject) => {
        media.addEventListener('load', resolve, { once: true });
        media.addEventListener('error', reject, { once: true });
      }).then(decode);
    }
  
    if (media instanceof HTMLVideoElement) {
      if (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
      return new Promise((resolve, reject) => {
        media.addEventListener('loadeddata', resolve, { once: true });
        media.addEventListener('error', reject, { once: true });
      });
    }
    return Promise.resolve();
  }
  
  function discardStaleMedia(root, next) {
    if (root._gpActiveMedia === next || root._gpDisplayedMedia === next) return;
    if (next instanceof HTMLVideoElement) next.pause();
    next.remove();
  }
  
  function revealWhenReady(root, id, next, reveal) {
    next.dataset.gpTransitionPending = '1';
    void waitForMediaReady(next).then(() => {
      if (root._gpTransitionId !== id || !next.isConnected) {
        discardStaleMedia(root, next);
        return;
      }
      delete next.dataset.gpTransitionPending;
      reveal();
      next.dispatchEvent(new CustomEvent(MEDIA_DISPLAYED_EVENT));
    }).catch(() => {
      if (root._gpTransitionId !== id) discardStaleMedia(root, next);
      // The viewer's media error handler removes failed files and chooses another.
    });
  }
  
  function transitionTo(root, baseMedia, nextSrc) {
    const requested = root.dataset.gpTransition || gpSettings().slideshowTransition;
    if (requested === 'cut') {
      return transitionCut(root, baseMedia, nextSrc);
    } else {
      return transitionFade(root, baseMedia, nextSrc);
    }
  }
  
  function transitionCut(root, fallbackMedia, nextSrc) {
    const { id, baseMedia } = beginTransition(root, fallbackMedia);
    const wrap = ensureLayerWrap(baseMedia);
    const next = createMedia(nextSrc);
    next.className = 'gp-layer next';
    next.style.opacity = '0';
    wrap.appendChild(next);
    root._gpActiveMedia = next;
    revealWhenReady(root, id, next, () => {
      root._gpDisplayedMedia = next;
      if (baseMedia instanceof HTMLVideoElement) baseMedia.pause();
      baseMedia.remove();
      next.classList.remove('next');
      next.classList.add('base');
      next.style.opacity = '';
    });
    return next;
  }
  
  function transitionFade(root, fallbackMedia, nextSrc) {
    const { id, baseMedia } = beginTransition(root, fallbackMedia);
    const wrap = ensureLayerWrap(baseMedia);
    const next = createMedia(nextSrc);
    next.className = 'gp-layer next';
    next.style.opacity = '0';
    wrap.appendChild(next);
    root._gpActiveMedia = next;
  
    const ms = getTransitionMs();
    revealWhenReady(root, id, next, () => {
      root._gpDisplayedMedia = next;
      if (baseMedia instanceof HTMLVideoElement) baseMedia.pause();
      next.style.transition = `opacity ${ms}ms ease`;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { next.style.opacity = '1'; });
      });
      setTimeout(() => {
        if (root._gpTransitionId !== id) {
          discardStaleMedia(root, next);
          return;
        }
        if (baseMedia instanceof HTMLVideoElement) baseMedia.pause();
        baseMedia.remove();
        next.classList.remove('next');
        next.classList.add('base');
        next.style.opacity = '';
        next.style.transition = '';
      }, ms + 50);
    });
    return next;
  }

  const GALLERY_FILE_TYPES = ['bmp', 'gif', 'jfif', 'jpeg', 'jpg', 'png', 'webp', 'mov', 'mp4', 'webm'];
  const MEDIA_LOAD_TIMEOUT_MS = 10000;
  
  function wireViewer(root) {
    if (!root || root.dataset.gpWired === '1') return;
  
    const pcBar = root.querySelector('.panelControlBar');
    if (!pcBar) return;
  
    injectLeftControls(root, pcBar);
    root.dataset.gpWired = '1';
  
    const setupSteps = [
      ['gallery list', initializeGalleryList],
      ['zoom and pan', wireZoomAndPan],
      ['keyboard navigation', wireKeyboardNav],
      ['default viewer position', applyDefaultRect],
      ['fullscreen state', wireFullscreenStateSync],
    ];
  
    for (const [name, setup] of setupSteps) {
      try {
        setup(root);
      } catch (error) {
        console.error(`[GalleryPlus] Failed to initialize ${name}`, error);
      }
    }
  }
  
  function injectLeftControls(root, pcBar) {
    let left = root.querySelector(':scope > .gp-controls-left');
    if (!left) {
      left = document.createElement('div');
      left.className = 'gp-controls-left';
      root.insertBefore(left, pcBar);
    } else {
      left.innerHTML = '';
    }
  
    let progressRow = root.querySelector(':scope > .gp-progress-row');
    if (!progressRow) {
      progressRow = document.createElement('div');
      progressRow.className = 'gp-progress-row';
      root.insertBefore(progressRow, pcBar);
    } else {
      progressRow.innerHTML = '';
    }
  
    // 💾 save default size/pos
    const saveBtn = document.createElement('button');
    saveBtn.className = 'gp-btn gp-save';
    const saveTip = 'Save as default size and location';
    saveBtn.title = saveTip;
    saveBtn.setAttribute('aria-label', saveTip);
    const saveIcon = document.createElement('span');
    saveIcon.setAttribute('aria-hidden', 'true');
    saveIcon.textContent = '💾';
    saveBtn.appendChild(saveIcon);
    saveBtn.addEventListener('click', () => saveDefaultRect(root));
  
    // 🔍 toggle hover zoom
    const zoomBtn = document.createElement('button');
    zoomBtn.className = 'gp-btn gp-zoom';
    const zoomTip = 'Toggle hover zoom (off = scroll zoom + pan)';
    zoomBtn.title = zoomTip;
    zoomBtn.setAttribute('aria-label', zoomTip);
    const zoomIcon = document.createElement('span');
    zoomIcon.setAttribute('aria-hidden', 'true');
    zoomIcon.textContent = '🔍';
    zoomBtn.appendChild(zoomIcon);
    zoomBtn.classList.toggle('active', !!gpSettings().hoverZoom);
    zoomBtn.addEventListener('click', () => {
      const ns = !gpSettings().hoverZoom;
      gpSaveSettings({ hoverZoom: ns });
      zoomBtn.classList.toggle('active', ns);
    });
  
    function stepSlideshow(direction) {
      if (direction < 0) goPrev(root); else goNext(root);
    }
  
    // ⏮️ previous image
    const prevBtn = document.createElement('button');
    prevBtn.className = 'gp-btn gp-prev';
    const prevTip = 'Previous image (Ctrl+Left Arrow)';
    prevBtn.title = prevTip;
    prevBtn.setAttribute('aria-label', prevTip);
    const prevIcon = document.createElement('span');
    prevIcon.setAttribute('aria-hidden', 'true');
    prevIcon.textContent = '⏮️';
    prevBtn.appendChild(prevIcon);
    prevBtn.addEventListener('click', () => stepSlideshow(-1));
  
    // ▶️/⏸️ start/pause slideshow
    const playBtn = document.createElement('button');
    playBtn.className = 'gp-btn gp-play';
    const playTip = 'Play slideshow (Ctrl+Space)';
    playBtn.title = playTip;
    playBtn.setAttribute('aria-label', playTip);
    playBtn.setAttribute('aria-pressed', 'false');
    const playIcon = document.createElement('span');
    playIcon.setAttribute('aria-hidden', 'true');
    playIcon.textContent = '▶️';
    playBtn.appendChild(playIcon);
    playBtn.addEventListener('click', () => {
      if (root.dataset.gpPlaying === '1') stopSlideshow(root);
      else startSlideshow(root);
    });
  
    // ⏭️ next image
    const nextBtn = document.createElement('button');
    nextBtn.className = 'gp-btn gp-next';
    const nextTip = 'Next image (Ctrl+Right Arrow)';
    nextBtn.title = nextTip;
    nextBtn.setAttribute('aria-label', nextTip);
    const nextIcon = document.createElement('span');
    nextIcon.setAttribute('aria-hidden', 'true');
    nextIcon.textContent = '⏭️';
    nextBtn.appendChild(nextIcon);
    nextBtn.addEventListener('click', () => stepSlideshow(1));
  
    // 🔀 randomize slideshow order
    const randomBtn = document.createElement('button');
    randomBtn.className = 'gp-btn gp-random';
    const randomTip = 'Toggle randomized slideshow order';
    randomBtn.title = randomTip;
    randomBtn.setAttribute('aria-label', randomTip);
    randomBtn.setAttribute('aria-pressed', 'false');
    const randomIcon = document.createElement('span');
    randomIcon.setAttribute('aria-hidden', 'true');
    randomIcon.textContent = '🔀';
    randomBtn.appendChild(randomIcon);
    randomBtn.addEventListener('click', () => {
      const randomized = toggleRandomizedGalleryOrder(root);
      randomBtn.classList.toggle('active', randomized);
      randomBtn.setAttribute('aria-pressed', String(randomized));
    });
  
    // ⭐ favorite the current item for this gallery
    const favoriteBtn = document.createElement('button');
    favoriteBtn.className = 'gp-btn gp-favorite';
    favoriteBtn.setAttribute('aria-pressed', 'false');
    const favoriteIcon = document.createElement('span');
    favoriteIcon.setAttribute('aria-hidden', 'true');
    favoriteIcon.textContent = '☆';
    favoriteBtn.appendChild(favoriteIcon);
    favoriteBtn.addEventListener('click', () => toggleCurrentFavorite(root));
  
    // Content filter used by sequential and shuffled playback.
    const presentationWrap = document.createElement('label');
    presentationWrap.className = 'gp-presentation-wrap';
    presentationWrap.title = 'Presentation mode';
    const presentationLabel = document.createElement('span');
    presentationLabel.textContent = 'Mode';
    const presentation = document.createElement('select');
    presentation.className = 'gp-presentation-mode';
    presentation.setAttribute('aria-label', 'Presentation mode');
    [
      ['all', 'All media'],
      ['favorites', 'Favorites only'],
      ['images', 'Images only'],
      ['videos', 'Videos only'],
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      presentation.appendChild(option);
    });
    presentation.value = normalizePresentationMode(gpSettings().presentationMode);
    presentation.addEventListener('change', () => {
      const mode = normalizePresentationMode(presentation.value);
      gpSaveSettings({ presentationMode: mode });
      root.dataset.gpPresentationMode = mode;
      applyPresentationMode(root, true);
    });
    presentationWrap.appendChild(presentationLabel);
    presentationWrap.appendChild(presentation);
  
    // 🔊 globally mute/unmute slideshow videos
    const muteBtn = document.createElement('button');
    muteBtn.className = 'gp-btn gp-mute';
    muteBtn.setAttribute('aria-pressed', String(!!gpSettings().videoMuted));
    const muteIcon = document.createElement('span');
    muteIcon.setAttribute('aria-hidden', 'true');
    muteBtn.appendChild(muteIcon);
  
    function refreshMuteButton() {
      const muted = !!gpSettings().videoMuted;
      muteIcon.textContent = muted ? '🔇' : '🔊';
      muteBtn.classList.toggle('active', muted);
      muteBtn.setAttribute('aria-pressed', String(muted));
      muteBtn.title = muted ? 'Unmute all slideshow videos' : 'Mute all slideshow videos';
      muteBtn.setAttribute('aria-label', muteBtn.title);
    }
    muteBtn.addEventListener('click', () => {
      const muted = !gpSettings().videoMuted;
      gpSaveSettings({ videoMuted: muted });
      document.querySelectorAll('.galleryImageDraggable video').forEach((video) => {
        video.muted = muted;
      });
      refreshMuteButton();
    });
    refreshMuteButton();
  
    // Show/hide the browser's native video playback controls.
    const videoControlsBtn = document.createElement('button');
    videoControlsBtn.className = 'gp-btn gp-video-controls';
    const videoControlsIcon = document.createElement('span');
    videoControlsIcon.setAttribute('aria-hidden', 'true');
    videoControlsBtn.appendChild(videoControlsIcon);
  
    function refreshVideoControlsButton() {
      const visible = gpSettings().videoControlsVisible !== false;
      videoControlsIcon.textContent = visible ? '🎛️' : '🚫';
      videoControlsBtn.classList.toggle('active', visible);
      videoControlsBtn.setAttribute('aria-pressed', String(visible));
      videoControlsBtn.title = visible ? 'Hide browser video controls' : 'Show browser video controls';
      videoControlsBtn.setAttribute('aria-label', videoControlsBtn.title);
    }
    videoControlsBtn.addEventListener('click', () => {
      const visible = gpSettings().videoControlsVisible === false;
      gpSaveSettings({ videoControlsVisible: visible });
      document.querySelectorAll('.galleryImageDraggable video').forEach((video) => {
        video.controls = visible;
      });
      refreshVideoControlsButton();
    });
    refreshVideoControlsButton();
  
    // Hide slideshow controls after a short period of pointer inactivity.
    const autoHideBtn = document.createElement('button');
    autoHideBtn.className = 'gp-btn gp-auto-hide';
    autoHideBtn.setAttribute('aria-pressed', String(!!gpSettings().autoHideControls));
    const autoHideIcon = document.createElement('span');
    autoHideIcon.setAttribute('aria-hidden', 'true');
    autoHideBtn.appendChild(autoHideIcon);
  
    function refreshAutoHideButton() {
      const enabled = root.dataset.gpAutoHideControls === '1';
      autoHideIcon.textContent = enabled ? '🫥' : '👁️';
      autoHideBtn.classList.toggle('active', enabled);
      autoHideBtn.setAttribute('aria-pressed', String(enabled));
      autoHideBtn.title = enabled ? 'Disable auto-hide slideshow controls' : 'Enable auto-hide slideshow controls';
      autoHideBtn.setAttribute('aria-label', autoHideBtn.title);
    }
    autoHideBtn.addEventListener('click', () => {
      const enabled = root.dataset.gpAutoHideControls !== '1';
      gpSaveSettings({ autoHideControls: enabled });
      setAutoHideControls(root, enabled);
      refreshAutoHideButton();
    });
    setAutoHideControls(root, !!gpSettings().autoHideControls);
    refreshAutoHideButton();
  
    // minimum total video play time; advancement always waits for a loop boundary
    const videoLoopWrap = document.createElement('label');
    videoLoopWrap.className = 'gp-video-loop-wrap';
    videoLoopWrap.title = 'Minimum video play time; short videos repeat to the next completed loop';
    const videoLoopLabel = document.createElement('span');
    videoLoopLabel.textContent = 'Video';
    const videoLoop = document.createElement('input');
    videoLoop.type = 'number';
    videoLoop.min = '0';
    videoLoop.max = '3600';
    videoLoop.step = '1';
    videoLoop.className = 'gp-video-loop';
    videoLoop.value = String(gpSettings().videoLoopTimeSec ?? 10);
    videoLoop.setAttribute('aria-label', 'Minimum video play time in seconds');
    const videoLoopUnit = document.createElement('span');
    videoLoopUnit.textContent = 's';
    videoLoop.addEventListener('input', () => {
      const value = Number(videoLoop.value);
      if (Number.isFinite(value) && value >= 0 && value <= 3600) {
        gpSaveSettings({ videoLoopTimeSec: value });
      }
    });
    videoLoop.addEventListener('change', () => {
      let value = Number(videoLoop.value);
      if (!Number.isFinite(value) || value < 0) value = 0;
      if (value > 3600) value = 3600;
      videoLoop.value = String(value);
      gpSaveSettings({ videoLoopTimeSec: value });
    });
    videoLoopWrap.appendChild(videoLoopLabel);
    videoLoopWrap.appendChild(videoLoop);
    videoLoopWrap.appendChild(videoLoopUnit);
  
    // ⛶ fullscreen
    const fsBtn = document.createElement('button');
    fsBtn.className = 'gp-btn gp-fs';
    const fsTip = 'Fullscreen slideshow';
    fsBtn.title = fsTip;
    fsBtn.setAttribute('aria-label', fsTip);
    const fsIcon = document.createElement('span');
    fsIcon.setAttribute('aria-hidden', 'true');
    fsIcon.textContent = '⛶';
    fsBtn.appendChild(fsIcon);
    fsBtn.addEventListener('click', () => toggleFullscreen(root));
  
    // image slideshow delay
    const speedWrap = document.createElement('label');
    speedWrap.className = 'gp-speed-wrap';
    speedWrap.title = 'Image slideshow delay in seconds';
    const speedLabel = document.createElement('span');
    speedLabel.textContent = 'Image';
    const speed = document.createElement('input');
    speed.type = 'number';
    speed.min = '0.1';
    speed.max = '3600';
    speed.step = '0.1';
    speed.className = 'gp-speed';
    speed.value = String(gpSettings().slideshowSpeedSec ?? 3);
    speed.setAttribute('aria-label', 'Image slideshow delay in seconds');
    const speedUnit = document.createElement('span');
    speedUnit.textContent = 's';
    speed.addEventListener('input', () => {
      const value = Number(speed.value);
      if (Number.isFinite(value) && value >= 0.1 && value <= 3600) {
        gpSaveSettings({ slideshowSpeedSec: value });
      }
    });
    speed.addEventListener('change', () => {
      let v = parseFloat(speed.value);
      if (!Number.isFinite(v) || v < 0.1) v = 0.1;
      if (v > 3600) v = 3600;
      speed.value = String(v);
      gpSaveSettings({ slideshowSpeedSec: v });
      if (root.dataset.gpPlaying === '1' && !(currentMedia(root) instanceof HTMLVideoElement)) {
        scheduleCurrentMedia(root, false);
      }
    });
    speedWrap.appendChild(speedLabel);
    speedWrap.appendChild(speed);
    speedWrap.appendChild(speedUnit);
  
    // Current slide and direct position control.
    const progressWrap = document.createElement('label');
    progressWrap.className = 'gp-progress-wrap';
    progressWrap.title = 'Slideshow position';
    const progress = document.createElement('input');
    progress.type = 'range';
    progress.min = '1';
    progress.max = '1';
    progress.step = '1';
    progress.value = '1';
    progress.className = 'gp-progress';
    progress.setAttribute('aria-label', 'Slideshow position');
    const progressValue = document.createElement('output');
    progressValue.className = 'gp-progress-value';
    progressValue.setAttribute('aria-live', 'polite');
    progress.addEventListener('input', () => {
      showGalleryIndex(root, Number(progress.value) - 1);
    });
    progressWrap.appendChild(progress);
    progressWrap.appendChild(progressValue);
  
    // transition select
    const sel = document.createElement('select');
    sel.className = 'gp-transition';
    sel.title = 'Transition style';
    const savedTransition = gpSettings().slideshowTransition;
    const initialTransition = savedTransition === 'cut' ? 'cut' : 'fade';
    if (savedTransition !== initialTransition) {
      gpSaveSettings({ slideshowTransition: initialTransition });
    }
    [
      ['cut', 'Cut'],
      ['fade', 'Fade'],
    ].forEach(([v, lbl]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = lbl;
      if (initialTransition === v) o.selected = true;
      sel.appendChild(o);
    });
    root.dataset.gpTransition = initialTransition;
    sel.addEventListener('change', () => {
      const v = sel.value;
      root.dataset.gpTransition = v;
      gpSaveSettings({ slideshowTransition: v });
    });
  
    left.appendChild(saveBtn);
    left.appendChild(zoomBtn);
    left.appendChild(prevBtn);
    left.appendChild(playBtn);
    left.appendChild(nextBtn);
    left.appendChild(randomBtn);
    left.appendChild(favoriteBtn);
    left.appendChild(muteBtn);
    left.appendChild(videoControlsBtn);
    left.appendChild(autoHideBtn);
    left.appendChild(fsBtn);
    left.appendChild(speedWrap);
    left.appendChild(videoLoopWrap);
    left.appendChild(presentationWrap);
    left.appendChild(sel);
    progressRow.appendChild(progressWrap);
    updateSlideshowButton(root);
    updateProgressControl(root);
    updateFavoriteButton(root);
  }
  function saveDefaultRect(root) {
    const st = root.style;
    const rect = {
      top: st.top || (root.offsetTop + 'px'),
      left: st.left || (root.offsetLeft + 'px'),
      width: st.width || (root.clientWidth + 'px'),
      height: st.height || (root.clientHeight + 'px'),
    };
    gpSaveSettings({ viewerRect: rect });
    root.classList.add('gp-saved-pulse');
    setTimeout(() => root.classList.remove('gp-saved-pulse'), 350);
  }
  
  function applyDefaultRect(root) {
    const r = gpSettings().viewerRect;
    if (!r) return;
    const st = root.style;
    st.top = r.top; st.left = r.left; st.width = r.width; st.height = r.height;
  }
  
  function wireZoomAndPan(root) {
    let scale = 1;
    let tx = 0, ty = 0;
  
    let isPanning = false;
    let panStartX = 0, panStartY = 0;
    let panBaseX = 0, panBaseY = 0;
  
    function getImage() {
      const media = currentMedia(root);
      return media instanceof HTMLImageElement ? media : null;
    }
  
    function applyTransform() {
      const img = getImage();
      if (!img) return;
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      img.style.transformOrigin = 'center center';
      img.style.willChange = 'transform';
    }
  
    function onWheel(e) {
      if (gpSettings().hoverZoom) return;
      const img = getImage();
      if (!img) return;
      if (!e.ctrlKey) {
        e.preventDefault();
        const delta = -Math.sign(e.deltaY) * 0.1;
        const newScale = Math.min(8, Math.max(0.1, scale + delta));
        if (newScale !== scale) {
          const rect = img.getBoundingClientRect();
          const cx = e.clientX - rect.left;
          const cy = e.clientY - rect.top;
          const dx = (cx - rect.width / 2) / scale;
          const dy = (cy - rect.height / 2) / scale;
          tx -= dx * (newScale - scale);
          ty -= dy * (newScale - scale);
          scale = newScale;
          applyTransform();
        }
      }
    }
  
    function onMoveHover(e) {
      if (!gpSettings().hoverZoom) return;
      const img = getImage();
      if (!img) return;
      const rect = img.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width - 0.5) * -1;
      const ny = ((e.clientY - rect.top) / rect.height - 0.5) * -1;
      const z = gpSettings().hoverZoomScale || 1.08;
      scale = z;
      tx = nx * rect.width * 0.05;
      ty = ny * rect.height * 0.05;
      applyTransform();
    }
    function onLeaveHover() {
      if (!gpSettings().hoverZoom) return;
      scale = 1; tx = 0; ty = 0;
      applyTransform();
    }
  
    function onMouseDown(e) {
      if (gpSettings().hoverZoom) return;
      if (e.button !== 0) return;
      if (scale <= 1.001) return;
      const img = getImage();
      if (!img || e.target !== img) return;
      isPanning = true;
      root.classList.add('gp-panning');
      panStartX = e.clientX;
      panStartY = e.clientY;
      panBaseX = tx;
      panBaseY = ty;
      e.preventDefault();
      window.addEventListener('mousemove', onMouseMovePan);
      window.addEventListener('mouseup', onMouseUpPan, { once: true });
    }
    function onMouseMovePan(e) {
      if (!isPanning) return;
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      tx = panBaseX + dx;
      ty = panBaseY + dy;
      applyTransform();
    }
    function onMouseUpPan() {
      isPanning = false;
      root.classList.remove('gp-panning');
      window.removeEventListener('mousemove', onMouseMovePan);
    }
  
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('mousemove', onMoveHover);
    root.addEventListener('mouseleave', onLeaveHover);
    root.addEventListener('mousedown', onMouseDown);
  
    applyTransform();
  }
  
  function wireKeyboardNav(root) {
    function handler(e) {
      if (!document.body.contains(root)) {
        window.removeEventListener('keydown', handler, true);
        return;
      }
      if (e.key === 'Escape') {
        root.querySelector('.dragClose')?.click();
        return;
      }
      if (!e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
  
      let handled = true;
      if (e.code === 'ArrowRight' || e.key === 'ArrowRight') goNext(root);
      else if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') goPrev(root);
      else if (e.code === 'Space' || e.key === ' ') {
        root.dataset.gpPlaying === '1' ? stopSlideshow(root) : startSlideshow(root);
      } else handled = false;
  
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    // Capture before SillyTavern and browser-history handlers can consume Ctrl+Arrow.
    window.addEventListener('keydown', handler, true);
  }
  
  function toggleFullscreen(root) {
    const isFS = document.fullscreenElement === root;
    if (isFS) {
      document.exitFullscreen?.();
    } else {
      root.requestFullscreen?.({ navigationUI: 'hide' }).catch(()=>{});
    }
  }
  
  function wireFullscreenStateSync(root) {
    function onFSChange() {
      const isFS = document.fullscreenElement === root;
      root.classList.toggle('gp-fullscreen', isFS);
    }
    document.addEventListener('fullscreenchange', onFSChange);
    const obs = new MutationObserver(() => {
      if (!document.body.contains(root)) {
        document.removeEventListener('fullscreenchange', onFSChange);
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  
  function startSlideshow(root) {
    root.dataset.gpPlaying = '1';
    updateSlideshowButton(root);
    scheduleCurrentMedia(root, false);
    scheduleAutoHideControls(root);
  }
  function stopSlideshow(root) {
    root.dataset.gpPlaying = '0';
    updateSlideshowButton(root);
    clearSlideshowTimer(root);
    revealSlideshowControls(root);
    const media = currentMedia(root);
    if (media instanceof HTMLVideoElement) media.pause();
  }
  
  function setAutoHideControls(root, enabled) {
    root.dataset.gpAutoHideControls = enabled ? '1' : '0';
    if (root.dataset.gpAutoHideWired !== '1') {
      root.dataset.gpAutoHideWired = '1';
      const reveal = () => {
        revealSlideshowControls(root);
        scheduleAutoHideControls(root);
      };
      root.addEventListener('pointermove', reveal, { passive: true });
      root.addEventListener('pointerdown', reveal, { passive: true });
      root.addEventListener('focusin', reveal);
    }
    revealSlideshowControls(root);
    scheduleAutoHideControls(root);
  }
  
  function revealSlideshowControls(root) {
    clearTimeout(root._gpAutoHideTimer);
    root._gpAutoHideTimer = null;
    root.classList.remove('gp-controls-hidden');
  }
  
  function scheduleAutoHideControls(root) {
    clearTimeout(root._gpAutoHideTimer);
    root._gpAutoHideTimer = null;
    if (root.dataset.gpAutoHideControls !== '1' || root.dataset.gpPlaying !== '1') return;
    root._gpAutoHideTimer = setTimeout(() => {
      if (root.dataset.gpAutoHideControls === '1' && root.dataset.gpPlaying === '1') {
        root.classList.add('gp-controls-hidden');
      }
    }, 2200);
  }
  
  function updateSlideshowButton(root) {
    const button = root.querySelector('.gp-play');
    if (!(button instanceof HTMLButtonElement)) return;
    const playing = root.dataset.gpPlaying === '1';
    const label = playing ? 'Pause slideshow (Ctrl+Space)' : 'Play slideshow (Ctrl+Space)';
    button.classList.toggle('active', playing);
    button.setAttribute('aria-pressed', String(playing));
    button.title = label;
    button.setAttribute('aria-label', label);
    const icon = button.querySelector('[aria-hidden="true"]');
    if (icon) icon.textContent = playing ? '⏸️' : '▶️';
  }
  
  function clearSlideshowTimer(root) {
    if (!root._gpTimer) return;
    clearTimeout(root._gpTimer);
    root._gpTimer = null;
  }
  
  function detachVideoTracking(root) {
    const tracked = root._gpTrackedVideo;
    if (!(tracked instanceof HTMLVideoElement)) return;
    if (root._gpVideoEndedHandler) tracked.removeEventListener('ended', root._gpVideoEndedHandler);
    root._gpTrackedVideo = null;
    root._gpVideoEndedHandler = null;
  }
  
  function configureVideo(root, video, resetProgress) {
    clearSlideshowTimer(root);
    video.controls = gpSettings().videoControlsVisible !== false;
    video.playsInline = true;
    video.preload = 'auto';
    video.loop = false;
    video.muted = !!gpSettings().videoMuted;
  
    if (root._gpTrackedVideo !== video) {
      detachVideoTracking(root);
      root._gpTrackedVideo = video;
      root._gpVideoCompletedSec = 0;
      root._gpVideoEndedHandler = () => {
        if (root.dataset.gpPlaying !== '1' || currentMedia(root) !== video) return;
        const duration = Number(video.duration);
        if (!Number.isFinite(duration) || duration <= 0) {
          goNext(root);
          return;
        }
  
        root._gpVideoCompletedSec = (Number(root._gpVideoCompletedSec) || 0) + duration;
        const minimum = Math.max(0, Number(gpSettings().videoLoopTimeSec) || 0);
        if (root._gpVideoCompletedSec + 0.01 >= minimum) {
          goNext(root);
          return;
        }
  
        video.currentTime = 0;
        video.play().catch(() => {});
      };
      video.addEventListener('ended', root._gpVideoEndedHandler);
    } else if (resetProgress) {
      root._gpVideoCompletedSec = 0;
    }
  
    if (root.dataset.gpPlaying === '1') video.play().catch(() => {});
  }
  
  function scheduleCurrentMedia(root, resetVideoProgress = true) {
    clearSlideshowTimer(root);
    const media = currentMedia(root);
    if (!media) return;
    root._gpActiveMedia = media;
    updateProgressControl(root);
    updateFavoriteButton(root);
    wireMediaFailureHandling(root, media);
  
    if (media.dataset.gpTransitionPending === '1') {
      if (root._gpPendingScheduleMedia !== media) {
        root._gpPendingScheduleMedia = media;
        media.addEventListener(MEDIA_DISPLAYED_EVENT, () => {
          if (root._gpPendingScheduleMedia === media) root._gpPendingScheduleMedia = null;
          if (currentMedia(root) === media) scheduleCurrentMedia(root, resetVideoProgress);
        }, { once: true });
      }
      return;
    }
    if (root._gpPendingScheduleMedia === media) root._gpPendingScheduleMedia = null;
  
    if (media instanceof HTMLVideoElement) {
      configureVideo(root, media, resetVideoProgress);
      return;
    }
  
    detachVideoTracking(root);
    if (root.dataset.gpPlaying !== '1') return;
    const seconds = Math.max(0.1, Number(gpSettings().slideshowSpeedSec) || 3);
    root._gpTimer = setTimeout(() => {
      root._gpTimer = null;
      if (root.dataset.gpPlaying === '1') goNext(root);
    }, seconds * 1000);
  }
  
  function wireMediaFailureHandling(root, media) {
    if (media._gpFailureHandlingWired) return;
    media._gpFailureHandlingWired = true;
    let handled = false;
    let loadConfirmed = false;
    let metadataTimer = null;
    const failed = () => {
      if (handled) return;
      handled = true;
      clearTimeout(metadataTimer);
      if (!media.isConnected || currentMedia(root) !== media) return;
      const failedUrl = media.currentSrc || media.src;
      root._gpGalleryList = currentGalleryList(root).filter(item => {
        try {
          return new URL(item, location.href).href !== new URL(failedUrl, location.href).href;
        } catch {
          return item !== failedUrl;
        }
      });
      omitFailedExternalMedia(root._gpGalleryFolder, failedUrl);
      if (!root._gpGalleryList.length) {
        stopSlideshow(root);
        return;
      }
      const nextMedia = transitionTo(root, media, root._gpGalleryList[0]);
      root._gpActiveMedia = nextMedia;
      scheduleCurrentMedia(root, true);
    };
    media.addEventListener('error', failed, { once: true });
  
    if (media instanceof HTMLVideoElement) {
      const validateDuration = () => {
        clearTimeout(metadataTimer);
        if (!Number.isFinite(media.duration) || media.duration <= 0) failed();
        else loadConfirmed = true;
      };
      media.addEventListener('loadedmetadata', validateDuration, { once: true });
      if (media.readyState >= 1) validateDuration();
    } else if (media.complete) {
      if (media.naturalWidth > 0) loadConfirmed = true;
      else failed();
    } else {
      media.addEventListener('load', () => {
        loadConfirmed = true;
        clearTimeout(metadataTimer);
      }, { once: true });
    }
    if (!handled && !loadConfirmed) metadataTimer = setTimeout(failed, MEDIA_LOAD_TIMEOUT_MS);
  }
  
  function goNext(root) {
    const media = currentMedia(root);
    let list = currentGalleryList(root);
    if (!media || !list.length) return;
    let i = indexInList(list, media.src);
    if (root.dataset.gpRandomized === '1' && (i < 0 || i === list.length - 1)) {
      list = beginNextShuffleCycle(root, media.src);
      i = indexInList(list, media.src);
    }
    const nextIdx = i >= 0 ? (i + 1) % list.length : 0;
    showGalleryIndex(root, nextIdx);
  }
  function goPrev(root) {
    const list = currentGalleryList(root);
    const media = currentMedia(root);
    if (!media || !list.length) return;
    const i = indexInList(list, media.src);
    const prevIdx = i >= 0 ? (i - 1 + list.length) % list.length : list.length - 1;
    showGalleryIndex(root, prevIdx, -1);
  }
  
  function showGalleryIndex(root, requestedIndex, preloadDirection = 1) {
    const list = currentGalleryList(root);
    const media = currentMedia(root);
    if (!media || !list.length) return;
    const index = Math.max(0, Math.min(list.length - 1, Math.trunc(requestedIndex)));
    if (indexInList(list, media.src) === index) {
      updateProgressControl(root);
      return;
    }
    const nextMedia = transitionTo(root, media, list[index]);
    root._gpActiveMedia = nextMedia;
    scheduleCurrentMedia(root, true);
    const preloadIndex = (index + preloadDirection + list.length) % list.length;
    preload(list[preloadIndex]);
  }
  
  function updateProgressControl(root) {
    const progress = root.querySelector('.gp-progress');
    const output = root.querySelector('.gp-progress-value');
    if (!(progress instanceof HTMLInputElement) || !(output instanceof HTMLOutputElement)) return;
    const list = currentGalleryList(root);
    const media = currentMedia(root);
    const index = media ? indexInList(list, media.src) : -1;
    const position = index >= 0 ? index + 1 : (list.length ? 1 : 0);
    progress.max = String(Math.max(1, list.length));
    progress.value = String(Math.max(1, position));
    progress.disabled = list.length < 2;
    progress.setAttribute('aria-valuetext', `${position} of ${list.length}`);
    output.textContent = `${position} / ${list.length}`;
  }
  
  function currentMedia(root) {
    if (root._gpActiveMedia instanceof Element && root._gpActiveMedia.isConnected) {
      return root._gpActiveMedia;
    }
    return root.querySelector('.gp-layer.base, :scope > video, :scope > img, .gp-layer.next');
  }
  
  function normalizePresentationMode(value) {
    return ['all', 'favorites', 'images', 'videos'].includes(value) ? value : 'all';
  }
  
  function favoriteGalleryKey(root) {
    return gpFavoriteGalleryKey(root._gpGalleryFolder);
  }
  
  function getFavoriteSet(root) {
    return gpGetFavoriteSet(root._gpGalleryFolder);
  }
  
  function isFavoriteSource(root, source) {
    return getFavoriteSet(root).has(gpFavoriteIdentity(source));
  }
  
  function updateFavoriteButton(root) {
    const button = root.querySelector('.gp-favorite');
    if (!(button instanceof HTMLButtonElement)) return;
    const media = currentMedia(root);
    const favorite = !!media && isFavoriteSource(root, media.src);
    button.classList.toggle('active', favorite);
    button.setAttribute('aria-pressed', String(favorite));
    button.title = favorite ? 'Remove current item from favorites' : 'Add current item to favorites';
    button.setAttribute('aria-label', button.title);
    const icon = button.querySelector('[aria-hidden="true"]');
    if (icon) icon.textContent = favorite ? '★' : '☆';
  }
  
  function toggleCurrentFavorite(root) {
    const media = currentMedia(root);
    if (!media?.src) return;
    gpToggleFavorite(root._gpGalleryFolder, media.src);
  }
  
  function filterPresentationList(root, sourceList) {
    const mode = normalizePresentationMode(root.dataset.gpPresentationMode || gpSettings().presentationMode);
    if (mode === 'images') return sourceList.filter(source => !isVideoSource(source));
    if (mode === 'videos') return sourceList.filter(isVideoSource);
    if (mode === 'favorites') {
      const favorites = getFavoriteSet(root);
      return sourceList.filter(source => favorites.has(gpFavoriteIdentity(source)));
    }
    return [...sourceList];
  }
  
  function applyPresentationMode(root, navigateIfExcluded = false) {
    const sourceList = Array.isArray(root._gpSourceGalleryList)
      ? root._gpSourceGalleryList
      : (Array.isArray(root._gpCanonicalGalleryList) ? root._gpCanonicalGalleryList : currentGalleryList(root));
    const filtered = filterPresentationList(root, sourceList);
    root._gpCanonicalGalleryList = [...filtered];
  
    const media = currentMedia(root);
    const currentIndex = media ? indexInList(filtered, media.src) : -1;
    if (root.dataset.gpRandomized === '1') {
      const shuffled = [...filtered];
      const current = currentIndex >= 0 ? shuffled.splice(currentIndex, 1)[0] : null;
      shuffleInPlace(shuffled);
      root._gpGalleryList = current ? [current, ...shuffled] : shuffled;
    } else {
      root._gpGalleryList = [...filtered];
    }
  
    if (navigateIfExcluded && media && currentIndex < 0) {
      if (root._gpGalleryList.length) {
        const nextMedia = transitionTo(root, media, root._gpGalleryList[0]);
        root._gpActiveMedia = nextMedia;
        scheduleCurrentMedia(root, true);
      } else {
        stopSlideshow(root);
      }
    }
    updateProgressControl(root);
    updateFavoriteButton(root);
  }
  
  function toggleRandomizedGalleryOrder(root) {
    if (root.dataset.gpRandomized === '1') {
      root.dataset.gpRandomized = '0';
      const canonical = Array.isArray(root._gpCanonicalGalleryList)
        ? root._gpCanonicalGalleryList
        : currentGalleryList(root);
      root._gpGalleryList = [...canonical];
      updateProgressControl(root);
      return false;
    }
  
    const list = [...currentGalleryList(root)];
    if (list.length < 2) return false;
  
    if (!Array.isArray(root._gpCanonicalGalleryList)) {
      root._gpCanonicalGalleryList = [...list];
    }
  
    const media = currentMedia(root);
    const currentIndex = media ? indexInList(list, media.src) : -1;
    const current = currentIndex >= 0 ? list.splice(currentIndex, 1)[0] : null;
    shuffleInPlace(list);
    root._gpGalleryList = current ? [current, ...list] : list;
    root.dataset.gpRandomized = '1';
    updateProgressControl(root);
    return true;
  }
  
  function beginNextShuffleCycle(root, currentSource) {
    const canonical = Array.isArray(root._gpCanonicalGalleryList)
      ? [...root._gpCanonicalGalleryList]
      : [...currentGalleryList(root)];
    const currentIndex = indexInList(canonical, currentSource);
    const current = currentIndex >= 0 ? canonical.splice(currentIndex, 1)[0] : null;
    shuffleInPlace(canonical);
    root._gpGalleryList = current ? [current, ...canonical] : canonical;
    updateProgressControl(root);
    return root._gpGalleryList;
  }
  
  function shuffleInPlace(items) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
  
  function initializeGalleryList(root) {
    const folderInput = document.querySelector('#gallery .gallery-folder-input');
    root._gpGalleryFolder = folderInput && 'value' in folderInput
      ? String(folderInput.value || '')
      : '';
    root.dataset.gpPresentationMode = normalizePresentationMode(gpSettings().presentationMode);
    const galleryList = readGalleryDataList() ?? readVisibleGalleryList();
    root._gpSourceGalleryList = [...galleryList];
    root._gpCanonicalGalleryList = filterPresentationList(root, galleryList);
    root._gpGalleryList = [...root._gpCanonicalGalleryList];
    root.dataset.gpRandomized = '0';
  
    const onFavoritesChanged = (event) => {
      if (event.detail?.galleryKey !== favoriteGalleryKey(root)) return;
      if (!root.isConnected) {
        document.removeEventListener(FAVORITES_CHANGED_EVENT, onFavoritesChanged);
        return;
      }
      updateFavoriteButton(root);
      if (root.dataset.gpPresentationMode === 'favorites') applyPresentationMode(root, true);
    };
    document.addEventListener(FAVORITES_CHANGED_EVENT, onFavoritesChanged);
  
    const media = currentMedia(root);
    root._gpActiveMedia = media;
    if (media instanceof HTMLVideoElement) {
      media.muted = !!gpSettings().videoMuted;
      media.loop = false;
      media.controls = gpSettings().videoControlsVisible !== false;
    }
    try {
      root._gpGalleryBaseUrl = root._gpGalleryFolder
        ? new URL(`/user/images/${encodeURIComponent(root._gpGalleryFolder)}/`, location.origin).href
        : (media?.src ? new URL('.', media.src).href : '');
    } catch {
      root._gpGalleryBaseUrl = '';
    }
  
    scheduleGalleryListSync(root);
    applyPresentationMode(root, true);
    updateProgressControl(root);
    updateFavoriteButton(root);
  }
  
  function scheduleGalleryListSync(root) {
    async function sync() {
      root._gpListTimer = null;
      if (!document.body.contains(root)) return;
  
      await refreshGalleryList(root);
  
      if (document.body.contains(root)) {
        root._gpListTimer = setTimeout(sync, 2000);
      }
    }
  
    root._gpListTimer = setTimeout(sync, 2000);
  }
  
  async function refreshGalleryList(root) {
    const updated = await fetchGalleryList(root);
    if (updated === null) return;
  
    root._gpSourceGalleryList = [...updated];
    const filtered = filterPresentationList(root, updated);
    root._gpCanonicalGalleryList = [...filtered];
    const current = Array.isArray(root._gpGalleryList) ? root._gpGalleryList : [];
    const next = root.dataset.gpRandomized === '1'
      ? mergeRandomizedGalleryList(root, current, filtered)
      : filtered;
    if (!sameGalleryList(current, next)) {
      root._gpGalleryList = next;
    }
    updateProgressControl(root);
    updateFavoriteButton(root);
  }
  
  function mergeRandomizedGalleryList(root, current, updated) {
    const available = new Set(updated);
    const merged = current.filter(item => available.has(item));
    const included = new Set(merged);
    const added = shuffleInPlace(updated.filter(item => !included.has(item)));
    const media = currentMedia(root);
    const currentIndex = media ? indexInList(merged, media.src) : -1;
    const firstUnplayedIndex = Math.max(0, currentIndex + 1);
  
    for (const item of added) {
      const insertAt = firstUnplayedIndex
        + Math.floor(Math.random() * (merged.length - firstUnplayedIndex + 1));
      merged.splice(insertAt, 0, item);
    }
    return merged;
  }
  
  async function fetchGalleryList(root) {
    const context = getSillyTavernContext();
    if (root._gpGalleryFolder && root._gpGalleryBaseUrl) {
      try {
        const sortValue = context?.extensionSettings?.gallery?.sort ?? 'dateAsc';
        const [sortField, sortOrder] = {
          nameAsc: ['name', 'asc'],
          nameDesc: ['name', 'desc'],
          dateDesc: ['date', 'desc'],
          dateAsc: ['date', 'asc'],
        }[sortValue] ?? ['date', 'asc'];
  
        const response = await fetch('/api/images/list', {
          method: 'POST',
          headers: context?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folder: root._gpGalleryFolder,
            sortField,
            sortOrder,
            type: 0b011,
          }),
        });
        if (!response.ok) return await fetchGalleryListFromCommand(context, root._gpGalleryFolder);
  
        const files = await response.json();
        if (!Array.isArray(files)) return null;
        const allFiles = [...files, ...getCachedExternalGalleryPaths(root._gpGalleryFolder)];
        return normalizeGalleryUrls(allFiles.map(file => new URL(String(file), root._gpGalleryBaseUrl).href));
      } catch {
        // Fall through to SillyTavern's gallery command for compatibility.
      }
    }
  
    return await fetchGalleryListFromCommand(context, root._gpGalleryFolder);
  }
  
  async function fetchGalleryListFromCommand(context, folder = '') {
    if (typeof context?.executeSlashCommandsWithOptions !== 'function') return null;
  
    try {
      const result = await context.executeSlashCommandsWithOptions('/list-gallery', {
        handleParserErrors: false,
        handleExecutionErrors: false,
        source: 'GalleryPlus',
      });
      const value = result?.pipe;
      const items = Array.isArray(value) ? value : JSON.parse(value);
      return Array.isArray(items) ? filterGalleryUrls(folder, normalizeGalleryUrls(items)) : null;
    } catch {
      return null;
    }
  }
  
  function filterGalleryUrls(folder, items) {
    const filters = gpSettings().fileTypeFilters;
    if (!folder || !filters || !Object.prototype.hasOwnProperty.call(filters, folder)) return items;
    const stored = Array.isArray(filters[folder]) ? filters[folder] : GALLERY_FILE_TYPES;
    const enabled = new Set(stored.map(type => String(type).toLowerCase()));
    return items.filter((item) => {
      try {
        const name = decodeURIComponent(new URL(item, location.href).pathname.split('/').pop() || '');
        return enabled.has(name.split('.').pop()?.toLowerCase());
      } catch {
        return false;
      }
    });
  }
  
  function getSillyTavernContext() {
    try {
      return window.SillyTavern?.getContext?.() ?? null;
    } catch {
      return null;
    }
  }
  
  function readGalleryDataList() {
    const jq = window.jQuery || window.$;
    if (typeof jq !== 'function') return null;
  
    const gallery = jq('#dragGallery');
    if (!gallery.length || typeof gallery.nanogallery2 !== 'function') return null;
  
    try {
      const items = gallery.nanogallery2('data')?.items;
      if (!Array.isArray(items)) return null;
      return normalizeGalleryUrls(items.map(item => (
        typeof item?.responsiveURL === 'function' ? item.responsiveURL() : item?.src
      )));
    } catch {
      return null;
    }
  }
  
  function readVisibleGalleryList() {
    const out = [];
    const thumbs = document.querySelectorAll('#dragGallery img.nGY2GThumbnailImg, #dragGallery .nGY2GThumbnailImage.nGY2TnImg');
    thumbs.forEach(t => {
      if (t instanceof HTMLImageElement && t.src) out.push(t.src);
      else if (t instanceof HTMLElement) {
        const bg = t.style.backgroundImage || '';
        const m = bg.match(/url\(["']?(.+?)["']?\)/);
        if (m) out.push(m[1]);
      }
    });
    return normalizeGalleryUrls(out);
  }
  
  function normalizeGalleryUrls(items) {
    const out = [];
    const seen = new Set();
    for (const item of items) {
      if (typeof item !== 'string' || !item) continue;
      let url = item;
      try {
        url = new URL(item, location.href).href;
      } catch {
        // Keep the original value if URL normalization fails.
      }
      if (!seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
    return out;
  }
  
  function sameGalleryList(a, b) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  
  function currentGalleryList(root) {
    if (!Array.isArray(root._gpGalleryList)) {
      root._gpGalleryList = readGalleryDataList() ?? readVisibleGalleryList();
    }
    return root._gpGalleryList;
  }
  function indexInList(list, src) {
    const norm = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
    const target = norm(src);
    return list.findIndex(u => norm(u) === target);
  }
  
  function preload(src) {
    if (!src) return;
    if (isVideoSource(src)) {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.src = src;
      return;
    }
    const i = new Image();
    i.decoding = 'async';
    i.loading = 'eager';
    i.src = src;
  }

  const CUSTOM_SORT = 'custom';
  const ARCHIVE_ENDPOINT = '/api/plugins/galleryplus/archive';
  const OPEN_FOLDER_ENDPOINT = '/api/plugins/galleryplus/open-folder';
  const EXTERNAL_LIST_ENDPOINT = '/api/plugins/galleryplus/external-media/list';
  const SOURCE_FOLDERS_ENDPOINT = '/api/plugins/galleryplus/source-folders/list';
  const EXTERNAL_FILE_PREFIX = '/api/plugins/galleryplus/external-media/file/';
  const SERVER_HEALTH_ENDPOINT = '/api/plugins/galleryplus/health';
  const IMAGE_FILE_TYPES = ['bmp', 'gif', 'jfif', 'jpeg', 'jpg', 'png', 'webp'];
  const VIDEO_FILE_TYPES = ['mov', 'mp4', 'webm'];
  const SUPPORTED_FILE_TYPES = [...IMAGE_FILE_TYPES, ...VIDEO_FILE_TYPES];
  const EXTERNAL_CACHE_TTL_MS = 5000;
  const EXTERNAL_VALIDATION_BATCH_SIZE = 6;
  const EXTERNAL_INSERT_BATCH_SIZE = 8;
  const EXTERNAL_RESIZE_INTERVAL_MS = 160;
  const EXTERNAL_MEDIA_TIMEOUT_MS = 10000;
  const EXTERNAL_STATUS_EVENT = 'galleryplus:external-media-status';
  const AUTOMATIC_SOURCES_EVENT = 'galleryplus:automatic-sources-changed';
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
  const automaticSourceLoads = new Map();
  
  function installCustomOrderFetchHook() {
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
  
  function getCachedExternalGalleryPaths(folder) {
    const sources = getExternalSources(folder);
    const cached = getExternalMediaCache(folder, sources);
    return cached ? getVisibleExternalItems(folder, cached.items).map(item => item.galleryPath) : [];
  }
  
  function wireGallery(root) {
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
    installPaginationWheelNavigation(gallery);
    installFailedMediaHandling(root, gallery);
    updateCustomOrderHint(root, sortSelect);
  
    const folder = getGalleryFolder(root);
    const sources = getExternalSources(folder);
    const cached = getExternalMediaCache(folder, sources);
    if (cached) queueOpenGalleryExternalSync(folder, getVisibleExternalItems(folder, cached.items));
    const currentStatus = externalMediaStatus.get(folder);
    if (currentStatus) applyExternalMediaStatus(root, currentStatus);
    void syncAutomaticSourceFolders(root);
  
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
  
  function getAddedGalleryThumbnails(records, gallery) {
    const thumbnails = new Set();
    records.forEach((record) => {
      if (record.target instanceof Element && record.target.closest('.gp-thumbnail-favorite')) return;
      record.addedNodes.forEach((node) => {
        if (!(node instanceof Element) || node.closest('.gp-thumbnail-favorite')) return;
        const containingThumbnail = node.matches('.nGY2GThumbnail')
          ? node
          : node.closest('.nGY2GThumbnail');
        if (containingThumbnail instanceof HTMLElement && gallery.contains(containingThumbnail)) {
          thumbnails.add(containingThumbnail);
        }
        node.querySelectorAll('.nGY2GThumbnail').forEach((thumbnail) => {
          if (thumbnail instanceof HTMLElement) thumbnails.add(thumbnail);
        });
      });
    });
    return thumbnails;
  }
  
  function scheduleGalleryWork(callback) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(callback, { timeout: 50 });
      return;
    }
    setTimeout(callback, 16);
  }
  
  function processGalleryThumbnailsInBatches(thumbnails, root, callback) {
    const pending = [...thumbnails].filter(thumbnail => thumbnail instanceof HTMLElement);
    if (!pending.length) return;
  
    const runBatch = () => {
      if (!root.isConnected) return;
      pending.splice(0, 24).forEach(callback);
      if (pending.length) scheduleGalleryWork(runBatch);
    };
    if (pending.length <= 24) runBatch();
    else scheduleGalleryWork(runBatch);
  }
  
  function installGalleryFavorites(root, gallery) {
    const decorateThumbnail = (thumbnail, folder, favorites) => {
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
    };
  
    const decorateThumbnails = (thumbnails) => {
      const values = [...thumbnails].filter(thumbnail => thumbnail instanceof HTMLElement);
      const folder = getGalleryFolder(root);
      const favorites = gpGetFavoriteSet(folder);
      processGalleryThumbnailsInBatches(values, root, (thumbnail) => {
        decorateThumbnail(thumbnail, folder, favorites);
      });
    };
  
    const refresh = () => {
      decorateThumbnails(gallery.querySelectorAll('.nGY2GThumbnail'));
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
  
    const galleryObserver = new MutationObserver((records) => {
      decorateThumbnails(getAddedGalleryThumbnails(records, gallery));
    });
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
  
  function installPaginationWheelNavigation(gallery) {
    if (gallery.dataset.gpPaginationWheel === '1') return;
    gallery.dataset.gpPaginationWheel = '1';
  
    let lastPageChangeAt = 0;
    gallery.addEventListener('wheel', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const pagination = target?.closest('.nGY2GalleryBottom');
      const hoveredIcon = target?.closest(PAGINATION_ICON_SELECTOR);
      if ((!pagination && !hoveredIcon) || (pagination && !gallery.contains(pagination))) return;
  
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (Math.abs(delta) < 2) return;
      event.preventDefault();
  
      const now = performance.now();
      if (now - lastPageChangeAt < 180) return;
  
      const icons = [...gallery.querySelectorAll(PAGINATION_ICON_SELECTOR)]
        .filter(icon => icon instanceof HTMLElement);
      const currentIndex = icons.findIndex(icon => (
        icon.classList.contains('nGY2paginationRectangleCurrentPage')
        || icon.classList.contains('nGY2paginationDotCurrentPage')
        || icon.classList.contains('nGY2paginationItemCurrentPage')
        || ['page', 'true'].includes(icon.getAttribute('aria-current'))
      ));
      if (currentIndex < 0) return;
  
      const nextIndex = currentIndex + (delta > 0 ? 1 : -1);
      if (nextIndex < 0 || nextIndex >= icons.length) return;
      lastPageChangeAt = now;
      icons[nextIndex].click();
    }, { passive: false });
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
  
    const selectAllButton = document.createElement('button');
    selectAllButton.type = 'button';
    selectAllButton.className = 'menu_button gp-external-source-select-all';
    selectAllButton.textContent = 'Select all';
  
    const selectNoneButton = document.createElement('button');
    selectNoneButton.type = 'button';
    selectNoneButton.className = 'menu_button gp-external-source-select-none';
    selectNoneButton.textContent = 'Select none';
  
    const sourceActions = document.createElement('div');
    sourceActions.className = 'gp-external-source-actions';
    sourceActions.append(addSourceButton, selectAllButton, selectNoneButton);
    label.appendChild(sourceActions);
    panel.appendChild(label);
  
    const help = document.createElement('small');
    help.className = 'gp-external-sources-help';
    help.textContent = 'Source subfolders are linked automatically (except deprecated). Adding the same address manually overrides its Auto link. Uncheck any address to keep it saved but omit its files. Folders include supported images and videos in all subfolders.';
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
    const onAutomaticSourcesChanged = (event) => {
      if (event.detail?.folder !== getGalleryFolder(root) || !dialog.open) return;
      if (dialog.dataset.gpDirty === '1') return;
      const entries = Array.isArray(event.detail.entries) ? event.detail.entries : [];
      renderSourceRows(entries);
      const enabledCount = entries.filter(entry => entry.enabled).length;
      status.textContent = `${enabledCount} of ${entries.length} address${entries.length === 1 ? '' : 'es'} enabled.`;
    };
    window.addEventListener(AUTOMATIC_SOURCES_EVENT, onAutomaticSourcesChanged);
  
    const addSourceRow = (entry = { address: '', enabled: true }) => {
      const row = document.createElement('div');
      row.className = 'gp-external-source-row';
      row.dataset.gpAutomatic = entry.automatic ? '1' : '0';
  
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.className = 'gp-external-source-enabled';
      enabled.checked = entry.enabled !== false;
      enabled.title = 'Enable this address';
      enabled.setAttribute('aria-label', 'Enable this external address');
      enabled.addEventListener('change', () => { dialog.dataset.gpDirty = '1'; });
  
      const address = document.createElement('input');
      address.type = 'text';
      address.className = 'gp-external-source-address text_pole';
      address.value = entry.address || '';
      address.placeholder = 'File or folder address';
      address.spellcheck = false;
      address.setAttribute('aria-label', 'External file or folder address');
      address.readOnly = entry.automatic === true;
      if (address.readOnly) address.title = 'Automatically linked source subfolder';
      address.addEventListener('input', () => { dialog.dataset.gpDirty = '1'; });
      address.addEventListener('paste', (event) => {
        const values = event.clipboardData?.getData('text')
          .split(/\r?\n/)
          .map(value => value.trim())
          .filter(Boolean) || [];
        if (values.length < 2) return;
        event.preventDefault();
        dialog.dataset.gpDirty = '1';
        address.value = values.shift();
        values.forEach(value => addSourceRow({ address: value, enabled: true }));
      });
  
      let trailing;
      if (entry.automatic) {
        trailing = document.createElement('span');
        trailing.className = 'gp-external-source-auto';
        trailing.textContent = 'Auto';
        trailing.title = 'Automatically linked source subfolder';
      } else {
        trailing = document.createElement('button');
        trailing.type = 'button';
        trailing.className = 'gp-external-source-remove';
        trailing.textContent = '×';
        trailing.title = 'Remove address';
        trailing.setAttribute('aria-label', 'Remove external address');
        trailing.addEventListener('click', () => {
          dialog.dataset.gpDirty = '1';
          row.remove();
          if (!sourcesList.children.length) addSourceRow();
        });
      }
  
      row.append(enabled, address, trailing);
      sourcesList.appendChild(row);
      return address;
    };
  
    const renderSourceRows = (entries) => {
      sourcesList.replaceChildren();
      const values = entries.length ? entries : [{ address: '', enabled: true }];
      values.forEach(addSourceRow);
      dialog.dataset.gpDirty = '0';
    };
  
    const readSourceRows = () => {
      const entries = [];
      const indexByAddress = new Map();
      sourcesList.querySelectorAll('.gp-external-source-row').forEach((row) => {
        const address = row.querySelector('.gp-external-source-address')?.value?.trim() || '';
        if (!address) return;
        const entry = {
          address,
          enabled: row.querySelector('.gp-external-source-enabled')?.checked !== false,
          automatic: row.dataset.gpAutomatic === '1',
        };
        const key = externalSourceKey(address);
        const existingIndex = indexByAddress.get(key);
        if (existingIndex === undefined) {
          indexByAddress.set(key, entries.length);
          entries.push(entry);
        } else if (entries[existingIndex].automatic && !entry.automatic) {
          entries[existingIndex] = entry;
        }
      });
      return entries;
    };
  
    const setAllSourcesEnabled = (enabled) => {
      sourcesList.querySelectorAll('.gp-external-source-enabled').forEach((input) => {
        if (input instanceof HTMLInputElement) input.checked = enabled;
      });
      dialog.dataset.gpDirty = '1';
      const entries = readSourceRows();
      status.textContent = `${entries.filter(entry => entry.enabled).length} of ${entries.length} address${entries.length === 1 ? '' : 'es'} enabled.`;
    };
    addSourceButton.addEventListener('click', () => {
      dialog.dataset.gpDirty = '1';
      addSourceRow().focus();
    });
    selectAllButton.addEventListener('click', () => setAllSourcesEnabled(true));
    selectNoneButton.addEventListener('click', () => setAllSourcesEnabled(false));
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
      void syncAutomaticSourceFolders(root);
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
  
      const automaticFolders = getExternalSourceEntries(folder)
        .filter(entry => entry.automatic)
        .map(entry => entry.address);
      const entries = mergeAutomaticSourceEntries(readSourceRows(), automaticFolders);
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
      window.removeEventListener(AUTOMATIC_SOURCES_EVENT, onAutomaticSourcesChanged);
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
  
  function externalSourceKey(value) {
    const address = String(value || '').trim();
    const isWindowsPath = /^[a-z]:[\\/]/i.test(address) || /^\\\\/.test(address);
    if (isWindowsPath) {
      return address.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    }
    return address.replace(/\/+$/, '');
  }
  
  function getExternalSourceEntries(folder) {
    const stored = gpSettings().externalSources?.[folder];
    if (!Array.isArray(stored)) return [];
    const entries = [];
    const indexByAddress = new Map();
    stored.forEach((value) => {
      const address = typeof value === 'string'
        ? value.trim()
        : (typeof value?.address === 'string' ? value.address.trim() : '');
      if (!address) return;
      const entry = {
        address,
        enabled: typeof value === 'string' || value.enabled !== false,
        automatic: typeof value !== 'string' && value.automatic === true,
      };
      const key = externalSourceKey(address);
      const existingIndex = indexByAddress.get(key);
      if (existingIndex === undefined) {
        indexByAddress.set(key, entries.length);
        entries.push(entry);
      } else if (entries[existingIndex].automatic && !entry.automatic) {
        entries[existingIndex] = entry;
      }
    });
    return entries;
  }
  
  function mergeAutomaticSourceEntries(entries, folders) {
    const automaticByAddress = new Map(entries
      .filter(entry => entry.automatic)
      .map(entry => [externalSourceKey(entry.address), entry]));
    const manual = entries.filter(entry => !entry.automatic);
    const manualAddresses = new Set(manual.map(entry => externalSourceKey(entry.address)));
    const seenAutomatic = new Set();
    const automatic = folders
      .filter((address) => {
        if (typeof address !== 'string' || !address.trim()) return false;
        const key = externalSourceKey(address);
        if (manualAddresses.has(key) || seenAutomatic.has(key)) return false;
        seenAutomatic.add(key);
        return true;
      })
      .map((address) => {
        const normalized = address.trim();
        return {
          address: normalized,
          enabled: automaticByAddress.get(externalSourceKey(normalized))?.enabled !== false,
          automatic: true,
        };
      });
    return [...automatic, ...manual];
  }
  
  function saveExternalSourceEntries(folder, entries) {
    if (!folder) return;
    const externalSources = { ...(gpSettings().externalSources || {}) };
    if (entries.length) externalSources[folder] = entries.map(entry => ({
      address: entry.address,
      enabled: entry.enabled !== false,
      ...(entry.automatic ? { automatic: true } : {}),
    }));
    else delete externalSources[folder];
    gpSaveSettings({ externalSources });
  }
  
  async function syncAutomaticSourceFolders(root) {
    const folder = getGalleryFolder(root);
    if (!folder) return [];
    if (automaticSourceLoads.has(folder)) return automaticSourceLoads.get(folder);
  
    const load = (async () => {
      try {
        const response = await window.fetch(SOURCE_FOLDERS_ENDPOINT, {
          method: 'POST',
          headers: getRequestHeaders(),
          body: JSON.stringify({ folder }),
        });
        if (!response.ok) return getExternalSourceEntries(folder);
        const payload = await response.json();
        const folders = Array.isArray(payload?.folders)
          ? payload.folders.filter(value => typeof value === 'string' && value.trim())
          : [];
        const current = getExternalSourceEntries(folder);
        const merged = mergeAutomaticSourceEntries(current, folders);
        const changed = JSON.stringify(current) !== JSON.stringify(merged);
        if (changed) saveExternalSourceEntries(folder, merged);
        window.dispatchEvent(new CustomEvent(AUTOMATIC_SOURCES_EVENT, {
          detail: { folder, entries: merged },
        }));
  
        if (changed) {
          externalMediaCache.delete(folder);
          const sources = merged.filter(entry => entry.enabled).map(entry => entry.address);
          if (sources.length) void loadExternalMediaInBackground(folder, sources, window.fetch, true);
          else {
            queueOpenGalleryExternalSync(folder, []);
            publishExternalMediaStatus(folder, { loading: false, count: 0, errors: [] });
          }
        }
        return merged;
      } catch (error) {
        console.warn('[GalleryPlus] Could not discover gallery source subfolders', error);
        return getExternalSourceEntries(folder);
      } finally {
        automaticSourceLoads.delete(folder);
      }
    })();
    automaticSourceLoads.set(folder, load);
    return load;
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
      let lastResizeAt = 0;
      const resizeGallery = (force = false) => {
        const now = performance.now();
        if (!force && now - lastResizeAt < EXTERNAL_RESIZE_INTERVAL_MS) return;
        galleryApi.nanogallery2('resize');
        lastResizeAt = now;
      };
      const runBatch = () => {
        if (!root.isConnected || root._gpExternalSyncGeneration !== generation) return;
        const batch = operations.splice(0, EXTERNAL_INSERT_BATCH_SIZE);
        batch.forEach(operation => operation());
        if (batch.length) resizeGallery(!operations.length);
        if (operations.length) scheduleGalleryWork(runBatch);
      };
      if (operations.length) scheduleGalleryWork(runBatch);
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
  
  function omitFailedExternalMedia(folder, source) {
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
  
    const decorate = (thumbnails) => {
      processGalleryThumbnailsInBatches(thumbnails, root, (thumbnail) => {
        thumbnail.draggable = true;
        thumbnail.classList.add('gp-reorderable-thumbnail');
      });
    };
  
    const observer = new MutationObserver((records) => {
      decorate(getAddedGalleryThumbnails(records, gallery));
    });
    observer.observe(gallery, { childList: true, subtree: true });
    decorate(gallery.querySelectorAll('.nGY2GThumbnail'));
  
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
  
  function reorderFiles(order, dragged, target, placeAfter = false) {
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

  const PERFORMANCE_NOTICE = 'Open the full gallery in Character Library for better performance';
  let performanceNoticeShown = false;
  
  function isPerformanceNotice(value) {
    return String(value ?? '').includes(PERFORMANCE_NOTICE);
  }
  
  function installPerformanceNoticeDeduper(attempt = 0) {
    const toaster = window.toastr;
    if (!toaster || typeof toaster !== 'object') {
      if (attempt < 20) setTimeout(() => installPerformanceNoticeDeduper(attempt + 1), 250);
      return;
    }
  
    ['info', 'warning', 'success', 'error'].forEach((method) => {
      const original = toaster[method];
      if (typeof original !== 'function' || original._gpPerformanceNoticeDeduper) return;
      const wrapped = function (...args) {
        if (isPerformanceNotice(args[0])) {
          if (performanceNoticeShown) return undefined;
          performanceNoticeShown = true;
        }
        return original.apply(this, args);
      };
      wrapped._gpPerformanceNoticeDeduper = true;
      toaster[method] = wrapped;
    });
  }
  
  function observePerformanceNoticeDuplicates() {
    let noticeElementSeen = false;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const candidates = [
            ...(node.matches('.toast, .popup, .dialogue_popup') ? [node] : []),
            ...node.querySelectorAll('.toast, .popup, .dialogue_popup'),
          ];
          candidates.forEach((candidate) => {
            if (!isPerformanceNotice(candidate.textContent)) return;
            if (noticeElementSeen) candidate.remove();
            else noticeElementSeen = true;
          });
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  
  function applyGalleryTitle() {
    const t = document.querySelector('#gallery .dragTitle span');
    if (t && t.textContent && !/Image GalleryPlus/.test(t.textContent)) {
      t.textContent = 'Image GalleryPlus';
    }
  }
  
  function initObservers() {
    installPerformanceNoticeDeduper();
    observePerformanceNoticeDuplicates();
    installCustomOrderFetchHook();
  
    const galleryObserver = new MutationObserver((mutations) => {
      applyGalleryTitle();
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches?.('#gallery')) wireGallery(node);
          node.querySelectorAll?.('#gallery')?.forEach(wireGallery);
        }
      }
    });
    galleryObserver.observe(document.body, { childList: true, subtree: true });
    applyGalleryTitle();
    document.querySelectorAll('#gallery').forEach(wireGallery);
  
    const viewerObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          if (n.matches?.('.draggable.galleryImageDraggable')) wireViewer(n);
          n.querySelectorAll?.('.draggable.galleryImageDraggable')?.forEach(wireViewer);
        }
      }
    });
    viewerObserver.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('.draggable.galleryImageDraggable').forEach(wireViewer);
  }

  initObservers();
})();


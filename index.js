(function () {
  'use strict';

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

  const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm'];
  
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
      media.controls = true;
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
    const active = root._gpActiveMedia instanceof Element && root._gpActiveMedia.isConnected
      ? root._gpActiveMedia
      : fallbackMedia;
    const wrap = active?.parentElement;
    if (wrap?.classList?.contains('gp-layer-wrap')) {
      wrap.querySelectorAll('.gp-layer').forEach((layer) => {
        if (layer === active) return;
        if (layer instanceof HTMLVideoElement) layer.pause();
        layer.remove();
      });
      active.classList.remove('next');
      active.classList.add('base');
    }
    return active;
  }
  
  function beginTransition(root, fallbackMedia) {
    const baseMedia = settleCurrentMedia(root, fallbackMedia);
    const id = (Number(root._gpTransitionId) || 0) + 1;
    root._gpTransitionId = id;
    return { id, baseMedia };
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
    const { baseMedia } = beginTransition(root, fallbackMedia);
    const wrap = ensureLayerWrap(baseMedia);
    const next = createMedia(nextSrc);
    next.className = 'gp-layer base';
    if (baseMedia instanceof HTMLVideoElement) baseMedia.pause();
    baseMedia.replaceWith(next);
    root._gpActiveMedia = next;
    return next;
  }
  
  function transitionFade(root, fallbackMedia, nextSrc) {
    const { id, baseMedia } = beginTransition(root, fallbackMedia);
    const wrap = ensureLayerWrap(baseMedia);
    const next = createMedia(nextSrc);
    next.className = 'gp-layer next';
    next.style.opacity = '0';
    if (baseMedia instanceof HTMLVideoElement) baseMedia.pause();
    wrap.appendChild(next);
    root._gpActiveMedia = next;
  
    const ms = getTransitionMs();
    next.style.transition = `opacity ${ms}ms ease`;
    requestAnimationFrame(() => { next.style.opacity = '1'; });
    setTimeout(() => {
      if (root._gpTransitionId !== id) {
        if (root._gpActiveMedia !== next) {
          if (next instanceof HTMLVideoElement) next.pause();
          next.remove();
        }
        return;
      }
      if (baseMedia instanceof HTMLVideoElement) baseMedia.pause();
      baseMedia.remove();
      next.classList.remove('next');
      next.classList.add('base');
      next.style.opacity = '';
      next.style.transition = '';
    }, ms + 30);
    return next;
  }

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
  
    // ⏯️ start/pause slideshow
    const playBtn = document.createElement('button');
    playBtn.className = 'gp-btn gp-play';
    const playTip = 'Start / pause slideshow (Ctrl+Space)';
    playBtn.title = playTip;
    playBtn.setAttribute('aria-label', playTip);
    const playIcon = document.createElement('span');
    playIcon.setAttribute('aria-hidden', 'true');
    playIcon.textContent = '⏯️';
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
    const randomTip = 'Randomize slideshow order';
    randomBtn.title = randomTip;
    randomBtn.setAttribute('aria-label', randomTip);
    const randomIcon = document.createElement('span');
    randomIcon.setAttribute('aria-hidden', 'true');
    randomIcon.textContent = '🔀';
    randomBtn.appendChild(randomIcon);
    randomBtn.addEventListener('click', () => randomizeGalleryOrder(root));
  
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
  
    // speed slider
    const speedWrap = document.createElement('div');
    speedWrap.className = 'gp-speed-wrap';
    const speed = document.createElement('input');
    speed.type = 'range';
    speed.min = '0.1';
    speed.max = '10';
    speed.step = '0.1';
    speed.className = 'gp-speed';
    speed.value = String(gpSettings().slideshowSpeedSec ?? 3);
    speed.title = 'Slideshow delay (seconds)';
    speed.setAttribute('aria-label', speed.title);
  
    const speedValue = document.createElement('output');
    speedValue.className = 'gp-speed-value';
    speedValue.title = 'Time between images';
    speedValue.setAttribute('aria-live', 'polite');
  
    function refreshSpeedDisplay() {
      const delay = parseFloat(speed.value || '3');
      speedValue.textContent = `${delay.toFixed(1)}s`;
    }
    speed.addEventListener('input', refreshSpeedDisplay);
    speed.addEventListener('change', () => {
      let v = parseFloat(speed.value);
      if (!Number.isFinite(v) || v < 0.1) v = 0.1;
      if (v > 10) v = 10;
      speed.value = String(v);
      gpSaveSettings({ slideshowSpeedSec: v });
      refreshSpeedDisplay();
      if (root.dataset.gpPlaying === '1' && !(currentMedia(root) instanceof HTMLVideoElement)) {
        scheduleCurrentMedia(root, false);
      }
    });
    refreshSpeedDisplay();
    speedWrap.appendChild(speed);
    speedWrap.appendChild(speedValue);
  
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
    left.appendChild(muteBtn);
    left.appendChild(fsBtn);
    left.appendChild(speedWrap);
    left.appendChild(videoLoopWrap);
    left.appendChild(sel);
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
        document.removeEventListener('keydown', handler);
        return;
      }
      if (e.key === 'Escape') {
        root.querySelector('.dragClose')?.click();
        return;
      }
      if (!e.ctrlKey || e.repeat) return;
  
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext(root); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(root); }
      else if (e.key === ' ') { e.preventDefault(); root.dataset.gpPlaying === '1' ? stopSlideshow(root) : startSlideshow(root); }
    }
    document.addEventListener('keydown', handler);
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
    scheduleCurrentMedia(root, false);
  }
  function stopSlideshow(root) {
    root.dataset.gpPlaying = '0';
    clearSlideshowTimer(root);
    const media = currentMedia(root);
    if (media instanceof HTMLVideoElement) media.pause();
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
    video.controls = true;
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
  
  function goNext(root) {
    const list = currentGalleryList(root);
    const media = currentMedia(root);
    if (!media || !list.length) return;
    const i = indexInList(list, media.src);
    const nextIdx = i >= 0 ? (i + 1) % list.length : 0;
    const nextMedia = transitionTo(root, media, list[nextIdx]);
    root._gpActiveMedia = nextMedia;
    scheduleCurrentMedia(root, true);
    preload(list[(nextIdx + 1) % list.length]);
  }
  function goPrev(root) {
    const list = currentGalleryList(root);
    const media = currentMedia(root);
    if (!media || !list.length) return;
    const i = indexInList(list, media.src);
    const prevIdx = i >= 0 ? (i - 1 + list.length) % list.length : list.length - 1;
    const prevMedia = transitionTo(root, media, list[prevIdx]);
    root._gpActiveMedia = prevMedia;
    scheduleCurrentMedia(root, true);
    preload(list[(prevIdx - 1 + list.length) % list.length]);
  }
  
  function currentMedia(root) {
    if (root._gpActiveMedia instanceof Element && root._gpActiveMedia.isConnected) {
      return root._gpActiveMedia;
    }
    return root.querySelector('.gp-layer.base, :scope > video, :scope > img, .gp-layer.next');
  }
  
  function randomizeGalleryOrder(root) {
    const list = [...currentGalleryList(root)];
    if (list.length < 2) return;
  
    const media = currentMedia(root);
    const currentIndex = media ? indexInList(list, media.src) : -1;
    const current = currentIndex >= 0 ? list.splice(currentIndex, 1)[0] : null;
    shuffleInPlace(list);
    root._gpGalleryList = current ? [current, ...list] : list;
    root.dataset.gpRandomized = '1';
  }
  
  function shuffleInPlace(items) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
  
  function initializeGalleryList(root) {
    const galleryList = readGalleryDataList();
    root._gpGalleryList = galleryList ?? readVisibleGalleryList();
  
    const folderInput = document.querySelector('#gallery .gallery-folder-input');
    root._gpGalleryFolder = folderInput && 'value' in folderInput
      ? String(folderInput.value || '')
      : '';
  
    const media = currentMedia(root);
    root._gpActiveMedia = media;
    if (media instanceof HTMLVideoElement) {
      media.muted = !!gpSettings().videoMuted;
      media.loop = false;
    }
    try {
      root._gpGalleryBaseUrl = root._gpGalleryFolder
        ? new URL(`/user/images/${encodeURIComponent(root._gpGalleryFolder)}/`, location.origin).href
        : (media?.src ? new URL('.', media.src).href : '');
    } catch {
      root._gpGalleryBaseUrl = '';
    }
  
    scheduleGalleryListSync(root);
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
  
    const current = Array.isArray(root._gpGalleryList) ? root._gpGalleryList : [];
    const next = root.dataset.gpRandomized === '1'
      ? mergeRandomizedGalleryList(current, updated)
      : updated;
    if (!sameGalleryList(current, next)) {
      root._gpGalleryList = next;
    }
  }
  
  function mergeRandomizedGalleryList(current, updated) {
    const available = new Set(updated);
    const merged = current.filter(item => available.has(item));
    const included = new Set(merged);
    const added = shuffleInPlace(updated.filter(item => !included.has(item)));
  
    for (const item of added) {
      const insertAt = Math.floor(Math.random() * (merged.length + 1));
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
        if (!response.ok) return await fetchGalleryListFromCommand(context);
  
        const files = await response.json();
        if (!Array.isArray(files)) return null;
        return normalizeGalleryUrls(files.map(file => new URL(String(file), root._gpGalleryBaseUrl).href));
      } catch {
        // Fall through to SillyTavern's gallery command for compatibility.
      }
    }
  
    return await fetchGalleryListFromCommand(context);
  }
  
  async function fetchGalleryListFromCommand(context) {
    if (typeof context?.executeSlashCommandsWithOptions !== 'function') return null;
  
    try {
      const result = await context.executeSlashCommandsWithOptions('/list-gallery', {
        handleParserErrors: false,
        handleExecutionErrors: false,
        source: 'GalleryPlus',
      });
      const value = result?.pipe;
      const items = Array.isArray(value) ? value : JSON.parse(value);
      return Array.isArray(items) ? normalizeGalleryUrls(items) : null;
    } catch {
      return null;
    }
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
  const EXTERNAL_FILE_PREFIX = '/api/plugins/galleryplus/external-media/file/';
  const SERVER_HEALTH_ENDPOINT = '/api/plugins/galleryplus/health';
  let archiveModeActive = false;
  let fetchHookInstalled = false;
  const externalEntriesByName = new Map();
  
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
  
        const result = getGallerySort() === CUSTOM_SORT
          ? applyStoredOrder(folder, augmented)
          : augmented;
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
  
  function wireGallery(root) {
    if (!(root instanceof HTMLElement) || root.dataset.gpGalleryWired === '1') return;
  
    const sortSelect = root.querySelector('.gallery-sort-select');
    const gallery = root.querySelector('#dragGallery');
    if (!(sortSelect instanceof HTMLSelectElement) || !(gallery instanceof HTMLElement)) return;
  
    root.dataset.gpGalleryWired = '1';
    ensureCustomSortOption(sortSelect);
    installOpenFolderControl(root);
    installExternalSourcesControl(root, sortSelect);
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
      const margin = 8;
      const width = Math.min(420, Math.max(240, window.innerWidth * 0.85));
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))}px`;
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
        return;
      }
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
      const name = decodeURIComponent(url.pathname.split('/').pop() || String(item?.name || ''));
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

  function applyGalleryTitle() {
    const t = document.querySelector('#gallery .dragTitle span');
    if (t && t.textContent && !/Image GalleryPlus/.test(t.textContent)) {
      t.textContent = 'Image GalleryPlus';
    }
  }
  
  function initObservers() {
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

import { gpSettings, gpSaveSettings } from './settings.js';
import { isVideoSource, transitionTo } from './transitions.js';
import { getCachedExternalGalleryPaths, omitFailedExternalMedia } from './gallery-controls.js';

const GALLERY_FILE_TYPES = ['bmp', 'gif', 'jfif', 'jpeg', 'jpg', 'png', 'webp', 'mov', 'mp4', 'webm'];
const MEDIA_LOAD_TIMEOUT_MS = 10000;

export function wireViewer(root) {
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
  return root._gpGalleryFolder || '__default__';
}

function mediaIdentity(source) {
  try {
    const url = new URL(String(source), location.href);
    return `${url.pathname}${url.search}`;
  } catch {
    return String(source || '');
  }
}

function getFavoriteSet(root) {
  const favorites = gpSettings().favoritesByGallery;
  const entries = favorites && typeof favorites === 'object'
    ? favorites[favoriteGalleryKey(root)]
    : null;
  return new Set(Array.isArray(entries) ? entries.map(String) : []);
}

function isFavoriteSource(root, source) {
  return getFavoriteSet(root).has(mediaIdentity(source));
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
  const galleryKey = favoriteGalleryKey(root);
  const allFavorites = gpSettings().favoritesByGallery;
  const nextFavorites = allFavorites && typeof allFavorites === 'object'
    ? { ...allFavorites }
    : {};
  const favorites = new Set(Array.isArray(nextFavorites[galleryKey]) ? nextFavorites[galleryKey].map(String) : []);
  const identity = mediaIdentity(media.src);
  if (favorites.has(identity)) favorites.delete(identity);
  else favorites.add(identity);
  nextFavorites[galleryKey] = [...favorites];
  gpSaveSettings({ favoritesByGallery: nextFavorites });
  updateFavoriteButton(root);
  if (root.dataset.gpPresentationMode === 'favorites') {
    applyPresentationMode(root, true);
  }
}

function filterPresentationList(root, sourceList) {
  const mode = normalizePresentationMode(root.dataset.gpPresentationMode || gpSettings().presentationMode);
  if (mode === 'images') return sourceList.filter(source => !isVideoSource(source));
  if (mode === 'videos') return sourceList.filter(isVideoSource);
  if (mode === 'favorites') {
    const favorites = getFavoriteSet(root);
    return sourceList.filter(source => favorites.has(mediaIdentity(source)));
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

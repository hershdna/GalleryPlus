import { gpSettings, gpSaveSettings } from './settings.js';
import { transitionTo } from './transitions.js';

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
    if (root.dataset.gpPlaying === '1') {
      scheduleTick(root, gpSettings().slideshowSpeedSec || 3);
    }
  }

  // ⏮️ previous image
  const prevBtn = document.createElement('button');
  prevBtn.className = 'gp-btn gp-prev';
  const prevTip = 'Previous image';
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
  const playTip = 'Start / pause slideshow';
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
  const nextTip = 'Next image';
  nextBtn.title = nextTip;
  nextBtn.setAttribute('aria-label', nextTip);
  const nextIcon = document.createElement('span');
  nextIcon.setAttribute('aria-hidden', 'true');
  nextIcon.textContent = '⏭️';
  nextBtn.appendChild(nextIcon);
  nextBtn.addEventListener('click', () => stepSlideshow(1));

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
    if (root.dataset.gpPlaying === '1') startSlideshow(root);
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
  left.appendChild(fsBtn);
  left.appendChild(speedWrap);
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
  const img = root.querySelector('img');
  if (!img) return;

  let scale = 1;
  let tx = 0, ty = 0;

  let isPanning = false;
  let panStartX = 0, panStartY = 0;
  let panBaseX = 0, panBaseY = 0;

  function applyTransform() {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.style.transformOrigin = 'center center';
    img.style.willChange = 'transform';
  }

  function onWheel(e) {
    if (gpSettings().hoverZoom) return;
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
  img.addEventListener('mousedown', onMouseDown);

  applyTransform();
}

function wireKeyboardNav(root) {
  function handler(e) {
    if (!document.body.contains(root)) {
      document.removeEventListener('keydown', handler);
      return;
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); goNext(root); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(root); }
    else if (e.key === ' ') { e.preventDefault(); root.dataset.gpPlaying === '1' ? stopSlideshow(root) : startSlideshow(root); }
    else if (e.key === 'Escape') { root.querySelector('.dragClose')?.click(); }
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
  scheduleTick(root, gpSettings().slideshowSpeedSec || 3);
}
function stopSlideshow(root) {
  root.dataset.gpPlaying = '0';
  if (root._gpTimer) { clearTimeout(root._gpTimer); root._gpTimer = null; }
}
function scheduleTick(root, secs) {
  if (root._gpTimer) clearTimeout(root._gpTimer);
  root._gpTimer = setTimeout(() => {
    if (root.dataset.gpPlaying !== '1') return;
    goNext(root);
    scheduleTick(root, gpSettings().slideshowSpeedSec || 3);
  }, Math.max(100, secs * 1000));
}

function goNext(root) {
  const list = currentGalleryList(root);
  const img = root.querySelector('img');
  if (!img || !list.length) return;
  const i = indexInList(list, img.src);
  const nextIdx = i >= 0 ? (i + 1) % list.length : 0;
  transitionTo(root, img, list[nextIdx]);
  preload(list[(nextIdx + 1) % list.length]);
}
function goPrev(root) {
  const list = currentGalleryList(root);
  const img = root.querySelector('img');
  if (!img || !list.length) return;
  const i = indexInList(list, img.src);
  const prevIdx = i >= 0 ? (i - 1 + list.length) % list.length : list.length - 1;
  transitionTo(root, img, list[prevIdx]);
  preload(list[(prevIdx - 1 + list.length) % list.length]);
}

function initializeGalleryList(root) {
  const galleryList = readGalleryDataList();
  root._gpGalleryList = galleryList ?? readVisibleGalleryList();

  const folderInput = document.querySelector('#gallery .gallery-folder-input');
  root._gpGalleryFolder = folderInput && 'value' in folderInput
    ? String(folderInput.value || '')
    : '';

  const img = root.querySelector('img');
  try {
    root._gpGalleryBaseUrl = img?.src ? new URL('.', img.src).href : '';
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
  if (!sameGalleryList(current, updated)) {
    root._gpGalleryList = updated;
  }
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
  const i = new Image();
  i.decoding = 'async';
  i.loading = 'eager';
  i.src = src;
}


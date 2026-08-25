import { gpSettings, gpSaveSettings } from './settings.js';
import { transitionTo } from './transitions.js';

export function wireViewer(root) {
  if (!root || root.dataset.gpWired === '1') return;
  root.dataset.gpWired = '1';

  const pcBar = root.querySelector('.panelControlBar');
  if (!pcBar) return;

  injectLeftControls(root, pcBar);
  wireZoomAndPan(root);
  wireKeyboardNav(root);
  applyDefaultRect(root);
  wireFullscreenStateSync(root);
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
  saveBtn.title = 'Save as default size and location';
  saveBtn.textContent = '💾';
  saveBtn.addEventListener('click', () => saveDefaultRect(root));

  // 🔍 toggle hover zoom
  const zoomBtn = document.createElement('button');
  zoomBtn.className = 'gp-btn gp-zoom';
  zoomBtn.title = 'Toggle hover zoom (off = scroll zoom + pan)';
  zoomBtn.textContent = '🔍';
  zoomBtn.classList.toggle('active', !!gpSettings().hoverZoom);
  zoomBtn.addEventListener('click', () => {
    const ns = !gpSettings().hoverZoom;
    gpSaveSettings({ hoverZoom: ns });
    zoomBtn.classList.toggle('active', ns);
  });

  // ⏯️ start/pause slideshow
  const playBtn = document.createElement('button');
  playBtn.className = 'gp-btn gp-play';
  playBtn.title = 'Start / pause slideshow';
  playBtn.textContent = '⏯️';
  playBtn.addEventListener('click', () => {
    if (root.dataset.gpPlaying === '1') stopSlideshow(root);
    else startSlideshow(root);
  });

  // ⭘ fullscreen
  const fsBtn = document.createElement('button');
  fsBtn.className = 'gp-btn gp-fs';
  fsBtn.title = 'Fullscreen slideshow';
  fsBtn.textContent = '⭘';
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
  function refreshSpeedWarn() {
    const trans = root.dataset.gpTransition || gpSettings().slideshowTransition || 'crossfade';
    const delay = parseFloat(speed.value || '3');
    if (trans === 'spiral' && delay < 3) speed.classList.add('gp-warn'); else speed.classList.remove('gp-warn');
  }
  speed.addEventListener('input', refreshSpeedWarn);
  speed.addEventListener('change', () => {
    let v = parseFloat(speed.value);
    if (!Number.isFinite(v) || v < 0.1) v = 0.1;
    if (v > 10) v = 10;
    gpSaveSettings({ slideshowSpeedSec: v });
    refreshSpeedWarn();
    if (root.dataset.gpPlaying === '1') startSlideshow(root);
  });
  refreshSpeedWarn();
  speedWrap.appendChild(speed);

  // transition select
  const sel = document.createElement('select');
  sel.className = 'gp-transition';
  sel.title = 'Transition style';
  [
    ['crossfade', '😶‍🌫️'],
    ['spiral',    '😵‍🨡'],
    ['pushX',     '➡️'],
    ['pushY',     '⬇️'],
  ].forEach(([v, lbl]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = lbl;
    if ((gpSettings().slideshowTransition || 'crossfade') === v) o.selected = true;
    sel.appendChild(o);
  });
  root.dataset.gpTransition = gpSettings().slideshowTransition || 'crossfade';
  sel.addEventListener('change', () => {
    const v = sel.value;
    root.dataset.gpTransition = v;
    gpSaveSettings({ slideshowTransition: v });
    refreshSpeedWarn();
  });

  left.appendChild(saveBtn);
  left.appendChild(zoomBtn);
  left.appendChild(playBtn);
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
  const list = currentGalleryList();
  const img = root.querySelector('img');
  if (!img || !list.length) return;
  const i = indexInList(list, img.src);
  const nextIdx = (i + 1) % list.length;
  transitionTo(root, img, list[nextIdx]);
  preload(list[(nextIdx + 1) % list.length]);
}
function goPrev(root) {
  const list = currentGalleryList();
  const img = root.querySelector('img');
  if (!img || !list.length) return;
  const i = indexInList(list, img.src);
  const prevIdx = (i - 1 + list.length) % list.length;
  transitionTo(root, img, list[prevIdx]);
  preload(list[(prevIdx - 1 + list.length) % list.length]);
}

function currentGalleryList() {
  const out = [];
  const jq = window.jQuery || window.$;

  if (typeof jq === 'function') {
    const gallery = jq('#dragGallery');
    if (gallery.length && typeof gallery.nanogallery2 === 'function') {
      try {
        const items = gallery.nanogallery2('data')?.items;
        if (Array.isArray(items)) {
          items.forEach(item => {
            const src = typeof item?.responsiveURL === 'function'
              ? item.responsiveURL()
              : item?.src;
            if (src) out.push(src);
          });
        }
      } catch {
        // Fall back to visible thumbnails for older nanogallery2 versions.
      }
    }
  }

  if (out.length) return [...new Set(out)];

  const thumbs = document.querySelectorAll('#dragGallery img.nGY2GThumbnailImg, #dragGallery .nGY2GThumbnailImage.nGY2TnImg');
  thumbs.forEach(t => {
    if (t instanceof HTMLImageElement && t.src) out.push(t.src);
    else if (t instanceof HTMLElement) {
      const bg = t.style.backgroundImage || '';
      const m = bg.match(/url\(["']?(.+?)["']?\)/);
      if (m) out.push(new URL(m[1], location.href).href);
    }
  });
  return [...new Set(out)];
}
function indexInList(list, src) {
  const norm = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  const target = norm(src);
  const idx = list.findIndex(u => norm(u) === target);
  return idx >= 0 ? idx : 0;
}
function preload(src) {
  if (!src) return;
  const i = new Image();
  i.decoding = 'async';
  i.loading = 'eager';
  i.src = src;
}

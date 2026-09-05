import { gpSettings } from './settings.js';

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm'];
export const MEDIA_DISPLAYED_EVENT = 'galleryplus:media-displayed';

export function isVideoSource(src) {
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

export function transitionTo(root, baseMedia, nextSrc) {
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


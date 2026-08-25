import { gpSettings } from './settings.js';

function getTransitionMs() {
  const delay = gpSettings().slideshowSpeedSec || 3;
  let ms = Math.round((delay * 1000) / 3);
  if (!Number.isFinite(ms) || ms < 450) ms = 450;
  if (ms < 1000) ms = 1000;
  return ms;
}

function ensureLayerWrap(baseImg) {
  let wrap = baseImg.parentElement;
  if (!wrap || !wrap.classList?.contains('gp-layer-wrap')) {
    const nextWrap = document.createElement('div');
    nextWrap.className = 'gp-layer-wrap';
    baseImg.replaceWith(nextWrap);
    nextWrap.appendChild(baseImg);
    wrap = nextWrap;
  }
  baseImg.classList.add('gp-layer', 'base');
  return wrap;
}

function beginTransition(root, baseImg) {
  const id = (Number(root._gpTransitionId) || 0) + 1;
  root._gpTransitionId = id;

  const wrap = baseImg.parentElement;
  if (wrap?.classList?.contains('gp-layer-wrap')) {
    wrap.querySelectorAll('.gp-layer.next').forEach(layer => layer.remove());
  }

  return id;
}

export function transitionTo(root, baseImg, nextSrc) {
  const requested = root.dataset.gpTransition || gpSettings().slideshowTransition;
  if (requested === 'cut') {
    transitionCut(root, baseImg, nextSrc);
  } else {
    transitionFade(root, baseImg, nextSrc);
  }
}

function transitionCut(root, baseImg, nextSrc) {
  beginTransition(root, baseImg);
  baseImg.src = nextSrc;
}

function transitionFade(root, baseImg, nextSrc) {
  const id = beginTransition(root, baseImg);
  const wrap = ensureLayerWrap(baseImg);
  const next = document.createElement('img');
  next.className = 'gp-layer next';
  next.src = nextSrc;
  next.style.opacity = '0';
  wrap.appendChild(next);

  const ms = getTransitionMs();
  next.style.transition = `opacity ${ms}ms ease`;
  requestAnimationFrame(() => { next.style.opacity = '1'; });
  setTimeout(() => {
    if (root._gpTransitionId !== id) {
      next.remove();
      return;
    }
    baseImg.src = nextSrc;
    next.remove();
  }, ms + 30);
}

import { wireViewer } from './ui-controls.js';
import { installCustomOrderFetchHook, wireGallery } from './gallery-controls.js';

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

export function initObservers() {
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

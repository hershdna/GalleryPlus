import { wireViewer } from './ui-controls.js';
import { installCustomOrderFetchHook, wireGallery } from './gallery-controls.js';

function applyGalleryTitle() {
  const t = document.querySelector('#gallery .dragTitle span');
  if (t && t.textContent && !/Image GalleryPlus/.test(t.textContent)) {
    t.textContent = 'Image GalleryPlus';
  }
}

export function initObservers() {
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


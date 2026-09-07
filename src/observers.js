import { wireViewer } from './ui-controls.js';
import { installCustomOrderFetchHook, wireGallery } from './gallery-controls.js';

const PERFORMANCE_NOTICE = 'Open the full gallery in Character Library for better performance';
const TOPBAR_BUTTON_ID = 'galleryplus-topbar-button';
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

function openGalleryFromTopbar() {
  // The core Gallery extension owns the actual gallery-opening routine. Use
  // its existing action so the toolbar button stays compatible with ST.
  const galleryAction = document.querySelector('#show_gallery_wand_button');
  if (galleryAction instanceof HTMLElement) {
    galleryAction.click();
    return;
  }

  // Older ST builds expose the same action through the character-management
  // dropdown instead of the extensions menu.
  const management = document.querySelector('#char-management-dropdown');
  const galleryOption = management?.querySelector('#show_char_gallery');
  if (!(management instanceof HTMLSelectElement) || !galleryOption) return;
  const previous = management.value;
  management.value = 'show_char_gallery';
  management.dispatchEvent(new Event('change', { bubbles: true }));
  if (previous && previous !== 'show_char_gallery') {
    setTimeout(() => { management.value = previous; }, 0);
  }
}

function installTopbarGalleryButton() {
  const topBar = document.querySelector('#top-bar');
  if (!(topBar instanceof HTMLElement) || topBar.querySelector(`#${TOPBAR_BUTTON_ID}`)) return;

  const button = document.createElement('div');
  button.id = TOPBAR_BUTTON_ID;
  button.className = 'fa-solid fa-images interactable gp-topbar-gallery-button';
  button.title = 'Open GalleryPlus gallery';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  button.addEventListener('click', openGalleryFromTopbar);
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openGalleryFromTopbar();
  });
  topBar.appendChild(button);
}

export function initObservers() {
  installPerformanceNoticeDeduper();
  observePerformanceNoticeDuplicates();
  installCustomOrderFetchHook();
  installTopbarGalleryButton();

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
  const topbarObserver = new MutationObserver(installTopbarGalleryButton);
  topbarObserver.observe(document.body, { childList: true, subtree: true });
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


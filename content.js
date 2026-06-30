(() => {
  'use strict';

  if (window.__imageZoomerLoaded) return;
  window.__imageZoomerLoaded = true;

  const DOUBLE_TAP_MS = 500;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 20;
  const ZOOM_IN = 1.1;
  const ZOOM_OUT = 0.9;
  const HOVER_DELAY_MS = 900;
  const HOVER_CLOSE_MS = 90;
  const HOVER_DEFAULT_WIDTH = 460;
  const HOVER_DEFAULT_HEIGHT = 340;
  const HOVER_MIN_WIDTH = 220;
  const HOVER_MIN_HEIGHT = 180;
  const HOVER_MARGIN = 14;
  const HOVER_CLOSE_BUFFER_PX = 46;
  const PAN_EDGE_BUFFER_PX = 240;

  const UI_CLASS = 'image-zoomer-ui';
  const FULLSCREEN_CLASS = 'image-zoomer-fullscreen';
  const HOVER_CLASS = 'image-zoomer-hover';
  const IMAGE_CLASS = 'image-zoomer-image';
  const HINT_CLASS = 'image-zoomer-hint';

  const DEFAULTS = {
    autoHoverMode: false,
    hoverWidth: HOVER_DEFAULT_WIDTH,
    hoverHeight: HOVER_DEFAULT_HEIGHT
  };

  let settings = { ...DEFAULTS };
  let lastCtrlUpAt = 0;
  let lastMouseX = window.innerWidth / 2;
  let lastMouseY = window.innerHeight / 2;
  let fullscreenViewer = null;
  let hoverViewer = null;
  let hoverTimer = 0;
  let hoverCloseTimer = 0;
  let hoverCandidateSrc = null;
  let hoverSourceElement = null;
  let isPointerInsideHoverViewer = false;

  const style = document.createElement('style');
  style.textContent = `
    .${UI_CLASS} { z-index: 2147483647 !important; box-sizing: border-box !important; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; }
    .${UI_CLASS} *, .${UI_CLASS} *::before, .${UI_CLASS} *::after { box-sizing: border-box !important; }
    .${FULLSCREEN_CLASS} { all: initial; z-index: 2147483647 !important; position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; background: rgba(0,0,0,.86) !important; overflow: hidden !important; cursor: zoom-in !important; }
    .${HOVER_CLASS} { all: initial; z-index: 2147483647 !important; position: fixed !important; background: rgba(8,13,24,.94) !important; border: 1px solid rgba(255,255,255,.22) !important; border-radius: 0 !important; box-shadow: 0 20px 50px rgba(0,0,0,.45) !important; overflow: hidden !important; cursor: zoom-in !important; resize: both !important; min-width: ${HOVER_MIN_WIDTH}px !important; min-height: ${HOVER_MIN_HEIGHT}px !important; max-width: calc(100vw - ${HOVER_MARGIN * 2}px) !important; max-height: calc(100vh - ${HOVER_MARGIN * 2}px) !important; }
    .${IMAGE_CLASS} { all: initial; position: absolute !important; top: 0 !important; left: 0 !important; max-width: none !important; max-height: none !important; object-fit: contain !important; transform-origin: center center !important; pointer-events: none !important; user-select: none !important; -webkit-user-drag: none !important; }
    .${HINT_CLASS} { all: initial; position: absolute !important; right: 9px !important; bottom: 7px !important; padding: 4px 7px !important; border-radius: 999px !important; background: rgba(0,0,0,.58) !important; color: rgba(255,255,255,.84) !important; font: 11px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; pointer-events: none !important; user-select: none !important; }
  `;
  document.documentElement.appendChild(style);

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function pointInRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function pointInExpandedRect(x, y, rect, buffer) {
    return x >= rect.left - buffer && x <= rect.right + buffer && y >= rect.top - buffer && y <= rect.bottom + buffer;
  }

  function getPanRatio(pointerPosition, containerSize) {
    const buffer = Math.min(PAN_EDGE_BUFFER_PX, Math.max(0, containerSize * 0.38));
    if (containerSize <= buffer * 2) return clamp(pointerPosition / containerSize, 0, 1);
    return clamp((pointerPosition - buffer) / (containerSize - buffer * 2), 0, 1);
  }

  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
  }

  function isOurUi(node) {
    return node instanceof Element && Boolean(node.closest(`.${UI_CLASS}`));
  }

  function isVisibleElement(node) {
    if (!(node instanceof Element) || isOurUi(node)) return false;
    const cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (Number.parseFloat(cs.opacity || '1') <= 0.01) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function extractCssUrl(value) {
    if (!value || value === 'none') return null;
    const match = value.match(/url\((['"]?)(.*?)\1\)/);
    return match?.[2] || null;
  }

  function getDirectImageSrc(node) {
    if (!(node instanceof Element) || isOurUi(node)) return null;
    if (node instanceof HTMLImageElement) return node.currentSrc || node.src || null;
    if (node instanceof HTMLPictureElement) return getDirectImageSrc(node.querySelector('img'));
    if (node instanceof SVGElement && node.tagName.toLowerCase() === 'image') return node.getAttribute('href') || node.getAttribute('xlink:href');
    return extractCssUrl(getComputedStyle(node).backgroundImage);
  }

  function getDescendantImageAtPoint(node, x, y) {
    if (!(node instanceof Element) || isOurUi(node)) return null;
    const images = node.querySelectorAll?.('img, picture, svg image');
    if (!images) return null;
    for (const candidate of images) {
      if (!isVisibleElement(candidate)) continue;
      if (!pointInRect(x, y, candidate.getBoundingClientRect())) continue;
      const src = getDirectImageSrc(candidate);
      if (src) return { src, element: candidate };
    }
    return null;
  }

  function findImageUnderCursor(x, y) {
    for (const element of document.elementsFromPoint(x, y)) {
      if (!isVisibleElement(element)) continue;
      const directSrc = getDirectImageSrc(element);
      if (directSrc) return { src: directSrc, element };
      const child = getDescendantImageAtPoint(element, x, y);
      if (child?.src) return child;
    }
    return null;
  }

  function clampHoverSize(width, height) {
    return {
      width: clamp(Math.round(width || HOVER_DEFAULT_WIDTH), HOVER_MIN_WIDTH, Math.max(HOVER_MIN_WIDTH, window.innerWidth - HOVER_MARGIN * 2)),
      height: clamp(Math.round(height || HOVER_DEFAULT_HEIGHT), HOVER_MIN_HEIGHT, Math.max(HOVER_MIN_HEIGHT, window.innerHeight - HOVER_MARGIN * 2))
    };
  }

  function getSavedHoverSize() {
    return clampHoverSize(settings.hoverWidth, settings.hoverHeight);
  }

  function placeHoverViewer(root, x, y) {
    const rect = root.getBoundingClientRect();
    const size = clampHoverSize(rect.width || settings.hoverWidth, rect.height || settings.hoverHeight);
    root.style.width = `${size.width}px`;
    root.style.height = `${size.height}px`;
    let left = x + HOVER_MARGIN;
    let top = y + HOVER_MARGIN;
    if (left + size.width + HOVER_MARGIN > window.innerWidth) left = x - size.width - HOVER_MARGIN;
    if (top + size.height + HOVER_MARGIN > window.innerHeight) top = y - size.height - HOVER_MARGIN;
    root.style.left = `${clamp(left, HOVER_MARGIN, Math.max(HOVER_MARGIN, window.innerWidth - size.width - HOVER_MARGIN))}px`;
    root.style.top = `${clamp(top, HOVER_MARGIN, Math.max(HOVER_MARGIN, window.innerHeight - size.height - HOVER_MARGIN))}px`;
  }

  function keepHoverViewerInViewport(root) {
    const rect = root.getBoundingClientRect();
    const size = clampHoverSize(rect.width, rect.height);
    root.style.width = `${size.width}px`;
    root.style.height = `${size.height}px`;
    root.style.left = `${clamp(rect.left, HOVER_MARGIN, Math.max(HOVER_MARGIN, window.innerWidth - size.width - HOVER_MARGIN))}px`;
    root.style.top = `${clamp(rect.top, HOVER_MARGIN, Math.max(HOVER_MARGIN, window.innerHeight - size.height - HOVER_MARGIN))}px`;
  }

  class ZoomViewer {
    constructor({ src, mode, anchorX = 0, anchorY = 0 }) {
      this.src = src;
      this.mode = mode;
      this.anchorX = anchorX;
      this.anchorY = anchorY;
      this.scale = 1;
      this.rotation = 0;
      this.root = null;
      this.img = null;
      this.lastPointerEvent = null;
      this.resizeObserver = null;
      this.saveResizeTimer = 0;
      this.close = this.close.bind(this);
      this.panToPointer = this.panToPointer.bind(this);
      this.handleWheel = this.handleWheel.bind(this);
      this.handleKeyUp = this.handleKeyUp.bind(this);
      this.handleResize = this.handleResize.bind(this);
    }

    open() {
      this.root = document.createElement('div');
      this.root.className = `${UI_CLASS} ${this.mode === 'hover' ? HOVER_CLASS : FULLSCREEN_CLASS}`;
      this.root.tabIndex = -1;
      this.img = document.createElement('img');
      this.img.className = IMAGE_CLASS;
      this.img.alt = '';
      this.img.src = this.src;
      this.root.appendChild(this.img);

      if (this.mode === 'hover') {
        const size = getSavedHoverSize();
        this.root.style.width = `${size.width}px`;
        this.root.style.height = `${size.height}px`;
        placeHoverViewer(this.root, this.anchorX, this.anchorY);
        const hint = document.createElement('div');
        hint.className = HINT_CLASS;
        hint.textContent = 'wheel zoom · move pan · R rotate';
        this.root.appendChild(hint);
        this.root.addEventListener('mouseenter', () => { isPointerInsideHoverViewer = true; clearTimeout(hoverCloseTimer); });
        this.root.addEventListener('mouseleave', () => { isPointerInsideHoverViewer = false; closeHoverViewerSoon(); });
      }

      document.documentElement.appendChild(this.root);
      this.root.focus({ preventScroll: true });
      this.img.addEventListener('load', () => this.fitImageToOverlay(), { once: true });
      this.img.addEventListener('error', this.close, { once: true });
      this.root.addEventListener('wheel', this.handleWheel, { passive: false });
      this.root.addEventListener('mousemove', this.panToPointer);
      if (this.mode === 'fullscreen') this.root.addEventListener('click', this.close);
      window.addEventListener('keyup', this.handleKeyUp, true);
      window.addEventListener('resize', this.handleResize, true);

      if (this.mode === 'hover' && 'ResizeObserver' in window) {
        this.resizeObserver = new ResizeObserver(() => {
          if (!this.root) return;
          keepHoverViewerInViewport(this.root);
          clearTimeout(this.saveResizeTimer);
          this.saveResizeTimer = setTimeout(() => {
            if (!this.root || !chrome?.storage?.sync) return;
            const rect = this.root.getBoundingClientRect();
            const size = clampHoverSize(rect.width, rect.height);
            settings.hoverWidth = size.width;
            settings.hoverHeight = size.height;
            chrome.storage.sync.set({ hoverWidth: size.width, hoverHeight: size.height });
          }, 180);
        });
        this.resizeObserver.observe(this.root);
      }
    }

    getBox() { return this.root.getBoundingClientRect(); }

    applyTransform() {
      if (!this.img) return;
      this.img.style.transform = `translate(-50%, -50%) translate(${this.img.dataset.x}px, ${this.img.dataset.y}px) scale(${this.scale}) rotate(${this.rotation}deg)`;
    }

    setImagePosition(x, y) {
      this.img.dataset.x = String(x);
      this.img.dataset.y = String(y);
      this.applyTransform();
    }

    fitImageToOverlay() {
      const box = this.getBox();
      const naturalWidth = this.img.naturalWidth || 1;
      const naturalHeight = this.img.naturalHeight || 1;
      const padding = this.mode === 'hover' ? 24 : 20;
      this.scale = Math.min(1, Math.max(MIN_ZOOM, Math.min((box.width - padding) / naturalWidth, (box.height - padding) / naturalHeight)));
      this.setImagePosition(box.width / 2, box.height / 2);
    }

    panToPointer(event) {
      if (!this.root || !this.img) return;
      this.lastPointerEvent = event;
      const box = this.getBox();
      const naturalWidth = this.img.naturalWidth || 1;
      const naturalHeight = this.img.naturalHeight || 1;
      const renderedWidth = naturalWidth * this.scale;
      const renderedHeight = naturalHeight * this.scale;
      const ratioX = getPanRatio(event.clientX - box.left, box.width);
      const ratioY = getPanRatio(event.clientY - box.top, box.height);
      const x = renderedWidth > box.width ? box.width / 2 + (0.5 - ratioX) * (renderedWidth - box.width) : box.width / 2;
      const y = renderedHeight > box.height ? box.height / 2 + (0.5 - ratioY) * (renderedHeight - box.height) : box.height / 2;
      this.setImagePosition(x, y);
    }

    handleWheel(event) {
      event.preventDefault();
      this.scale = clamp(this.scale * (event.deltaY > 0 ? ZOOM_OUT : ZOOM_IN), MIN_ZOOM, MAX_ZOOM);
      this.panToPointer(event);
    }

    handleKeyUp(event) {
      if (this.mode === 'fullscreen' && event.key === 'Escape') {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key.toLowerCase() === 'r' && !isTypingTarget(event.target)) {
        event.preventDefault();
        this.rotation = (this.rotation + 45) % 360;
        this.applyTransform();
      }
    }

    handleResize() {
      if (this.mode === 'hover') keepHoverViewerInViewport(this.root);
      if (this.lastPointerEvent) this.panToPointer(this.lastPointerEvent);
      else this.fitImageToOverlay();
    }

    close() {
      window.removeEventListener('keyup', this.handleKeyUp, true);
      window.removeEventListener('resize', this.handleResize, true);
      this.resizeObserver?.disconnect();
      clearTimeout(this.saveResizeTimer);
      this.root?.remove();
      this.root = null;
      this.img = null;
      if (this.mode === 'fullscreen' && fullscreenViewer === this) fullscreenViewer = null;
      if (this.mode === 'hover' && hoverViewer === this) hoverViewer = null;
    }
  }

  function closeFullscreenViewer() {
    fullscreenViewer?.close();
    fullscreenViewer = null;
  }

  function closeHoverViewer() {
    clearTimeout(hoverTimer);
    clearTimeout(hoverCloseTimer);
    hoverTimer = 0;
    hoverCloseTimer = 0;
    hoverCandidateSrc = null;
    hoverSourceElement = null;
    isPointerInsideHoverViewer = false;
    hoverViewer?.close();
    hoverViewer = null;
  }

  function openFullscreenViewer(src) {
    closeHoverViewer();
    closeFullscreenViewer();
    fullscreenViewer = new ZoomViewer({ src, mode: 'fullscreen' });
    fullscreenViewer.open();
  }

  function isPointerStillOnSourceElement(x, y) {
    return hoverSourceElement instanceof Element && pointInRect(x, y, hoverSourceElement.getBoundingClientRect());
  }

  function isPointerNearHoverViewer(x, y) {
    return hoverViewer?.root && pointInExpandedRect(x, y, hoverViewer.root.getBoundingClientRect(), HOVER_CLOSE_BUFFER_PX);
  }

  function closeHoverViewerSoon() {
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = setTimeout(() => {
      if (isPointerInsideHoverViewer || isPointerNearHoverViewer(lastMouseX, lastMouseY) || isPointerStillOnSourceElement(lastMouseX, lastMouseY)) return;
      closeHoverViewer();
    }, HOVER_CLOSE_MS);
  }

  function openHoverViewer(src, x, y, sourceElement) {
    if (fullscreenViewer) return;
    if (hoverViewer && hoverViewer.src === src) {
      hoverViewer.anchorX = x;
      hoverViewer.anchorY = y;
      placeHoverViewer(hoverViewer.root, x, y);
      return;
    }
    closeHoverViewer();
    hoverSourceElement = sourceElement;
    hoverViewer = new ZoomViewer({ src, mode: 'hover', anchorX: x, anchorY: y });
    hoverViewer.open();
  }

  function shouldKeepCurrentHoverViewer(result) {
    return Boolean(hoverViewer && (isPointerInsideHoverViewer || isPointerNearHoverViewer(lastMouseX, lastMouseY) || isPointerStillOnSourceElement(lastMouseX, lastMouseY) || (result?.src && result.src === hoverViewer.src)));
  }

  function updateAutoHoverPreview(event) {
    if (!settings.autoHoverMode || fullscreenViewer || isTypingTarget(event.target)) {
      closeHoverViewer();
      return;
    }
    if (isOurUi(event.target)) return;

    const result = findImageUnderCursor(event.clientX, event.clientY);
    if (!result?.src) {
      clearTimeout(hoverTimer);
      hoverCandidateSrc = null;
      if (!shouldKeepCurrentHoverViewer(null)) closeHoverViewer();
      return;
    }

    clearTimeout(hoverCloseTimer);
    hoverSourceElement = result.element;
    if (hoverViewer && hoverViewer.src === result.src) return;
    if (hoverViewer && !shouldKeepCurrentHoverViewer(result)) closeHoverViewer();
    if (hoverCandidateSrc === result.src) return;

    clearTimeout(hoverTimer);
    hoverCandidateSrc = result.src;
    hoverTimer = setTimeout(() => openHoverViewer(result.src, event.clientX, event.clientY, result.element), HOVER_DELAY_MS);
  }

  function getFullscreenSourceForCurrentPointer() {
    if (hoverViewer?.src && (isPointerNearHoverViewer(lastMouseX, lastMouseY) || isPointerStillOnSourceElement(lastMouseX, lastMouseY))) return hoverViewer.src;
    const result = findImageUnderCursor(lastMouseX, lastMouseY);
    return result?.src || hoverCandidateSrc || null;
  }

  function rememberMousePosition(event) {
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    updateAutoHoverPreview(event);
  }

  function loadSettings() {
    if (!chrome?.storage?.sync) return;
    chrome.storage.sync.get(DEFAULTS, loaded => {
      settings = { ...DEFAULTS, ...loaded };
      if (!settings.autoHoverMode) closeHoverViewer();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.autoHoverMode) {
        settings.autoHoverMode = Boolean(changes.autoHoverMode.newValue);
        if (!settings.autoHoverMode) closeHoverViewer();
      }
    });
  }

  document.addEventListener('mousemove', rememberMousePosition, true);
  document.addEventListener('pointermove', rememberMousePosition, true);
  document.addEventListener('keyup', event => {
    if (event.key !== 'Control' || fullscreenViewer || isTypingTarget(event.target)) return;
    const now = Date.now();
    const isDoubleTap = now - lastCtrlUpAt <= DOUBLE_TAP_MS;
    lastCtrlUpAt = now;
    if (!isDoubleTap) return;
    const src = getFullscreenSourceForCurrentPointer();
    if (!src) return;
    event.preventDefault();
    event.stopPropagation();
    openFullscreenViewer(src);
  }, true);

  loadSettings();
})();

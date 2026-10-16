/*
 * xheatgrid content script bootstrap (isolated world, document_idle). The real logic
 * lives in lib/*.js, loaded before this file (see manifest.json).
 */
(function () {
  "use strict";
  const X = globalThis.XHeatgrid;
  if (!X || !X.createController || !document.documentElement) {
    return;
  }
  const controller = X.createController({
    document,
    window,
    location,
    console,
    storage: (() => {
      try {
        return window.localStorage;
      } catch (error) {
        return null;
      }
    })(),
    MutationObserver,
    version: chrome.runtime.getManifest().version,
    navigation: window.navigation || null,
    postToBridge: (message) => window.postMessage(message, location.origin),
    addWindowListener: (type, handler) => window.addEventListener(type, handler)
  });
  controller.start();
})();

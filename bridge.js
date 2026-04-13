// x-tweet-export: ISOLATED world bridge script
// Relays messages between MAIN world (content.js) and chrome extension APIs (background.js)

(function () {
  'use strict';

  // Listen for messages from MAIN world content.js
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'x-tweet-export-main') return;

    const { type, payload } = event.data;

    switch (type) {
      case 'EXPORT_DOWNLOAD':
        // Forward download request to background service worker
        // Blob URLs created in MAIN world are accessible to the extension context
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_FILE',
          url: payload.url,
          filename: payload.filename,
        }, (response) => {
          window.postMessage({
            source: 'x-tweet-export-bridge',
            type: 'DOWNLOAD_RESULT',
            payload: response || { success: false, error: 'No response from background' },
          }, '*');
        });
        break;

      case 'TRIGGER_EXPORT_FROM_UI':
        // Relay export trigger back to MAIN world
        window.postMessage({
          source: 'x-tweet-export-bridge',
          type: 'TRIGGER_EXPORT',
          payload: payload,
        }, '*');
        break;

      case 'AUTH_STATE_UPDATE':
        // Could store auth state in chrome.storage if needed later
        break;

      // Other messages (EXPORT_STARTED, EXPORT_PROGRESS, EXPORT_ERROR)
      // are consumed directly by content.js for UI updates — no relay needed
    }
  });
})();

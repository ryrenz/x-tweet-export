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
        try {
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
        } catch (e) {
          // chrome.runtime.sendMessage throws synchronously when the extension
          // context is invalidated (e.g. extension reloaded mid-session)
          window.postMessage({
            source: 'x-tweet-export-bridge',
            type: 'DOWNLOAD_RESULT',
            payload: { success: false, error: 'EXTENSION_INVALIDATED' },
          }, '*');
        }
        break;

      case 'TRIGGER_EXPORT_FROM_UI':
        // Relay export trigger back to MAIN world
        window.postMessage({
          source: 'x-tweet-export-bridge',
          type: 'TRIGGER_EXPORT',
          payload: payload,
        }, '*');
        break;

      case 'STORAGE_REQUEST': {
        // Forward chrome.storage.local op to background and relay result back
        const { id, op, key, value } = payload || {};
        try {
          chrome.runtime.sendMessage({
            type: 'STORAGE_OP',
            op,
            key,
            value,
          }, (response) => {
            window.postMessage({
              source: 'x-tweet-export-bridge',
              type: 'STORAGE_RESULT',
              payload: {
                id,
                value: response && response.success ? response.value : null,
                error: response && response.success ? null : (response && response.error) || 'STORAGE_FAILED',
              },
            }, '*');
          });
        } catch (e) {
          window.postMessage({
            source: 'x-tweet-export-bridge',
            type: 'STORAGE_RESULT',
            payload: { id, value: null, error: 'EXTENSION_INVALIDATED' },
          }, '*');
        }
        break;
      }

      case 'AUTH_STATE_UPDATE':
        // Could store auth state in chrome.storage if needed later
        break;

      // Other messages (EXPORT_STARTED, EXPORT_PROGRESS, EXPORT_ERROR)
      // are consumed directly by content.js for UI updates — no relay needed
    }
  });
})();

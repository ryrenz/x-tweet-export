// Service worker: handles chrome.downloads + chrome.storage requests from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DOWNLOAD_FILE') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    return true;
  }

  if (message.type === 'STORAGE_OP') {
    const { op, key, value } = message;
    if (op === 'get') {
      chrome.storage.local.get(key, (result) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, value: result[key] === undefined ? null : result[key] });
        }
      });
    } else if (op === 'set') {
      chrome.storage.local.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true });
        }
      });
    } else if (op === 'delete') {
      chrome.storage.local.remove(key, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true });
        }
      });
    } else {
      sendResponse({ success: false, error: 'UNKNOWN_OP' });
    }
    return true;
  }
});

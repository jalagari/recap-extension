/**
 * Recap - Service Worker v5.0.0
 * Message routing + config storage access
 */

'use strict';

const log = (...args) => console.log('[Recap SW]', ...args);

// ============================================================================
// IndexedDB Access (for config lookup)
// ============================================================================

async function getConfigFromDB(configId) {
  return new Promise((resolve) => {
    const request = indexedDB.open('RecapDB', 1);
    
    request.onerror = () => resolve(null);
    request.onupgradeneeded = () => resolve(null);
    
    request.onsuccess = () => {
      const db = request.result;
      try {
        const tx = db.transaction('configs', 'readonly');
        const store = tx.objectStore('configs');
        const getReq = store.get(configId);
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    };
  });
}

async function getAllConfigsFromDB() {
  return new Promise((resolve) => {
    const request = indexedDB.open('RecapDB', 1);
    
    request.onerror = () => resolve({});
    request.onupgradeneeded = () => resolve({});
    
    request.onsuccess = () => {
      const db = request.result;
      try {
        const tx = db.transaction('configs', 'readonly');
        const store = tx.objectStore('configs');
        const getReq = store.getAll();
        
        getReq.onsuccess = () => {
          // Convert array to map by id
          const configs = {};
          (getReq.result || []).forEach(c => { configs[c.id] = c; });
          log('All configs loaded:', Object.keys(configs).length);
          resolve(configs);
        };
        getReq.onerror = () => resolve({});
      } catch (e) {
        resolve({});
      }
    };
  });
}

// ============================================================================
// Sidepanel
// ============================================================================

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ============================================================================
// Message Routing
// ============================================================================

// Forward these message types from content script to sidepanel
const FORWARD_TYPES = [
  'RRWEB_EVENT',
  'RECORDING_STARTED',
  'RECORDING_STOPPED',
  'RECORDING_ERROR',
  'RECORDING_RESUMED',
  'LIVE_EVENT'
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const from = sender.tab ? `tab:${sender.tab.id}` : 'extension';
  log('Message:', message.type, 'from:', from);
  
  // Handle config requests from content script
  if (message.type === 'GET_CONFIG') {
    getConfigFromDB(message.configId).then(config => {
      sendResponse({ config });
    });
    return true;
  }
  
  if (message.type === 'GET_ALL_CONFIGS') {
    getAllConfigsFromDB().then(configs => {
      sendResponse({ configs });
    });
    return true;
  }
  
  // Forward relevant messages to sidepanel
  if (FORWARD_TYPES.includes(message.type)) {
    log('Forwarding to sidepanel:', message.type);
    chrome.runtime.sendMessage(message).catch((e) => {
      log('Forward error:', e.message);
    });
  }
  
  sendResponse({ received: true });
  return true;
});

// ============================================================================
// Tab Events
// ============================================================================

chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    chrome.runtime.sendMessage({
      type: 'TAB_ACTIVATED',
      tabId: info.tabId,
      url: tab.url
    }).catch(() => {});
  } catch (e) {
    log('Tab error:', e);
  }
});

log('Service Worker v5.0.0 started');

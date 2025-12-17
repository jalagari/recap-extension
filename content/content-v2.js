/**
 * Recap Content Script v2
 * Uses extension's bundled rrweb (no external CDN)
 */

console.log('[Recap Content] v2 loaded');

// ============================================================================
// Inject Extension Scripts
// ============================================================================

function injectExtensionScript(path) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(path);
    script.onload = () => {
      console.log('[Recap Content] Loaded:', path);
      script.remove(); // Clean up
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load: ${path}`));
    (document.head || document.documentElement).appendChild(script);
  });
}

// ============================================================================
// Message Bridge (Content Script <-> Page)
// ============================================================================

let messageId = 0;
const pendingMessages = new Map();

function sendToPage(type, data = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++messageId;
    const timeout = setTimeout(() => {
      pendingMessages.delete(requestId);
      reject(new Error('Timeout'));
    }, 5000);
    
    pendingMessages.set(requestId, { resolve, reject, timeout });
    window.postMessage({ type, requestId, ...data }, '*');
  });
}

// Listen for responses and events from page
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  
  const { type, requestId, ...data } = e.data || {};
  
  // Handle responses
  if (type?.endsWith('_RESPONSE') && pendingMessages.has(requestId)) {
    const { resolve, timeout } = pendingMessages.get(requestId);
    clearTimeout(timeout);
    pendingMessages.delete(requestId);
    resolve(data);
  }
  
  // Forward live events to sidepanel
  if (type === 'RECAP_EVENT') {
    chrome.runtime.sendMessage({
      type: 'LIVE_EVENT',
      event: data.event,
      eventCount: data.eventCount
    }).catch(() => {});
  }
});

// ============================================================================
// Extension Message Handler
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Recap Content] Message:', message.type);
  
  (async () => {
    try {
      switch (message.type) {
        case 'START_RECORDING':
          const startResult = await sendToPage('RECAP_START', { config: message.config });
          sendResponse(startResult);
          break;
          
        case 'STOP_RECORDING':
          const stopResult = await sendToPage('RECAP_STOP');
          sendResponse(stopResult);
          break;
          
        case 'GET_RECORDING_STATUS':
          const status = await sendToPage('RECAP_STATUS');
          sendResponse(status);
          break;
          
        case 'PING':
          const ping = await sendToPage('RECAP_PING');
          sendResponse(ping);
          break;
        
        case 'GET_LIVE_EVENTS':
          const eventsResult = await sendToPage('RECAP_GET_EVENTS');
          sendResponse(eventsResult);
          break;
          
        default:
          sendResponse({ error: 'Unknown message type' });
      }
    } catch (err) {
      console.error('[Recap Content] Error:', err);
      sendResponse({ error: err.message });
    }
  })();
  
  return true; // Keep channel open for async response
});

// ============================================================================
// Initialize
// ============================================================================

async function init() {
  try {
    // Load rrweb from extension bundle
    await injectExtensionScript('lib/rrweb.min.js');
    
    // Load recording logic from extension bundle
    await injectExtensionScript('content/recorder-inject.js');
    
    console.log('[Recap Content] Initialization complete');
  } catch (err) {
    console.error('[Recap Content] Init failed:', err);
  }
}

init();

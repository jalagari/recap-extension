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
  if (!e.data?.type?.startsWith('RECAP')) return;
  
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
  
  // Forward quality updates to sidepanel
  if (type === 'RECAP_QUALITY_UPDATE') {
    chrome.runtime.sendMessage({
      type: 'QUALITY_UPDATE',
      quality: data.quality,
      severity: data.severity
    }).catch(() => {});
  }
  
});

// Note: User report is now handled directly in recorder-inject.js via API call

// ============================================================================
// Extension Message Handler
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    console.log('[Recap Content] Message:', message.type);
    
    (async () => {
      try {
        switch (message.type) {
          case 'START_RECORDING':
            console.log('[Recap Content] Received START_RECORDING:', {
              autoStart: message.autoStart || false,
              forceRestart: message.forceRestart || false,
              configName: message.config?.name,
              configId: message.config?.id
            });
            // Pass autoStart and forceRestart flags through to recorder
            const startResult = await sendToPage('RECAP_START', { 
              config: message.config,
              autoStart: message.autoStart || false,
              forceRestart: message.forceRestart || false
            });
            console.log('[Recap Content] START_RECORDING result:', {
              success: startResult?.success,
              sessionId: startResult?.sessionId
            });
            sendResponse(startResult || { success: false });
            break;
          
          case 'RESTART_RECORDING':
            // Force restart: stop current recording and start fresh
            const restartResult = await sendToPage('RECAP_RESTART', { 
              config: message.config 
            });
            sendResponse(restartResult || { success: false });
            break;
            
          case 'STOP_RECORDING':
            const stopResult = await sendToPage('RECAP_STOP');
            sendResponse(stopResult || { success: false });
            break;
            
          case 'GET_RECORDING_STATUS':
            const status = await sendToPage('RECAP_STATUS');
            sendResponse(status || { isRecording: false });
            break;
            
          case 'PING':
            const ping = await sendToPage('RECAP_PING');
            sendResponse(ping || { ready: false });
            break;
          
          case 'GET_LIVE_EVENTS':
            const eventsResult = await sendToPage('RECAP_GET_EVENTS');
            sendResponse(eventsResult || { events: [] });
            break;
            
          default:
            sendResponse({ error: 'Unknown message type' });
        }
      } catch (err) {
        // Never let errors break page - return safe defaults
        console.error('[Recap Content] Error:', err);
        sendResponse({ error: err?.message || 'Unknown error', success: false });
      }
    })();
    
    return true; // Keep channel open for async response
  } catch (err) {
    // Never let listener errors break page
    console.error('[Recap Content] Fatal error in message listener:', err);
    sendResponse({ error: 'Fatal error', success: false });
    return true;
  }
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
    // Never let extension errors break page
    console.error('[Recap Content] Init failed:', err);
    // Don't throw - silently fail to avoid breaking page
  }
}

// Wrap init in try-catch to ensure it never throws
try {
  init();
} catch (err) {
  console.error('[Recap Content] Fatal init error:', err);
  // Silently fail - extension should never break page
}

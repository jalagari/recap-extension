/**
 * Recap - Content Script (Refactored)
 * Minimal bridge between extension and page context
 * @version 2.0.0
 */

'use strict';

// ============================================================================
// Configuration
// ============================================================================

const Config = {
  VERSION: '2.0.2',
  DEBUG: false,
  MESSAGE_SOURCE: { CONTENT: 'recap-content', INJECTED: 'recap-injected' }
};

// ============================================================================
// State
// ============================================================================

let initialized = false;
let injectedReady = false;
const pendingMessages = [];

// ============================================================================
// Utilities
// ============================================================================

const log = (...args) => Config.DEBUG && console.log('[Recap Content]', ...args);

const sendToExtension = (type, payload) => {
  try {
    chrome.runtime.sendMessage({ type, payload }).catch(() => {});
  } catch {}
};

const sendToPage = (type, payload) => {
  if (!injectedReady) {
    log('Injected not ready, queueing:', type);
    pendingMessages.push({ type, payload });
    return;
  }
  log('Sending to page:', type);
  window.postMessage({ source: Config.MESSAGE_SOURCE.CONTENT, type, payload }, '*');
};

// ============================================================================
// Script Injection
// ============================================================================

const Inject = {
  scripts() {
    // Load rrweb from extension bundle
    const rrweb = document.createElement('script');
    rrweb.src = chrome.runtime.getURL('lib/rrweb.min.js');
    rrweb.onload = () => {
      log('rrweb loaded');
      this.rrwebUtils(); // Load shared utils next
    };
    rrweb.onerror = () => {
      log('rrweb failed to load');
      this.rrwebUtils(); // Try to load utils anyway
    };
    (document.head || document.documentElement).appendChild(rrweb);
  },

  rrwebUtils() {
    // Load shared RrwebUtils for DRY config building
    const utils = document.createElement('script');
    utils.src = chrome.runtime.getURL('lib/rrweb-utils.js');
    utils.onload = () => {
      log('RrwebUtils loaded');
      this.recapScript();
    };
    utils.onerror = () => {
      log('RrwebUtils failed to load (will use fallback)');
      this.recapScript();
    };
    (document.head || document.documentElement).appendChild(utils);
  },

  recapScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/injected.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }
};

// ============================================================================
// Message Handlers
// ============================================================================

// Message types we handle
const MessageTypes = {
  START_RECORDING: 'START_RECORDING',
  STOP_RECORDING: 'STOP_RECORDING',
  GET_FORM_INFO: 'GET_FORM_INFO',
  GET_EVENTS: 'GET_EVENTS',
  CHECK_RRWEB: 'CHECK_RRWEB'
};

// From extension (panel/service-worker)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type, payload } = message || {};

  const handlers = {
    [MessageTypes.START_RECORDING]: () => {
      log('Received START_RECORDING, forwarding to page:', payload);
      sendToPage('START_RECORDING', payload);
      return { success: true };
    },
    [MessageTypes.STOP_RECORDING]: () => {
      sendToPage('STOP_RECORDING', {});
      return { success: true };
    },
    [MessageTypes.GET_FORM_INFO]: () => {
      return { success: true, formInfo: getFormInfo() };
    },
    [MessageTypes.GET_EVENTS]: () => {
      sendToPage('GET_EVENTS', {});
      return { success: true };
    },
    [MessageTypes.CHECK_RRWEB]: () => {
      return { success: true, hasRrweb: injectedReady };
    }
  };

  const handler = handlers[type];
  sendResponse(handler ? handler() : { success: false });
  return true;
});

// From page (injected script) - Forward to extension
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== Config.MESSAGE_SOURCE.INJECTED) return;

  const { type, payload } = event.data;

  if (type === 'INJECTED_READY') {
    injectedReady = true;
    log('Injected ready, rrweb:', payload?.hasRrweb, 'consolePlugin:', payload?.hasConsolePlugin);
    // Process pending messages
    pendingMessages.forEach(m => sendToPage(m.type, m.payload));
    pendingMessages.length = 0;
    sendToExtension('RRWEB_STATUS', payload);
    return;
  }

  // Forward all other messages to extension
  const forwardTypes = ['RECORDING_STARTED', 'RECORDING_STOPPED', 'RECORDING_ERROR', 
                        'RRWEB_EVENT', 'TIMELINE_EVENT', 'EVENTS_DATA'];
  if (forwardTypes.includes(type)) {
    log('Forwarding to extension:', type, payload?.type || '');
    sendToExtension(type, payload);
  }
});

// ============================================================================
// Form Detection
// ============================================================================

function getFormInfo() {
  const form = document.querySelector('form[id], form[name], form');
  
  return {
    formId: form?.id || form?.name || '',
    formName: document.title || '',
    url: location.href,
    pathname: location.pathname,
    hasForm: !!form
  };
}

// ============================================================================
// Init
// ============================================================================

function init() {
  if (initialized) return;
  initialized = true;
  
  Inject.scripts();
  log(`Initialized v${Config.VERSION}`);
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

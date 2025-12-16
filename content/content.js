/**
 * Recap - Content Script v6.0.0
 * Simplified - all capture logic moved to injected.js
 */

'use strict';

const log = (...args) => console.log('[Recap]', ...args);

log('Content script loaded');

const STORAGE_KEY = 'recap_session';
let isRecording = false;
let events = [];
let sessionId = null;
let options = null;
let pageReady = false;

// ============================================================================
// Page Communication
// ============================================================================

function sendToPage(type, data = {}) {
  window.postMessage({ source: 'recap-content', type, data }, '*');
}

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'recap-page') return;
  
  const { type, data } = e.data;
  
  switch (type) {
    case 'READY':
      pageReady = true;
      log('Page ready, hasRrweb:', data?.hasRrweb);
      checkAndResume();
      break;
      
    case 'STARTED':
      isRecording = true;
      chrome.runtime.sendMessage({ type: 'RECORDING_STARTED', sessionId }).catch(() => {});
      break;
      
    case 'STOPPED':
      isRecording = false;
      chrome.runtime.sendMessage({ type: 'RECORDING_STOPPED', events }).catch(() => {});
      break;
      
    case 'EVENT':
      if (data?.event) {
        events.push(data.event);
        chrome.runtime.sendMessage({ type: 'RRWEB_EVENT', event: data.event }).catch(() => {});
      }
      break;
  }
});

// ============================================================================
// Extension Communication
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, ...payload } = message;
  log('From extension:', type);
  
  switch (type) {
    case 'START_RECORDING':
      events = [];
      sessionId = payload.sessionId || `sess_${Date.now()}`;
      options = payload.options || {};
      isRecording = true;
      saveSession();
      if (pageReady) {
        sendToPage('START', { options });
      }
      sendResponse({ success: true, sessionId });
      break;
      
    case 'STOP_RECORDING':
      isRecording = false;
      clearSession();
      sendToPage('STOP');
      sendResponse({ success: true, events });
      break;
      
    case 'GET_STATUS':
      sendResponse({ success: true, isRecording, eventCount: events.length });
      break;
      
    case 'GET_EVENTS':
      sendResponse({ success: true, events });
      break;
      
    default:
      sendResponse({ success: false });
  }
  
  return true;
});

// ============================================================================
// Session Persistence
// ============================================================================

function saveSession() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ isRecording: true, sessionId, options }));
  } catch (e) {}
}

function loadSession() {
  try {
    const data = sessionStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (e) {}
}

function checkAndResume() {
  const session = loadSession();
  if (session?.isRecording) {
    log('Resuming session:', session.sessionId);
    sessionId = session.sessionId;
    options = session.options || {};
    isRecording = true;
    events = [];
    sendToPage('START', { options });
    chrome.runtime.sendMessage({ type: 'RECORDING_RESUMED', sessionId, url: location.href }).catch(() => {});
  }
}

// ============================================================================
// Script Injection
// ============================================================================

function injectScripts() {
  const rrweb = document.createElement('script');
  rrweb.src = chrome.runtime.getURL('lib/rrweb.min.js');
  rrweb.onload = () => {
    rrweb.remove();
    const injected = document.createElement('script');
    injected.src = chrome.runtime.getURL('content/injected.js');
    injected.onload = () => injected.remove();
    (document.head || document.documentElement).appendChild(injected);
  };
  (document.head || document.documentElement).appendChild(rrweb);
}

// ============================================================================
// Init
// ============================================================================

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectScripts, { once: true });
} else {
  injectScripts();
}

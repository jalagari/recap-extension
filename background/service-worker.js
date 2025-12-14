/**
 * Recap - Background Service Worker
 * Handles message passing between side panel and content scripts
 * @fileoverview Service worker for the Recap Chrome extension
 */

'use strict';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Enable debug logging (set to false in production) */
const DEBUG = false;

/** Service worker version for cache debugging */
const SW_VERSION = '1.0.2';

/** Message types */
const MessageType = Object.freeze({
  // Config management
  GET_CONFIG: 'GET_CONFIG',
  SAVE_CONFIG: 'SAVE_CONFIG',
  EXPORT_CONFIG: 'EXPORT_CONFIG',
  
  // Selection and preview
  TOGGLE_SELECTION_MODE: 'TOGGLE_SELECTION_MODE',
  TOGGLE_LIVE_PREVIEW: 'TOGGLE_LIVE_PREVIEW',
  ELEMENT_SELECTED: 'ELEMENT_SELECTED',
  GET_ACTIVE_STATE: 'GET_ACTIVE_STATE',
  
  // Network
  NETWORK_REQUEST_CAPTURED: 'NETWORK_REQUEST_CAPTURED',
  
  // Recording (pass-through to panel)
  RECORDING_EVENT: 'RECORDING_EVENT',
  RRWEB_EVENT: 'RRWEB_EVENT',
  RRWEB_STATUS: 'RRWEB_STATUS',
  RECORDING_STARTED: 'RECORDING_STARTED',
  RECORDING_STOPPED: 'RECORDING_STOPPED',
  RECORDING_RESUMED: 'RECORDING_RESUMED',
  RECORDING_ERROR: 'RECORDING_ERROR',
  NETWORK_EVENT: 'NETWORK_EVENT',
  CUSTOM_EVENT: 'CUSTOM_EVENT',
  EVENTS_DATA: 'EVENTS_DATA'
});

/**
 * @typedef {Object} ConfigState
 * @property {string} formId
 * @property {string} formName
 * @property {number} samplingRate
 * @property {Object} maskingRules
 * @property {Object} networkRules
 * @property {Object} journeyMapping
 * @property {Object} errorTracking
 */

/**
 * Default configuration state
 * @type {ConfigState}
 */
const DEFAULT_CONFIG = Object.freeze({
  formId: '',
  formName: '',
  samplingRate: 0.1,
  maskingRules: Object.freeze({
    selectors: [],
    maskAllInputs: true,
    piiAttributeName: 'data-is-pii',
  }),
  networkRules: Object.freeze({
    blacklistUrls: [],
    scrubPayloadKeys: ['password', 'token', 'ssn', 'creditCard'],
    stripHeaders: ['Authorization', 'Cookie', 'X-Api-Key'],
  }),
  journeyMapping: Object.freeze({
    steps: Object.freeze({
      detectionType: 'selector_change',
      selector: '',
      stepNames: [],
    }),
    successIndicator: Object.freeze({
      type: 'element_present',
      selector: '',
    }),
    redirectPersistence: Object.freeze({
      allowedDomains: [],
      sessionTimeoutMinutes: 15,
    }),
  }),
  errorTracking: Object.freeze({
    errorContainerSelector: '',
    captureConsoleLogs: true,
  }),
});

// ============================================================================
// STATE
// ============================================================================

/** Track active tabs with extension enabled */
const activeTabs = new Map();

// ============================================================================
// LOGGING
// ============================================================================

/**
 * Log a debug message
 * @param {...any} args - Arguments to log
 */
function log(...args) {
  if (DEBUG) {
    console.log('[Recap SW]', ...args);
  }
}

/**
 * Log an error message
 * @param {...any} args - Arguments to log
 */
function logError(...args) {
  console.error('[Recap SW]', ...args);
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize extension on install
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log(`[Recap] Extension installed/updated - SW v${SW_VERSION}`);

  // Set default config in storage
  chrome.storage.local.get('config', (result) => {
    if (!result.config) {
      chrome.storage.local.set({ config: { ...DEFAULT_CONFIG } });
    }
  });
});

// Log on service worker startup
console.log(`[Recap] Service worker started - v${SW_VERSION}`);

/**
 * Open side panel when extension icon is clicked
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) {
    logError('No tab ID for action click');
    return;
  }

  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    logError('Failed to open side panel:', error);
  }
});

/**
 * Set side panel behavior - open on action click
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  logError('Failed to set panel behavior:', error);
});

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

/**
 * Handle messages from popup and content scripts
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Validate message structure
  if (!message || typeof message !== 'object') {
    sendResponse({ success: false, error: 'Invalid message format' });
    return true;
  }

  const { type, payload } = message;

  // Handle message based on type
  const handler = getMessageHandler(type);
  if (handler) {
    handler(payload, sender, sendResponse);
    return true; // Keep channel open for async response
  }

  // Check if this is a pass-through message for the panel
  if (isPassThroughMessage(type)) {
    sendResponse({ success: true });
    return true;
  }

  // Unknown message type - only warn for truly unexpected types
  if (DEBUG) {
    console.warn(`[Recap SW] Unknown message type: ${type}`);
  }
  // Still acknowledge the message to avoid errors
  sendResponse({ success: true });
  return true;
});

/**
 * Get handler for message type
 * @param {string} type - Message type
 * @returns {Function|null} Handler function or null
 */
function getMessageHandler(type) {
  const handlers = {
    [MessageType.GET_CONFIG]: handleGetConfig,
    [MessageType.SAVE_CONFIG]: handleSaveConfig,
    [MessageType.TOGGLE_SELECTION_MODE]: handleToggleSelectionMode,
    [MessageType.TOGGLE_LIVE_PREVIEW]: handleToggleLivePreview,
    [MessageType.ELEMENT_SELECTED]: handleElementSelected,
    [MessageType.GET_ACTIVE_STATE]: handleGetActiveState,
    [MessageType.NETWORK_REQUEST_CAPTURED]: handleNetworkRequest,
    [MessageType.EXPORT_CONFIG]: handleExportConfig,
  };

  return handlers[type] || null;
}

/**
 * Check if message type is a pass-through for the panel
 * @param {string} type - Message type
 * @returns {boolean}
 */
function isPassThroughMessage(type) {
  const passThroughTypes = [
    MessageType.RECORDING_EVENT,
    MessageType.RRWEB_EVENT,
    MessageType.RRWEB_STATUS,
    MessageType.RECORDING_STARTED,
    MessageType.RECORDING_STOPPED,
    MessageType.RECORDING_RESUMED,
    MessageType.RECORDING_ERROR,
    MessageType.NETWORK_EVENT,
    MessageType.CUSTOM_EVENT,
    MessageType.EVENTS_DATA,
  ];

  return passThroughTypes.includes(type);
}

// ============================================================================
// CONFIG HANDLERS
// ============================================================================

/**
 * Get current configuration
 * @param {Object} _payload - Message payload (unused)
 * @param {Object} _sender - Message sender (unused)
 * @param {Function} sendResponse - Response callback
 */
async function handleGetConfig(_payload, _sender, sendResponse) {
  try {
    const result = await chrome.storage.local.get('config');
    sendResponse({ 
      success: true, 
      config: result.config || createMutableConfig() 
    });
  } catch (error) {
    logError('Failed to get config:', error);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Save configuration updates
 * @param {Partial<ConfigState>} updates - Config updates
 * @param {Object} _sender - Message sender (unused)
 * @param {Function} sendResponse - Response callback
 */
async function handleSaveConfig(updates, _sender, sendResponse) {
  try {
    const result = await chrome.storage.local.get('config');
    const currentConfig = result.config || createMutableConfig();
    const newConfig = deepMerge(currentConfig, updates);

    await chrome.storage.local.set({ config: newConfig });

    // Notify all tabs about config update
    await broadcastToContentScripts({ type: 'CONFIG_UPDATED', payload: newConfig });

    sendResponse({ success: true, config: newConfig });
  } catch (error) {
    logError('Failed to save config:', error);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Export configuration as JSON
 * @param {Object} _payload - Message payload (unused)
 * @param {Object} _sender - Message sender (unused)
 * @param {Function} sendResponse - Response callback
 */
async function handleExportConfig(_payload, _sender, sendResponse) {
  try {
    const result = await chrome.storage.local.get('config');
    const config = result.config || createMutableConfig();

    // Add version and timestamp
    const exportConfig = {
      config_version: '1.0.0',
      exported_at: new Date().toISOString(),
      ...config,
    };

    sendResponse({ success: true, config: exportConfig });
  } catch (error) {
    logError('Failed to export config:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// ============================================================================
// SELECTION MODE HANDLERS
// ============================================================================

/**
 * Toggle element selection mode
 * @param {Object} payload - Message payload
 * @param {Object} sender - Message sender
 * @param {Function} sendResponse - Response callback
 */
async function handleToggleSelectionMode(payload, sender, sendResponse) {
  const tabId = sender.tab?.id || payload?.tabId;

  if (!tabId) {
    sendResponse({ success: false, error: 'No active tab' });
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SET_SELECTION_MODE',
      payload: { 
        enabled: payload?.enabled ?? false, 
        selectionType: payload?.selectionType 
      },
    });

    sendResponse({ success: true });
  } catch (error) {
    logError('Failed to toggle selection mode:', error);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Toggle live preview mode
 * @param {Object} payload - Message payload
 * @param {Object} sender - Message sender
 * @param {Function} sendResponse - Response callback
 */
async function handleToggleLivePreview(payload, sender, sendResponse) {
  const tabId = sender.tab?.id || payload?.tabId;

  if (!tabId) {
    sendResponse({ success: false, error: 'No active tab' });
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SET_LIVE_PREVIEW',
      payload: { enabled: payload?.enabled ?? false },
    });

    sendResponse({ success: true });
  } catch (error) {
    logError('Failed to toggle live preview:', error);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Handle element selection from content script
 * @param {Object} payload - Message payload
 * @param {Object} _sender - Message sender (unused)
 * @param {Function} sendResponse - Response callback
 */
async function handleElementSelected(payload, _sender, sendResponse) {
  const { selector, selectionType } = payload || {};

  if (!selector) {
    sendResponse({ success: false, error: 'No selector provided' });
    return;
  }

  try {
    const result = await chrome.storage.local.get('config');
    const config = result.config || createMutableConfig();

    // Add selector based on selection type
    updateConfigForSelectionType(config, selector, selectionType);

    await chrome.storage.local.set({ config });

    // Notify popup about the update
    notifySelectionComplete(selector, selectionType, payload?.elementInfo, config);

    sendResponse({ success: true, config });
  } catch (error) {
    logError('Failed to handle element selection:', error);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Update config based on selection type
 * @param {Object} config - Config object
 * @param {string} selector - CSS selector
 * @param {string} selectionType - Type of selection
 */
function updateConfigForSelectionType(config, selector, selectionType) {
  switch (selectionType) {
    case 'mask':
      if (!config.maskingRules.selectors.includes(selector)) {
        config.maskingRules.selectors.push(selector);
      }
      break;

    case 'error':
      config.errorTracking.errorContainerSelector = selector;
      break;

    case 'step':
      config.journeyMapping.steps.selector = selector;
      break;

    case 'success':
      config.journeyMapping.successIndicator.selector = selector;
      break;

    default:
      log('Unknown selection type:', selectionType);
  }
}

/**
 * Notify about selection completion
 * @param {string} selector - Selected selector
 * @param {string} selectionType - Selection type
 * @param {Object} elementInfo - Element info
 * @param {Object} config - Updated config
 */
function notifySelectionComplete(selector, selectionType, elementInfo, config) {
  chrome.runtime.sendMessage({
    type: 'SELECTION_COMPLETE',
    payload: { selector, selectionType, elementInfo, config },
  }).catch(() => {
    // Popup might not be open, that's ok
  });
}

// ============================================================================
// STATE HANDLERS
// ============================================================================

/**
 * Get active state for current tab
 * @param {Object} _payload - Message payload (unused)
 * @param {Object} sender - Message sender
 * @param {Function} sendResponse - Response callback
 */
function handleGetActiveState(_payload, sender, sendResponse) {
  const tabId = sender.tab?.id;
  const state = activeTabs.get(tabId) || {
    selectionMode: false,
    livePreview: false,
    selectionType: null,
  };
  sendResponse({ success: true, state });
}

// ============================================================================
// NETWORK HANDLERS
// ============================================================================

/**
 * Handle captured network request
 * @param {Object} payload - Network request data
 * @param {Object} _sender - Message sender (unused)
 * @param {Function} sendResponse - Response callback
 */
function handleNetworkRequest(payload, _sender, sendResponse) {
  // Forward to popup if open
  chrome.runtime.sendMessage({
    type: 'NETWORK_REQUEST',
    payload,
  }).catch(() => {
    // Popup might not be open, that's ok
  });

  sendResponse({ success: true });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Broadcast message to all content scripts
 * @param {Object} message - Message to broadcast
 */
async function broadcastToContentScripts(message) {
  try {
    const tabs = await chrome.tabs.query({});

    const sendPromises = tabs
      .filter(tab => tab.id)
      .map(tab => 
        chrome.tabs.sendMessage(tab.id, message).catch(() => {
          // Tab might not have content script, that's ok
        })
      );

    await Promise.allSettled(sendPromises);
  } catch (error) {
    logError('Failed to broadcast message:', error);
  }
}

/**
 * Create a mutable copy of the default config
 * @returns {Object} Mutable config object
 */
function createMutableConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/**
 * Deep merge two objects
 * @param {Object} target - Target object
 * @param {Object} source - Source object
 * @returns {Object} Merged object
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') {
    return target;
  }

  const output = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== null &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      output[key] = deepMerge(targetValue, sourceValue);
    } else {
      output[key] = sourceValue;
    }
  }

  return output;
}

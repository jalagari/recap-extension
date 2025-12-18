/**
 * Recap - Service Worker v5.4.0
 * Optimized: Uses URL-indexed config lookup for O(1) performance
 * Cross-page recording handled by recorder-entry.js via sessionStorage
 */

'use strict';

const log = (...args) => console.log('[Recap SW]', ...args);

// API URL for fetching configs
const API_URL = 'https://recap-api.crispr-api.workers.dev';

// Cache for config by URL (avoids repeated API calls)
const configByUrlCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// API Access (Optimized)
// ============================================================================

/**
 * Get config by URL using the optimized URL-indexed API
 * O(1) lookup instead of fetching all configs and searching
 */
async function getConfigByUrl(url) {
  if (!url) return null;
  
  // Check cache
  const cached = configByUrlCache.get(url);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    log('Using cached config for URL');
    return cached.config;
  }
  
  try {
    log('Looking up config by URL...');
    const res = await fetch(`${API_URL}/api/configs/by-url?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json();
    const config = data.config || null;
    
    // Cache result
    configByUrlCache.set(url, { config, time: Date.now() });
    
    if (config) {
      log('Found config via URL index:', config.name);
    } else {
      log('No config found for URL');
    }
    
    return config;
  } catch (e) {
    log('Failed to lookup config by URL:', e.message);
    // Return stale cache if available
    return configByUrlCache.get(url)?.config || null;
  }
}

/**
 * Get all configs (for listing in sidepanel)
 */
async function getAllConfigs() {
  try {
    const res = await fetch(`${API_URL}/api/configs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json();
    return data.configs || [];
  } catch (e) {
    log('Failed to fetch configs:', e.message);
    return [];
  }
}

/**
 * Get config by ID (for loading full config)
 */
async function getConfigById(configId) {
  try {
    const res = await fetch(`${API_URL}/api/configs/${configId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    log('Failed to fetch config:', e.message);
    return null;
  }
}

// ============================================================================
// Auto-Start Recording (Simplified)
// ============================================================================

async function tryAutoStartRecording(tabId, url) {
  log('[Recap] Auto-start check:', { tabId, url });
  
  // Skip non-http URLs
  if (!url || !url.startsWith('http')) {
    log('[Recap] Skipping non-HTTP URL');
    return;
  }
  
  // Use optimized URL lookup (no need to fetch all configs)
  const config = await getConfigByUrl(url);
  if (!config) {
    log('[Recap] No configuration found for URL, skipping auto-start');
    return;
  }
  
  log('[Recap] Configuration found for auto-start:', {
    configId: config.id,
    configName: config.name,
    url: url
  });
  
  // Check sampling rate
  const samplingRate = config.settings?.sampling_rate ?? 1.0;
  if (Math.random() > samplingRate) {
    log('[Recap] Skipped by sampling rate:', samplingRate);
    return;
  }
  
  log('[Recap] Auto-starting recording:', {
    tabId,
    configId: config.id,
    configName: config.name,
    samplingRate,
    timestamp: new Date().toISOString()
  });
  
  // Send start recording message
  // The recorder will handle "already recording" case by stopping and restarting
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'START_RECORDING',
      config: config,
      autoStart: true  // Flag to indicate this is auto-start
    });
    log('[Recap] Auto-start recording message sent successfully to tab:', tabId);
  } catch (e) {
    log('[Recap] Failed to auto-start recording:', {
      tabId,
      error: e.message,
      stack: e.stack
    });
  }
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

const FORWARD_TYPES = [
  'RRWEB_EVENT',
  'RECORDING_STARTED',
  'RECORDING_STOPPED',
  'RECORDING_ERROR',
  'RECORDING_RESUMED',
  'LIVE_EVENT',
  'QUALITY_UPDATE'
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const from = sender.tab ? `tab:${sender.tab.id}` : 'extension';
  log('Message:', message.type, 'from:', from);
  
  // Handle config requests (used by sidepanel)
  if (message.type === 'GET_CONFIG') {
    getConfigById(message.configId).then(config => {
      sendResponse({ config });
    });
    return true;
  }
  
  if (message.type === 'GET_ALL_CONFIGS') {
    getAllConfigs().then(configs => {
      const configMap = {};
      configs.forEach(c => { configMap[c.id] = c; });
      sendResponse({ configs: configMap });
    });
    return true;
  }
  
  // New: Get config by URL (for optimized lookup)
  if (message.type === 'GET_CONFIG_BY_URL') {
    getConfigByUrl(message.url).then(config => {
      sendResponse({ config });
    });
    return true;
  }
  
  // Forward relevant messages to sidepanel
  if (FORWARD_TYPES.includes(message.type)) {
    chrome.runtime.sendMessage(message).catch(() => {});
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
    
    // Notify sidepanel of tab change
    chrome.runtime.sendMessage({
      type: 'TAB_ACTIVATED',
      tabId: info.tabId,
      url: tab.url
    }).catch(() => {});
  } catch (e) {
    log('Tab error:', e);
  }
});

// Auto-start on page load
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  
  // Delay to ensure content script is ready
  setTimeout(() => {
    tryAutoStartRecording(tabId, tab.url);
  }, 1000);
});

log('Service Worker v5.4.0 started - Optimized URL-indexed config lookup');

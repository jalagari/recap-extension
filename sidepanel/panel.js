/**
 * Recap Extension - Simplified Panel v2
 * Uses content script for recording, Worker API for storage
 */

import { api } from '../lib/api.js';
import { RecapPlayer } from '../lib/sdk/index.js';

// ============================================================================
// State
// ============================================================================

const state = {
  currentUrl: null,
  currentTabId: null,
  pageTitle: '',
  recordingStartUrl: null, // Original URL when recording started (for config path)
  recordingStartTitle: '', // Original title when recording started
  config: null,
  sampleEvents: [],
  sampleDuration: 0,
  sampleQuality: null, // Quality report from recording
  detectedFields: [],
  view: 'loading',
  liveEvents: [],
  liveFilter: 'all'
};

// Dashboard URL
const DASHBOARD_URL = 'http://localhost:3000';

/**
 * Normalize URL by removing query params and hash
 */
function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

// ============================================================================
// Message Listener (set up early)
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'LIVE_EVENT') {
    console.log('[Panel] Live event:', message.event?.label, 'count:', message.eventCount);
    
    if (state.view === 'recording') {
      addLiveEvent(message.event);
      const recEvents = document.querySelector('#rec-events');
      if (recEvents) recEvents.textContent = message.eventCount;
    }
  }
  
  if (message.type === 'QUALITY_UPDATE') {
    console.log('[Panel] Quality update:', message.quality?.score, message.severity);
    
    if (state.view === 'recording') {
      updateQualityDisplay(message.quality, message.severity);
    }
  }
});

// ============================================================================
// DOM Helpers
// ============================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function showView(viewId) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $(`#view-${viewId}`)?.classList.remove('hidden');
  state.view = viewId;
  
  // Hide page info section when showing "New Configuration" or "Has Config" to avoid redundancy
  // (both views show the config name/title, so page-info is redundant)
  const pageInfoSection = $('#page-info-section');
  if (pageInfoSection) {
    if (viewId === 'no-config' || viewId === 'has-config') {
      pageInfoSection.style.display = 'none';
    } else {
      pageInfoSection.style.display = 'block';
    }
  }
  
  console.log('[Panel] View:', viewId);
}

function updateStatus(text, color = '') {
  const dot = $('.status-dot');
  const textEl = $('.status-text');
  
  dot.className = 'status-dot ' + color;
  textEl.textContent = text;
}

function updatePageInfo(url, title) {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    const path = urlObj.pathname + (urlObj.hash || '');
    
    $('#page-title').textContent = title || domain;
    $('#page-domain').textContent = `${domain}${path}`;
  } catch {
    $('#page-title').textContent = title || 'Unknown';
    $('#page-domain').textContent = url || '';
  }
}

// ============================================================================
// Tab Communication
// ============================================================================

async function sendToTab(message, retries = 3) {
  if (!state.currentTabId) return null;
  
  for (let i = 0; i < retries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(state.currentTabId, message);
      return response;
    } catch (e) {
      console.warn(`[Panel] sendToTab attempt ${i + 1} failed:`, e.message);
      
      if (i < retries - 1) {
        // Wait and retry
        await new Promise(r => setTimeout(r, 500));
        
        // Try to re-inject content script
        try {
          await chrome.scripting.executeScript({
            target: { tabId: state.currentTabId },
            files: ['content/content.js']
          });
          await new Promise(r => setTimeout(r, 1000)); // Wait for init
        } catch (injectErr) {
          console.warn('[Panel] Re-inject failed:', injectErr.message);
        }
      }
    }
  }
  
  console.error('[Panel] sendToTab failed after retries');
  return null;
}

async function ensureContentScriptReady() {
  // Try to ping the content script
  const response = await sendToTab({ type: 'PING' }, 1);
  
  if (!response?.ready) {
    console.log('[Panel] Content script not ready, injecting...');
    
    try {
      await chrome.scripting.executeScript({
        target: { tabId: state.currentTabId },
        files: ['content/content.js']
      });
      
      // Wait for initialization
      await new Promise(r => setTimeout(r, 1500));
      
      return true;
    } catch (e) {
      console.error('[Panel] Failed to inject content script:', e);
      return false;
    }
  }
  
  return true;
}

// ============================================================================
// Recording
// ============================================================================

let recordingTimer = null;
let recordingStartTime = null;

async function startRecording() {
  console.log('[Panel] Starting recording...');
  updateStatus('Starting...', 'yellow');
  
  // Save the original URL and title when recording starts
  state.recordingStartUrl = normalizeUrl(state.currentUrl);
  state.recordingStartTitle = state.pageTitle;
  
  console.log('[Panel] Recording start URL:', state.recordingStartUrl);
  
  // Build config from setup settings or existing config
  const recordingConfig = state.config || buildSetupConfig();
  
  function buildSetupConfig() {
    return {
      sessionQuality: {
        enabled: $('#setup-quality-enabled')?.checked ?? true,
        reportButton: {
          mode: $('#setup-report-mode')?.value || 'on_error'
        },
        weights: {
          jsError: parseInt($('#setup-weight-jsError')?.value) || 40,
          networkError: parseInt($('#setup-weight-networkError')?.value) || 40,
          rageClick: parseInt($('#setup-weight-rageClick')?.value) || 25,
          validationLoop: parseInt($('#setup-weight-validationLoop')?.value) || 15,
          deadClick: parseInt($('#setup-weight-deadClick')?.value) || 10
        },
        thresholds: {
          critical: parseInt($('#setup-threshold-critical')?.value) || 80,
          review: parseInt($('#setup-threshold-review')?.value) || 50
        }
      }
    };
  }
  
  console.log('[Panel] Recording config:', recordingConfig);
  
  // Ensure content script is ready
  const ready = await ensureContentScriptReady();
  if (!ready) {
    updateStatus('Cannot access page', 'red');
    console.error('[Panel] Content script not available');
    return;
  }
  
  // Send start message to content script
  // forceRestart: true will stop any existing recording and start fresh
  const response = await sendToTab({
    type: 'START_RECORDING',
    config: recordingConfig,
    forceRestart: true  // User-initiated recording always restarts
  });
  
  if (!response?.success) {
    updateStatus('Failed to start', 'red');
    console.error('[Recap] Recording start failed:', {
      error: response?.error || 'Unknown error',
      config: recordingConfig?.name || 'No config',
      url: state.currentUrl
    });
    return;
  }
  
  recordingStartTime = Date.now();
  state.liveEvents = [];
  showView('recording');
  updateStatus('Recording', 'red');
  
  console.log('[Recap] Recording started:', {
    sessionId: response?.sessionId || 'unknown',
    configName: recordingConfig?.name || 'No config',
    configId: recordingConfig?.id,
    startUrl: state.recordingStartUrl,
    startTime: new Date(recordingStartTime).toISOString(),
    timestamp: recordingStartTime
  });
  
  // Clear live events display
  renderLiveEvents();
  
  // Update stats periodically
  recordingTimer = setInterval(updateRecordingStats, 500);
}

async function updateRecordingStats() {
  const duration = Date.now() - recordingStartTime;
  
  // Get current event count from content script
  const response = await sendToTab({ type: 'GET_RECORDING_STATUS' });
  const eventCount = response?.eventCount || 0;
  
  $('#rec-duration').textContent = formatDuration(duration);
  $('#rec-events').textContent = eventCount;
}

// ============================================================================
// Live Events Display
// ============================================================================

function addLiveEvent(event) {
  // Only show important events
  if (!event.label || event.label === 'Mouse' || event.label === 'Scroll') return;
  
  state.liveEvents.unshift(event); // Add to front
  
  // Keep max 50 events
  if (state.liveEvents.length > 50) {
    state.liveEvents.pop();
  }
  
  renderLiveEvents();
}

function updateQualityDisplay(quality, severity) {
  // Update score badge
  const badge = $('#quality-score-badge');
  if (badge) {
    badge.textContent = quality.score || 0;
    badge.className = 'quality-score-badge ' + (severity || 'good');
  }
  
  // Helper to get count from either old array format or new signals format
  const getCount = (field) => {
    // New SDK format: quality.signals.jsErrors (number)
    if (quality.signals && typeof quality.signals[field] === 'number') {
      return quality.signals[field];
    }
    // Old extension format: quality.jsErrors (array)
    if (Array.isArray(quality[field])) {
      return quality[field].length;
    }
    return 0;
  };
  
  // Update individual detector counts
  const updateDetector = (id, count) => {
    const el = $(`#det-${id}`);
    if (el) {
      el.textContent = count || 0;
      el.className = 'detector-count' + (count > 0 ? ' active' : '');
    }
  };
  
  updateDetector('jsError', getCount('jsErrors'));
  updateDetector('networkError', getCount('networkErrors'));
  updateDetector('rageClick', getCount('rageClicks'));
  updateDetector('deadClick', getCount('deadClicks'));
  updateDetector('validationLoop', getCount('validationLoops'));
}

function renderLiveEvents() {
  const container = $('#live-events-list');
  if (!container) return;
  
  const filtered = state.liveEvents.filter(e => {
    if (state.liveFilter === 'all') return true;
    if (state.liveFilter === 'input' && e.label === 'Input') return true;
    if (state.liveFilter === 'click' && e.label === 'Click') return true;
    return false;
  });
  
  if (filtered.length === 0) {
    container.innerHTML = '<div class="live-event-placeholder">Events will appear here...</div>';
    return;
  }
  
  container.innerHTML = filtered.slice(0, 30).map(event => {
    const icon = event.label === 'Click' ? '🖱️' : event.label === 'Input' ? '⌨️' : '📍';
    const time = new Date(event.timestamp).toLocaleTimeString();
    const selector = event.id ? `[data-rr-id="${event.id}"]` : '';
    
    return `
      <div class="live-event-item">
        <span class="live-event-icon">${icon}</span>
        <div class="live-event-info">
          <div class="live-event-label">${escapeHtml(event.label)}</div>
          ${selector ? `<div class="live-event-selector">${escapeHtml(selector)}</div>` : ''}
        </div>
        <span class="live-event-time">${time}</span>
      </div>
    `;
  }).join('');
}

async function stopRecording() {
  console.log('[Panel] Stopping recording...');
  
  clearInterval(recordingTimer);
  recordingTimer = null;
  
  // Send stop message and get events + quality
  const response = await sendToTab({ type: 'STOP_RECORDING' });
  
  if (!response?.success) {
    updateStatus('Failed to stop', 'red');
    return;
  }
  
  // Sample implementation disabled - don't store sample events
  // state.sampleEvents = response.events || [];
  // state.sampleDuration = Date.now() - recordingStartTime;
  // state.sampleQuality = response.quality || null;
  state.sampleEvents = [];
  state.sampleDuration = 0;
  state.sampleQuality = null;
  
  const endTime = Date.now();
  const duration = state.sampleDuration;
  
  console.log('[Recap] Recording ended:', {
    eventCount: state.sampleEvents.length,
    durationMs: duration,
    durationFormatted: formatDuration(duration),
    qualityScore: state.sampleQuality?.score || 0,
    qualitySeverity: state.sampleQuality?.severity || 'normal',
    qualitySignals: state.sampleQuality?.signals || {},
    startTime: recordingStartTime ? new Date(recordingStartTime).toISOString() : null,
    endTime: new Date(endTime).toISOString(),
    startUrl: state.recordingStartUrl,
    hasSnapshot: state.sampleEvents.some(e => e.type === 2),
    snapshotCount: state.sampleEvents.filter(e => e.type === 2).length
  });
  
  // Extract fields from events
  state.detectedFields = extractFieldsFromEvents(state.sampleEvents);
  
  // Show configure view
  showConfigureView();
}

// ============================================================================
// Field Extraction
// ============================================================================

function extractFieldsFromEvents(events) {
  const fields = [];
  const seen = new Set();
  
  console.log('[Panel] Extracting fields from', events.length, 'events');
  
  for (const event of events) {
    // Full snapshot - extract form elements
    if (event.type === 2 && event.data?.node) {
      extractFieldsFromNode(event.data.node, fields, seen);
    }
    
    // Input events (type 3, source 5)
    if (event.type === 3 && event.data?.source === 5) {
      const id = event.data.id;
      if (id && !seen.has(`input-${id}`)) {
        seen.add(`input-${id}`);
        const text = event.data.text || '';
        fields.push({
          type: 'input',
          id,
          selector: `[data-rr-id="${id}"]`,
          label: text ? `Input: "${text.slice(0, 20)}${text.length > 20 ? '...' : ''}"` : 'Input Field',
          action: 'masked' // Default to masked
        });
      }
    }
    
    // Click events (type 3, source 2 = MouseInteraction)
    // MouseInteraction types: 0=MouseUp, 1=MouseDown, 2=Click, 3=ContextMenu, etc.
    if (event.type === 3 && event.data?.source === 2) {
      const id = event.data.id;
      const interactionType = event.data.type; // 2 = Click
      
      // Only capture actual clicks (type 2) or mouse downs (type 1)
      if (id && (interactionType === 2 || interactionType === 1) && !seen.has(`click-${id}`)) {
        seen.add(`click-${id}`);
        fields.push({
          type: 'click',
          id,
          selector: `[data-rr-id="${id}"]`,
          label: 'Click',
          action: 'none' // Default to none, user can mark as step
        });
      }
    }
  }
  
  console.log('[Panel] Extracted', fields.length, 'fields:', 
    fields.filter(f => f.type === 'input').length, 'inputs,',
    fields.filter(f => f.type === 'click').length, 'clicks');
  
  return fields;
}

function extractFieldsFromNode(node, fields, seen, depth = 0) {
  if (depth > 10 || !node) return;
  
  const tag = node.tagName?.toLowerCase();
  
  // Check if it's an input element
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const id = node.id;
    if (id && !seen.has(`field-${id}`)) {
      seen.add(`field-${id}`);
      
      const attrs = node.attributes || {};
      const inputType = attrs.type || 'text';
      const name = attrs.name || '';
      const placeholder = attrs.placeholder || '';
      const label = attrs['aria-label'] || attrs.title || '';
      
      // Build a descriptive name
      const displayName = name || placeholder || label || 'field';
      const fieldLabel = formatFieldLabel(inputType, displayName);
      
      fields.push({
        type: 'input',
        id,
        selector: buildSelector(node),
        label: fieldLabel,
        name: displayName,
        inputType,
        action: inputType === 'hidden' ? 'ignored' : 'masked'
      });
    }
  }
  
  // Check for buttons
  if (tag === 'button' || (tag === 'input' && node.attributes?.type === 'submit')) {
    const id = node.id;
    if (id && !seen.has(`btn-${id}`)) {
      seen.add(`btn-${id}`);
      
      const attrs = node.attributes || {};
      const text = node.textContent?.trim() || attrs.value || attrs.title || 'Button';
      
      fields.push({
        type: 'click',
        id,
        selector: buildSelector(node),
        label: `button: ${text}`,
        name: text,
        action: 'none'
      });
    }
  }
  
  // Recurse into children
  if (node.childNodes) {
    for (const child of node.childNodes) {
      extractFieldsFromNode(child, fields, seen, depth + 1);
    }
  }
}

function formatFieldLabel(inputType, name) {
  // Clean up the name for display
  const cleanName = name
    .replace(/([A-Z])/g, ' $1') // camelCase to spaces
    .replace(/[_-]/g, ' ')      // underscores/dashes to spaces
    .replace(/\s+/g, ' ')       // multiple spaces to single
    .trim();
  
  const typeIcon = {
    'text': '📝',
    'email': '📧',
    'password': '🔑',
    'tel': '📞',
    'number': '🔢',
    'date': '📅',
    'hidden': '👁️‍🗨️',
    'checkbox': '☑️',
    'radio': '🔘',
    'select': '📋',
    'textarea': '📄',
    'submit': '🔵'
  }[inputType] || '📝';
  
  return `${typeIcon} ${cleanName || inputType}`;
}

function buildSelector(node) {
  const attrs = node.attributes || {};
  if (attrs.id) {
    return `#${attrs.id}`;
  }
  if (attrs.name) {
    return `[name="${attrs.name}"]`;
  }
  return `[data-rr-id="${node.id}"]`;
}

// ============================================================================
// Configure View
// ============================================================================

function showConfigureView() {
  showView('configure');
  
  // Set form name - use config name, recording start title, or current page title
  const formName = state.config?.name || state.recordingStartTitle || state.pageTitle || 'New Form';
  $('#config-form-name').value = formName;
  
  // Sample implementation disabled
  // Update sample info
  // $('#sample-events').textContent = state.sampleEvents.length;
  // $('#sample-duration').textContent = formatDuration(state.sampleDuration);
  
  // Update sample status and buttons
  // const sampleStatus = $('#sample-status');
  // const previewBtn = $('#btn-preview-sample');
  // const hasSavedSample = state.config?.sample?.recording_id;
  // const hasCurrentSample = state.sampleEvents.length > 0;
  
  // if (hasCurrentSample) {
  //   sampleStatus.textContent = hasSavedSample ? '✓ Saved' : 'New';
  //   sampleStatus.className = 'sample-status ' + (hasSavedSample ? 'saved' : 'new');
  //   previewBtn.disabled = false;
  //   previewBtn.style.opacity = '1';
  // } else {
  //   sampleStatus.textContent = '';
  //   sampleStatus.className = 'sample-status';
  //   previewBtn.disabled = true;
  //   previewBtn.style.opacity = '0.5';
  // }
  
  // Display quality summary if available
  const qualitySummary = $('#quality-summary');
  if (qualitySummary && state.sampleQuality) {
    const q = state.sampleQuality;
    const severityColors = { critical: '#ef4444', review: '#f59e0b', good: '#10b981', normal: '#10b981' };
    
    // Handle both old array format and new signals format
    const getCount = (field) => {
      // New SDK format: q.signals.jsErrors (number)
      if (q.signals && typeof q.signals[field] === 'number') {
        return q.signals[field];
      }
      // Old extension format: q.jsErrors (array)
      if (Array.isArray(q[field])) {
        return q[field].length;
      }
      return 0;
    };
    
    const issues = [];
    if (getCount('jsErrors')) issues.push(`${getCount('jsErrors')} JS errors`);
    if (getCount('networkErrors')) issues.push(`${getCount('networkErrors')} network errors`);
    if (getCount('rageClicks')) issues.push(`${getCount('rageClicks')} rage clicks`);
    if (getCount('deadClicks')) issues.push(`${getCount('deadClicks')} dead clicks`);
    
    qualitySummary.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: ${severityColors[q.severity] || '#10b981'}15; border-radius: 6px; margin-top: 8px;">
        <span style="font-size: 18px; font-weight: 700; color: ${severityColors[q.severity] || '#10b981'}">${q.score}</span>
        <span style="font-size: 11px; text-transform: uppercase; color: ${severityColors[q.severity] || '#10b981'}">${q.severity}</span>
        ${issues.length ? `<span style="font-size: 11px; color: var(--text-muted); margin-left: auto;">${issues.join(', ')}</span>` : ''}
      </div>
    `;
    qualitySummary.classList.remove('hidden');
  } else if (qualitySummary) {
    qualitySummary.innerHTML = '';
    qualitySummary.classList.add('hidden');
  }
  
  // Load quality settings
  const quality = state.config?.sessionQuality || {};
  const weights = quality.weights || {};
  const qualityEnabled = quality.enabled !== false;
  
  $('#quality-enabled').checked = qualityEnabled;
  
  // Load thresholds and update display values
  const criticalVal = quality.thresholds?.critical || 80;
  const reviewVal = quality.thresholds?.review || 50;
  $('#threshold-critical').value = criticalVal;
  $('#threshold-review').value = reviewVal;
  $('#threshold-critical-val').textContent = criticalVal;
  $('#threshold-review-val').textContent = reviewVal;
  
  // Load detector weights and update display values
  const jsErrorVal = weights.jsError ?? 40;
  const networkErrorVal = weights.networkError ?? 40;
  const rageClickVal = weights.rageClick ?? 25;
  const deadClickVal = weights.deadClick ?? 10;
  const validationLoopVal = weights.validationLoop ?? 15;
  
  $('#weight-jsError').value = jsErrorVal;
  $('#weight-networkError').value = networkErrorVal;
  $('#weight-rageClick').value = rageClickVal;
  $('#weight-deadClick').value = deadClickVal;
  $('#weight-validationLoop').value = validationLoopVal;
  
  $('#weight-jsError-val').textContent = jsErrorVal;
  $('#weight-networkError-val').textContent = networkErrorVal;
  $('#weight-rageClick-val').textContent = rageClickVal;
  $('#weight-deadClick-val').textContent = deadClickVal;
  $('#weight-validationLoop-val').textContent = validationLoopVal;
  
  // Load report button mode
  $('#report-button-mode').value = quality.reportButton?.mode || 'on_error';
  
  // Toggle quality settings visibility
  toggleQualitySettings(qualityEnabled);
  
  // Load sampling rate (convert decimal to percentage)
  const samplingRate = state.config?.settings?.sampling_rate;
  const samplingPercent = samplingRate ? Math.round(samplingRate * 100) : 25;
  $('#sampling-rate').value = samplingPercent;
  $('#sampling-value').textContent = `${samplingPercent}%`;
  
  $('#completion-selector').value = state.config?.fields?.completion?.selector || '';
  
  // Render fields
  renderFields();
}

function toggleQualitySettings(enabled) {
  const settings = $('#quality-settings');
  if (settings) {
    settings.classList.toggle('disabled', !enabled);
  }
}

function renderFields(filter = 'all') {
  const container = $('#fields-list');
  
  const filteredFields = state.detectedFields.filter(f => {
    if (filter === 'all') return true;
    if (filter === 'ignored') return f.action === 'ignored';
    return f.type === filter;
  });
  
  if (filteredFields.length === 0) {
    container.innerHTML = '<div class="empty-fields">No fields detected. Try recording again.</div>';
    return;
  }
  
  container.innerHTML = filteredFields.map((field, idx) => {
    // Find actual index in full array
    const actualIdx = state.detectedFields.findIndex(f => 
      f.selector === field.selector && f.type === field.type);
    
    // Get name display - use name if available, otherwise extract from label
    const displayName = field.name || field.label;
    const fieldIcon = field.type === 'click' ? '🖱️' : '';
    
    return `
    <div class="field-item ${field.action === 'ignored' ? 'ignored' : ''}" data-idx="${actualIdx}">
      <div class="field-info">
        <div class="field-label">${fieldIcon}${escapeHtml(field.label)}</div>
        <div class="field-selector">${escapeHtml(field.selector)}</div>
      </div>
      <div class="field-actions">
        <button class="field-action ${field.action === 'clear' ? 'active' : ''}" 
                data-action="clear" title="Clear (not masked)">✅</button>
        <button class="field-action ${field.action === 'masked' ? 'active' : ''}" 
                data-action="masked" title="Masked">🔒</button>
        <button class="field-action ${field.action === 'ignored' ? 'active' : ''}" 
                data-action="ignored" title="Ignore">🚫</button>
        ${field.type === 'click' ? `
          <button class="field-action ${field.action === 'step' ? 'active' : ''}" 
                  data-action="step" title="Track as step">📍</button>
        ` : ''}
      </div>
    </div>`;
  }).join('');
  
  // Add click handlers
  container.querySelectorAll('.field-action').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const item = e.target.closest('.field-item');
      const idx = parseInt(item.dataset.idx);
      const action = e.target.dataset.action;
      
      // Toggle action
      if (state.detectedFields[idx].action === action) {
        state.detectedFields[idx].action = 'none';
      } else {
        state.detectedFields[idx].action = action;
      }
      
      renderFields(filter);
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================================
// Save Configuration
// ============================================================================

async function saveConfiguration() {
  const name = $('#config-form-name').value.trim() || 'Untitled Form';
  
  // Use the original recording start URL (first page), not current URL
  const configUrl = state.recordingStartUrl || normalizeUrl(state.currentUrl);
  
  console.log('[Panel] Saving config for URL:', configUrl);
  
  // Build config object
  const config = {
    id: state.config?.id, // Keep existing ID if updating
    name,
    url_pattern: configUrl,
    
    fields: {
      clear: state.detectedFields.filter(f => f.action === 'clear').map(f => ({
        selector: f.selector,
        label: f.label
      })),
      masked: state.detectedFields.filter(f => f.action === 'masked').map(f => ({
        selector: f.selector,
        label: f.label
      })),
      ignored: state.detectedFields.filter(f => f.action === 'ignored').map(f => ({
        selector: f.selector,
        label: f.label
      })),
      steps: state.detectedFields.filter(f => f.action === 'step').map(f => ({
        selector: f.selector,
        label: f.label
      })),
      completion: {
        selector: $('#completion-selector').value.trim() || null
      }
    },
    
    sessionQuality: {
      enabled: $('#quality-enabled').checked,
      weights: {
        jsError: parseInt($('#weight-jsError')?.value) || 40,
        networkError: parseInt($('#weight-networkError')?.value) || 40,
        rageClick: parseInt($('#weight-rageClick')?.value) || 25,
        validationLoop: parseInt($('#weight-validationLoop')?.value) || 15,
        deadClick: parseInt($('#weight-deadClick')?.value) || 10
      },
      thresholds: {
        critical: parseInt($('#threshold-critical').value) || 80,
        review: parseInt($('#threshold-review').value) || 50
      },
      reportButton: {
        mode: $('#report-button-mode')?.value || 'on_error'
      }
    },
    
    settings: {
      sampling_rate: (parseInt($('#sampling-rate').value) || 25) / 100
    },
    
    // Sample implementation disabled
    // Sample metadata (full events saved separately)
    sample: null
  };
  
  console.log('[Panel] Saving config:', config.name);
  
  try {
    updateStatus('Saving...', 'yellow');
    
    // Save config first (fast operation)
    const result = await api.saveConfig(config);
    console.log('[Panel] Config saved:', result);
    
    // Keep local config (has all fields), just update id from server
    state.config = config;
    state.config.id = result.config?.id || result.id || config.id;
    state.config.version = result.config?.version || config.version || 1;
    
    console.log('[Panel] Updated state.config:', state.config);
    
    // Show success immediately
    showHasConfigView();
    updateStatus('Saved!', 'green');
    
    // Sample implementation disabled
    // Save sample recording in background (fire and forget)
    // if (state.sampleEvents.length > 0) {
    //   saveSampleRecordingInBackground(config, configUrl, name).catch(e => {
    //     console.warn('[Panel] Background sample save failed:', e);
    //     // Optionally show a subtle notification that sample is still uploading
    //   });
    // }
  } catch (e) {
    console.error('[Panel] Failed to save config:', e);
    updateStatus('Save failed - check API', 'red');
  }
}

/**
 * Save sample recording in background (non-blocking)
 */
async function saveSampleRecordingInBackground(config, configUrl, name) {
  // Build quality data - handle both old array format and new signals format
  const qualityData = state.sampleQuality || {};
  
  // Helper to get count from either format
  const getSignalCount = (field) => {
    // New SDK format: signals.jsErrors (number)
    if (qualityData.signals && typeof qualityData.signals[field] === 'number') {
      return qualityData.signals[field];
    }
    // Old extension format: jsErrors (array)
    if (Array.isArray(qualityData[field])) {
      return qualityData[field].length;
    }
    return 0;
  };
  
  const quality = {
    score: qualityData.score || 0,
    severity: qualityData.severity || 'normal',
    signals: {
      jsErrors: getSignalCount('jsErrors'),
      networkErrors: getSignalCount('networkErrors'),
      rageClicks: getSignalCount('rageClicks'),
      deadClicks: getSignalCount('deadClicks'),
      validationLoops: getSignalCount('validationLoops')
    },
    // Include detailed error data
    details: {
      jsErrors: qualityData.jsErrors || [],
      networkErrors: qualityData.networkErrors || [],
      rageClicks: qualityData.rageClicks || [],
      deadClicks: qualityData.deadClicks || [],
      validationLoops: qualityData.validationLoops || []
    },
    thresholds: {
      critical: config.sessionQuality?.thresholds?.critical || 80,
      review: config.sessionQuality?.thresholds?.review || 50
    },
    weights: config.sessionQuality?.weights || {}
  };
  
  const sampleRecording = {
    session_id: `sample_${Date.now()}`,
    config_id: config.id || state.config?.id || 'pending',
    form_name: `[Sample] ${name}`,
    url_pattern: configUrl,
    events: state.sampleEvents,
    event_count: state.sampleEvents.length,
    duration_ms: state.sampleDuration,
    start_time: new Date(Date.now() - state.sampleDuration).toISOString(),
    end_time: new Date().toISOString(),
    timestamp: new Date().toISOString(),
    is_sample: true,
    
    // Include quality data like report button
    quality,
    
    metadata: {
      url: configUrl,
      user_agent: navigator.userAgent,
      sdk_version: 'extension-3.2.0',
      recorded_by: 'extension',
      page_title: state.pageTitle || document.title
    }
  };
  
  console.log('[Panel] Saving sample recording in background...');
  
  try {
    const sampleResult = await api.saveRecording(sampleRecording);
    
    // Update config with sample recording ID if available
    if (state.config && sampleResult?.id) {
      if (!state.config.sample) {
        state.config.sample = {};
      }
      state.config.sample.recording_id = sampleResult.id;
      console.log('[Panel] Sample recording saved:', sampleResult.id);
    }
  } catch (e) {
    console.warn('[Panel] Failed to save sample recording:', e);
    // Don't throw - this is background operation
  }
}

// ============================================================================
// Views
// ============================================================================

function showHasConfigView() {
  if (!state.config) {
    console.warn('[Panel] showHasConfigView called with no config');
    showView('no-config');
    return;
  }
  
  showView('has-config');
  
  $('#config-name').textContent = state.config.name || 'Untitled';
  $('#config-version').textContent = `v${state.config.version || 1}`;
  
  const fields = state.config.fields || {};
  $('#stat-clear').textContent = `✅ ${fields.clear?.length || 0} clear`;
  $('#stat-masked').textContent = `🔒 ${fields.masked?.length || 0} masked`;
  $('#stat-steps').textContent = `📍 ${fields.steps?.length || 0} steps`;
  
  const qualityEnabled = state.config.sessionQuality?.enabled !== false;
  const qualityStatus = $('#config-quality .quality-status');
  if (qualityStatus) {
    qualityStatus.textContent = qualityEnabled ? '✓ Enabled' : '✗ Disabled';
    qualityStatus.style.color = qualityEnabled ? 'var(--success)' : 'var(--text-muted)';
  }
  
  console.log('[Panel] Showing config:', state.config.name);
}

// ============================================================================
// Export Scripts
// ============================================================================

function showExportModal(type) {
  const modal = $('#modal-export');
  modal.classList.remove('hidden');
  
  let code = '';
  
  if (type === 'embed') {
    $('#modal-title').textContent = 'Embed Script';
    code = generateEmbedScript();
  } else {
    $('#modal-title').textContent = 'Console Script';
    code = generateConsoleScript();
  }
  
  $('#export-code').textContent = code;
}

function generateEmbedScript() {
  const apiUrl = api.baseUrl;
  
  return `
<script type="module">
  import { RecapSDK } from '${apiUrl}/sdk/recap.js';
  RecapSDK.init({ debug: true });
</script>`;
}

function generateConsoleScript() {
  const apiUrl = api.baseUrl;
  
  return `
import('${apiUrl}/sdk/recap.js').then(({ RecapSDK }) => {
  window.RecapSDK = RecapSDK;
  RecapSDK.init({ debug: true });
  console.log('  RecapSDK.isRecording()          - Check status');
});`;
}

// ============================================================================
// Preview
// ============================================================================

async function showPreview() {
  if (state.sampleEvents.length === 0) {
    updateStatus('No recording to preview', 'yellow');
    return;
  }
  
  showView('preview');
  
  const container = $('#player-container');
  
  // Use RecapPlayer from SDK
  await RecapPlayer.play(container, state.sampleEvents, {
    autoPlay: false,
    showController: true,
    width: container.clientWidth || 380,
    height: 400
  });
}

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  console.log('[Panel] Initializing v2...');
  
  // Don't reinit if we're in the middle of recording
  if (state.view === 'recording') {
    console.log('[Panel] Skipping init - recording in progress');
    return;
  }
  
  // Sample implementation disabled
  // Don't reinit if we're configuring with sample data
  // if (state.view === 'configure' && state.sampleEvents?.length > 0) {
  //   console.log('[Panel] Skipping init - configuring recorded session');
  //   return;
  // }
  
  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    updateStatus('No active tab', 'red');
    return;
  }
  
  state.currentTabId = tab.id;
  state.currentUrl = tab.url;
  state.pageTitle = tab.title || '';
  
  updatePageInfo(tab.url, tab.title);
  
  // First check if there's an active recording on this page
  try {
    const recordingStatus = await sendToTab({ type: 'GET_RECORDING_STATUS' }, 1);
    if (recordingStatus?.isRecording) {
      console.log('[Panel] Found active recording, resuming UI');
      recordingStartTime = Date.now() - 1000; // Approximate
      state.liveEvents = [];
      showView('recording');
      updateStatus('Recording', 'red');
      recordingTimer = setInterval(updateRecordingStats, 500);
      return;
    }
  } catch (e) {
    // No active recording, continue with normal init
  }
  
  // Check for existing config from API
  updateStatus('Checking...', 'yellow');
  
  try {
    const config = await api.findConfigByUrl(tab.url);
    
    if (config) {
      state.config = config;
      console.log('[Recap] Configuration loading completed:', {
        configId: config.id,
        configName: config.name,
        configVersion: config.version,
        url: tab.url,
        hasFields: !!(config.fields && (config.fields.clear?.length || config.fields.masked?.length || config.fields.steps?.length)),
        qualityEnabled: config.sessionQuality?.enabled !== false
      });
      updateStatus('Config found', 'green');
      showHasConfigView();
    } else {
      state.config = null;
      console.log('[Recap] Configuration loading completed: No config found for URL:', tab.url);
      // Don't show "No config" status when showing "New Configuration" view (redundant)
      showView('no-config');
    }
  } catch (e) {
    console.warn('[Recap] Configuration loading failed:', {
      error: e.message,
      url: tab.url,
      stack: e.stack
    });
    state.config = null;
    updateStatus('API offline', 'yellow');
    // Show status for API errors, but hide when showing "New Configuration"
    const pageInfoSection = $('#page-info-section');
    if (pageInfoSection) {
      pageInfoSection.style.display = 'block';
    }
    showView('no-config');
  }
}

// ============================================================================
// Event Listeners
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  init();
  
  // Dashboard links
  $('#btn-dashboard').addEventListener('click', () => {
    window.open(DASHBOARD_URL, '_blank');
  });
  
  $('#link-dashboard').addEventListener('click', (e) => {
    e.preventDefault();
    window.open(DASHBOARD_URL, '_blank');
  });
  
  // Recording
  // Sample implementation disabled - comment out sample recording buttons
  // $('#btn-record-new').addEventListener('click', startRecording);
  // $('#btn-record-update').addEventListener('click', startRecording);
  $('#btn-stop-recording').addEventListener('click', stopRecording);
  
  // Sample implementation disabled
  // Preview sample from configure view
  // $('#btn-preview-sample').addEventListener('click', showPreview);
  
  // Live event filters
  $$('.live-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.live-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.liveFilter = btn.dataset.filter;
      renderLiveEvents();
    });
  });
  
  // Collapsible sections
  $('#toggle-thresholds')?.addEventListener('click', () => {
    const header = $('#toggle-thresholds');
    const content = $('#thresholds-content');
    header.classList.toggle('active');
    content.classList.toggle('collapsed');
  });
  
  $('#toggle-weights')?.addEventListener('click', () => {
    const header = $('#toggle-weights');
    const content = $('#weights-content');
    header.classList.toggle('active');
    content.classList.toggle('collapsed');
  });
  
  // Configure
  $('#btn-cancel-configure').addEventListener('click', () => {
    if (state.config) {
      showHasConfigView();
    } else {
      showView('no-config');
    }
  });
  
  $('#btn-edit-config').addEventListener('click', async () => {
    // Load existing fields from config
    state.detectedFields = [];
    
    const fields = state.config?.fields || {};
    console.log('[Panel] Loading config fields:', fields);
    
    // Load input fields
    (fields.clear || []).forEach(f => {
      state.detectedFields.push({ ...f, type: 'input', action: 'clear' });
    });
    (fields.masked || []).forEach(f => {
      state.detectedFields.push({ ...f, type: 'input', action: 'masked' });
    });
    (fields.ignored || []).forEach(f => {
      state.detectedFields.push({ ...f, type: 'input', action: 'ignored' });
    });
    
    // Load click fields (steps)
    (fields.steps || []).forEach(f => {
      state.detectedFields.push({ ...f, type: 'click', action: 'step' });
    });
    
    // Sample implementation disabled
    // Load saved sample recording if available
    // const sampleId = state.config?.sample?.recording_id;
    // if (sampleId) {
    //   try {
    //     updateStatus('Loading sample recording...', 'yellow');
    //     const recording = await api.getRecording(sampleId);
    //     if (recording?.events) {
    //       state.sampleEvents = recording.events;
    //       state.sampleDuration = recording.duration_ms || state.config?.sample?.duration_ms || 0;
    //       console.log('[Panel] Loaded sample recording:', state.sampleEvents.length, 'events');
    //     }
    //   } catch (e) {
    //     console.warn('[Panel] Failed to load sample recording:', e);
    //     state.sampleEvents = [];
    //     state.sampleDuration = 0;
    //   }
    // } else {
    //   state.sampleEvents = [];
    //   state.sampleDuration = state.config?.sample?.duration_ms || 0;
    // }
    state.sampleEvents = [];
    state.sampleDuration = 0;
    
    showConfigureView();
  });
  
  $('#btn-save-config').addEventListener('click', saveConfiguration);
  
  // Preview
  $('#btn-preview').addEventListener('click', showPreview);
  $('#btn-back-configure').addEventListener('click', showConfigureView);
  
  // Export
  $('#btn-export-embed').addEventListener('click', () => showExportModal('embed'));
  $('#btn-export-console').addEventListener('click', () => showExportModal('console'));
  
  // Modal
  $('#btn-close-modal').addEventListener('click', () => {
    $('#modal-export').classList.add('hidden');
  });
  
  $('#btn-copy-code').addEventListener('click', () => {
    const code = $('#export-code').textContent;
    navigator.clipboard.writeText(code);
    $('#btn-copy-code').textContent = '✓ Copied!';
    setTimeout(() => {
      $('#btn-copy-code').textContent = '📋 Copy';
    }, 2000);
  });
  
  // Tabs
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      $$('.tab-content').forEach(c => c.classList.add('hidden'));
      $(`#tab-${tab.dataset.tab}`).classList.remove('hidden');
    });
  });
  
  // Filters
  $$('.filter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderFields(btn.dataset.filter);
    });
  });
  
  // Quality toggle (configure view)
  $('#quality-enabled').addEventListener('change', (e) => {
    toggleQualitySettings(e.target.checked);
  });
  
  // Quality toggle (setup view)
  $('#setup-quality-enabled')?.addEventListener('change', (e) => {
    const settings = $('#setup-quality-settings');
    if (settings) {
      settings.style.display = e.target.checked ? 'block' : 'none';
    }
  });
  
  // Sampling rate slider
  $('#sampling-rate').addEventListener('input', (e) => {
    $('#sampling-value').textContent = `${e.target.value}%`;
  });
  
  // Setup view sliders (thresholds and weights)
  ['setup-threshold-critical', 'setup-threshold-review'].forEach(id => {
    const slider = $(`#${id}`);
    if (slider) {
      slider.addEventListener('input', (e) => {
        $(`#${id}-val`).textContent = e.target.value;
      });
    }
  });
  
  ['setup-weight-jsError', 'setup-weight-networkError', 'setup-weight-rageClick', 
   'setup-weight-deadClick', 'setup-weight-validationLoop'].forEach(id => {
    const slider = $(`#${id}`);
    if (slider) {
      slider.addEventListener('input', (e) => {
        $(`#${id}-val`).textContent = e.target.value;
      });
    }
  });
  
  // Configure view sliders (thresholds and weights)
  ['threshold-critical', 'threshold-review'].forEach(id => {
    const slider = $(`#${id}`);
    if (slider) {
      slider.addEventListener('input', (e) => {
        $(`#${id}-val`).textContent = e.target.value;
      });
    }
  });
  
  ['weight-jsError', 'weight-networkError', 'weight-rageClick', 
   'weight-deadClick', 'weight-validationLoop'].forEach(id => {
    const slider = $(`#${id}`);
    if (slider) {
      slider.addEventListener('input', (e) => {
        $(`#${id}-val`).textContent = e.target.value;
      });
    }
  });
  
  // Tab changes - refresh (but not if recording or configuring)
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    console.log('[Panel] Tab activated:', activeInfo.tabId, 'current:', state.currentTabId);
    
    if (activeInfo.tabId !== state.currentTabId) {
      const previousTabId = state.currentTabId;
      state.currentTabId = activeInfo.tabId;
      
      try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        state.currentUrl = tab.url;
        state.pageTitle = tab.title || '';
        updatePageInfo(tab.url, tab.title);
        
        // If recording was on previous tab, it's lost when switching tabs
        if (state.view === 'recording') {
          console.log('[Panel] Left recording tab, clearing recording state');
          clearInterval(recordingTimer);
          recordingTimer = null;
          // Don't reinit, stay in no-config
          showView('no-config');
          updateStatus('Recording lost', 'red');
          return;
        }
        
        // If configuring with sample data, warn user but don't lose data
        if (state.view === 'configure' && state.sampleEvents?.length > 0) {
          console.log('[Panel] Tab changed while configuring - keeping data');
          updateStatus('Save config before switching tabs!', 'yellow');
          return;
        }
        
        // Reinitialize for new tab
        init();
      } catch (e) {
        console.error('[Panel] Tab error:', e);
      }
    }
  });
  
  // URL changes - check if recording continued
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (tabId === state.currentTabId && changeInfo.url) {
      state.currentUrl = changeInfo.url;
      state.pageTitle = tab.title || state.pageTitle;
      updatePageInfo(changeInfo.url, tab.title);
      
      // If we were recording, check if recording resumed on the new page
      if (state.view === 'recording') {
        console.log('[Panel] URL changed while recording, checking status...');
        // Wait for new page to load and resume
        setTimeout(async () => {
          const status = await sendToTab({ type: 'GET_RECORDING_STATUS' });
          if (status?.isRecording) {
            console.log('[Panel] Recording resumed on new page');
            // Fetch current events
            const eventsResult = await sendToTab({ type: 'GET_LIVE_EVENTS' });
            if (eventsResult?.events) {
              state.liveEvents = eventsResult.events.filter(e => 
                e.label && e.label !== 'Mouse' && e.label !== 'Scroll'
              ).reverse();
              renderLiveEvents();
            }
          } else {
            console.log('[Panel] Recording not resumed, stopping');
            clearInterval(recordingTimer);
            recordingTimer = null;
            showView('no-config');
            updateStatus('Recording lost', 'red');
          }
        }, 2000);
      } else if (state.view === 'configure' && state.sampleEvents?.length > 0) {
        // Don't reinit if we're configuring a recorded session
        console.log('[Panel] URL changed but keeping configure view with recorded data');
      } else {
        init();
      }
    }
  });
});

// ============================================================================
// Helpers
// ============================================================================

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

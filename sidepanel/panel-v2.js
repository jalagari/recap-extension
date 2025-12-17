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
  console.log('[Panel] View:', viewId);
}

function updateStatus(text, color = '') {
  const dot = $('.status-dot');
  const textEl = $('.status-text');
  
  dot.className = 'status-dot ' + color;
  textEl.textContent = text;
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
            files: ['content/content-v2.js']
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
        files: ['content/content-v2.js']
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
  
  // Ensure content script is ready
  const ready = await ensureContentScriptReady();
  if (!ready) {
    updateStatus('Cannot access page', 'red');
    console.error('[Panel] Content script not available');
    return;
  }
  
  // Send start message to content script
  const response = await sendToTab({
    type: 'START_RECORDING',
    config: state.config || {}
  });
  
  if (!response?.success) {
    updateStatus('Failed to start', 'red');
    console.error('[Panel] Failed to start recording:', response);
    return;
  }
  
  recordingStartTime = Date.now();
  state.liveEvents = [];
  showView('recording');
  updateStatus('Recording', 'red');
  
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
  
  // Send stop message and get events
  const response = await sendToTab({ type: 'STOP_RECORDING' });
  
  if (!response?.success) {
    updateStatus('Failed to stop', 'red');
    return;
  }
  
  state.sampleEvents = response.events || [];
  state.sampleDuration = Date.now() - recordingStartTime;
  
  console.log('[Panel] Recorded:', state.sampleEvents.length, 'events');
  
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
  
  // Update sample info
  $('#sample-events').textContent = state.sampleEvents.length;
  $('#sample-duration').textContent = formatDuration(state.sampleDuration);
  
  // Load quality settings
  const quality = state.config?.sessionQuality || {};
  const weights = quality.weights || {};
  const qualityEnabled = quality.enabled !== false;
  
  $('#quality-enabled').checked = qualityEnabled;
  $('#threshold-critical').value = quality.thresholds?.critical || 80;
  $('#threshold-review').value = quality.thresholds?.review || 50;
  
  // Load detector weights
  $('#weight-jsError').value = weights.jsError ?? 40;
  $('#weight-networkError').value = weights.networkError ?? 40;
  $('#weight-rageClick').value = weights.rageClick ?? 25;
  $('#weight-deadClick').value = weights.deadClick ?? 10;
  $('#weight-formAbandonment').value = weights.formAbandonment ?? 20;
  $('#weight-validationLoop').value = weights.validationLoop ?? 15;
  
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
        formAbandonment: parseInt($('#weight-formAbandonment')?.value) || 20,
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
    
    // Include sample for reference (but not full events to save space)
    sample: {
      event_count: state.sampleEvents.length,
      duration_ms: state.sampleDuration,
      recorded_at: new Date().toISOString()
    }
  };
  
  console.log('[Panel] Saving config:', config.name);
  
  try {
    updateStatus('Saving...', 'yellow');
    
    const result = await api.saveConfig(config);
    console.log('[Panel] Config saved:', result);
    
    state.config = result.config || config;
    state.config.id = result.config?.id || result.id;
    
    showHasConfigView();
    updateStatus('Saved!', 'green');
  } catch (e) {
    console.error('[Panel] Failed to save config:', e);
    updateStatus('Save failed - check API', 'red');
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
  
  return `<!-- Recap Session Recording (ESM) -->
<!-- Auto-detects config from page URL, auto-starts recording -->
<script type="module" src="${apiUrl}/sdk/recap.js"></script>

<!-- Or with debug mode: -->
<!-- <script type="module" src="${apiUrl}/sdk/recap.js" data-debug="true"></script> -->

<!-- Or import manually: -->
<!--
<script type="module">
  import { RecapSDK } from '${apiUrl}/sdk/recap.js';
  RecapSDK.init({ debug: true });
</script>
-->`;
}

function generateConsoleScript() {
  const apiUrl = api.baseUrl;
  
  return `// Recap SDK - Console Quick Test (ESM)
// Dynamically imports SDK module and initializes with debug

import('${apiUrl}/sdk/recap.js').then(({ RecapSDK }) => {
  window.RecapSDK = RecapSDK;
  
  console.log('%c🎬 Recap SDK v' + RecapSDK.VERSION + ' loaded', 'color:#6366f1;font-weight:bold');
  console.log('API:', RecapSDK.API_BASE);
  console.log('');
  console.log('Commands:');
  console.log('  RecapSDK.init({ debug: true })  - Initialize with debug');
  console.log('  RecapSDK.isRecording()          - Check status');
  console.log('  RecapSDK.getEvents()            - Get events');
  console.log('  RecapSDK.getQuality()           - Get quality signals');
  console.log('  RecapSDK.stop()                 - Stop recording');
  console.log('');
  console.log('Auto-initializing with debug mode...');
  
  RecapSDK.init({ debug: true });
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
  
  // Don't reinit if we're configuring with sample data
  if (state.view === 'configure' && state.sampleEvents?.length > 0) {
    console.log('[Panel] Skipping init - configuring recorded session');
    return;
  }
  
  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    updateStatus('No active tab', 'red');
    return;
  }
  
  state.currentTabId = tab.id;
  state.currentUrl = tab.url;
  state.pageTitle = tab.title || '';
  
  $('#current-url').textContent = tab.url;
  
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
      console.log('[Panel] Config found:', config.name);
      updateStatus('Config found', 'green');
      showHasConfigView();
    } else {
      state.config = null;
      console.log('[Panel] No config for URL');
      updateStatus('No config', 'yellow');
      showView('no-config');
    }
  } catch (e) {
    console.warn('[Panel] API unavailable:', e.message);
    state.config = null;
    updateStatus('API offline', 'yellow');
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
  $('#btn-record-new').addEventListener('click', startRecording);
  $('#btn-record-update').addEventListener('click', startRecording);
  $('#btn-stop-recording').addEventListener('click', stopRecording);
  
  // Live event filters
  $$('.live-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.live-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.liveFilter = btn.dataset.filter;
      renderLiveEvents();
    });
  });
  
  // Configure
  $('#btn-cancel-configure').addEventListener('click', () => {
    if (state.config) {
      showHasConfigView();
    } else {
      showView('no-config');
    }
  });
  
  $('#btn-edit-config').addEventListener('click', () => {
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
    
    // Keep sample events if available
    state.sampleEvents = state.config?.sample?.events || [];
    state.sampleDuration = state.config?.sample?.duration || 0;
    
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
  
  // Quality toggle
  $('#quality-enabled').addEventListener('change', (e) => {
    toggleQualitySettings(e.target.checked);
  });
  
  // Sampling rate slider
  $('#sampling-rate').addEventListener('input', (e) => {
    $('#sampling-value').textContent = `${e.target.value}%`;
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
        $('#current-url').textContent = tab.url;
        
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
      $('#current-url').textContent = changeInfo.url;
      
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

/**
 * Recap - Main Application (ESM)
 * @version 3.0.0
 */

import { Log, $, $$, Toast, escapeHtml, formatTime, formatDuration, formatRelativeTime, UrlUtils } from './core.js';
import { Storage } from './storage.js';
import { Recorder, EventParser, FieldDetector } from './recorder.js';
import { Player, MaskingApplier } from './player.js';
import { ConfigManager, ConfigBuilder } from './config.js';

// ============================================================================
// STATE
// ============================================================================

const State = {
  currentUrl: '',
  currentPageTitle: '',
  currentConfig: null,
  editingConfig: null,
  detectedFields: [],
  sampleEvents: [],
  recordingTimer: null,
  allConfigs: [],
  allSessions: []
};

// ============================================================================
// VIEWS
// ============================================================================

const Views = {
  current: null,
  previous: null,

  show(viewId) {
    $$('.view').forEach(v => v.classList.add('hidden'));
    const view = $(`#view-${viewId}`);
    if (view) {
      view.classList.remove('hidden');
      this.previous = this.current;
      this.current = viewId;
      Log.debug('View:', viewId);
    }
  },

  back() {
    this.show(this.previous || 'no-config');
  }
};

// ============================================================================
// FIELDS UI
// ============================================================================

const FieldsUI = {
  currentFilter: 'all',

  render(fields, container) {
    if (!container) return;

    const filtered = this.filter(fields);

    if (!filtered.length) {
      container.innerHTML = `
        <div class="fields-empty">
          <p>No fields ${this.currentFilter !== 'all' ? `marked as ${this.currentFilter}` : 'detected'}</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map((f, i) => this.renderField(f, i)).join('');

    // Bind action changes
    container.querySelectorAll('.field-action-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const nodeId = parseInt(e.target.dataset.nodeId);
        const field = State.detectedFields.find(f => f.nodeId === nodeId);
        if (field) {
          field.action = e.target.value;
          field.source = 'user';
          this.render(State.detectedFields, container);
        }
      });
    });
  },

  renderField(field) {
    const sourceLabel = field.source === 'auto' ? '<span class="auto-badge">auto</span>' : '';
    
    // Show meaningful label based on element type
    let displayLabel = field.label || '';
    
    // For spans and text elements, prefer textContent
    if (!displayLabel && field.textContent) {
      displayLabel = field.textContent.slice(0, 40);
    }
    // Fallback to selector
    if (!displayLabel) {
      displayLabel = field.selector || 'Unknown Field';
    }
    
    // Icon based on tag type
    const icon = field.type === 'input' ? '⌨️' : 
                 field.tagName === 'button' ? '🔘' :
                 field.tagName === 'a' ? '🔗' :
                 field.tagName === 'span' ? '📝' : '🖱️';

    return `
      <div class="field-item ${field.action !== 'none' ? `field-${field.action}` : ''}" data-node-id="${field.nodeId}">
        <div class="field-header">
          <div class="field-info">
            <span class="field-icon">${icon}</span>
            <span class="field-label">${escapeHtml(displayLabel)}</span>
            ${sourceLabel}
          </div>
          <select class="field-action-select" data-node-id="${field.nodeId}">
            <option value="none" ${field.action === 'none' ? 'selected' : ''}>✅ Clear (no mask)</option>
            <option value="mask" ${field.action === 'mask' ? 'selected' : ''}>🔒 Mask</option>
            <option value="ignore" ${field.action === 'ignore' ? 'selected' : ''}>🚫 Ignore</option>
            ${field.type === 'click' ? `<option value="step" ${field.action === 'step' ? 'selected' : ''}>📍 Step</option>` : ''}
          </select>
        </div>
        <div class="field-details">
          <code class="field-selector">${escapeHtml(field.selector)}</code>
          ${field.tagName ? `<span class="field-tag">&lt;${field.tagName}&gt;</span>` : ''}
          ${field.isHidden ? `<span class="field-hidden">(${field.hiddenReason || 'hidden'})</span>` : ''}
        </div>
      </div>
    `;
  },

  filter(fields) {
    switch (this.currentFilter) {
      // Filter by action
      case 'masked': return fields.filter(f => f.action === 'mask');
      case 'clear': return fields.filter(f => f.action === 'none' && f.type === 'input');
      case 'ignored': return fields.filter(f => f.action === 'ignore');
      case 'steps': return fields.filter(f => f.action === 'step');
      // Filter by event type
      case 'input': return fields.filter(f => f.type === 'input');
      case 'click': return fields.filter(f => f.type === 'click');
      default: return fields;
    }
  },

  setFilter(filter, container) {
    this.currentFilter = filter;
    $$('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === filter));
    this.render(State.detectedFields, container);
  }
};

// ============================================================================
// APP
// ============================================================================

const App = {
  lastUrl: null,

  async init() {
    Log.info('Recap v3.0.0 - ESM Architecture');

    try {
      // Initialize storage
      await Storage.init();

      // Initialize recorder (sets up extension messaging if needed)
      await Recorder.init();

      // Get current URL
      await this.getCurrentUrl();
      this.lastUrl = State.currentUrl;

      // Check for existing config
      await this.checkConfig();

      // Setup event listeners
      this.setupEvents();

      // Setup URL change listeners
      this.setupUrlChangeListener();

      // Load data
      await this.loadData();

      Log.info('Initialized');
    } catch (e) {
      Log.error('Init failed:', e);
      Toast.error('Failed to initialize');
    }
  },

  // Listen for URL/tab changes
  setupUrlChangeListener() {
    if (typeof chrome === 'undefined' || !chrome.tabs) return;

    // Listen for tab activation (user switches tabs)
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      // Don't refresh if recording is in progress
      if (Recorder.isRecording) return;
      
      await this.refreshForCurrentTab();
    });

    // Listen for tab URL updates (navigation within same tab)
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      // Only react to URL changes on complete
      if (changeInfo.status !== 'complete') return;
      
      // Check if this is the active tab
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id !== tabId) return;
      } catch {
        return;
      }

      // Don't refresh if recording is in progress
      if (Recorder.isRecording) return;

      await this.refreshForCurrentTab();
    });

    Log.debug('URL change listener set up');
  },

  // Refresh sidepanel for current tab
  async refreshForCurrentTab() {
    await this.getCurrentUrl();
    
    // Only refresh if URL actually changed
    if (State.currentUrl === this.lastUrl) return;
    
    Log.debug('URL changed:', this.lastUrl, '→', State.currentUrl);
    this.lastUrl = State.currentUrl;

    // Clear editing state
    State.editingConfig = null;
    State.detectedFields = [];
    State.sampleEvents = [];
    this.liveEvents = [];

    // Update form name with new page title
    this.updateFormName();

    // Check for config at new URL
    await this.checkConfig();
    
    Toast.info('Page changed');
  },

  // Update form name input with current page title
  updateFormName() {
    const formNameInput = $('#form-name');
    if (!formNameInput) return;
    
    // Clean up page title for use as form name
    const cleanTitle = (State.currentPageTitle || '')
      .replace(/[\-\|–—].*$/, '')  // Remove suffix after separator
      .replace(/^\s+|\s+$/g, '')    // Trim
      .slice(0, 50);                 // Limit length
    
    formNameInput.value = cleanTitle || 'Form Configuration';
  },

  async getCurrentUrl() {
    // In extension context, get from active tab
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        State.currentUrl = tab?.url || window.location.href;
        State.currentPageTitle = tab?.title || document.title || '';
      } catch {
        State.currentUrl = window.location.href;
        State.currentPageTitle = document.title || '';
      }
    } else {
      // Browser testing mode
      State.currentUrl = window.location.href;
      State.currentPageTitle = document.title || '';
    }

    // Update URL display
    const urlDisplay = $('#current-url');
    if (urlDisplay) {
      urlDisplay.textContent = UrlUtils.getHostname(State.currentUrl) + UrlUtils.getPathname(State.currentUrl);
    }
    
    // Auto-fill form name with page title
    const formNameInput = $('#form-name');
    if (formNameInput && !formNameInput.value) {
      // Clean up page title for use as form name
      const cleanTitle = State.currentPageTitle
        .replace(/[\-\|–—].*$/, '')  // Remove suffix after separator
        .replace(/^\s+|\s+$/g, '')    // Trim
        .slice(0, 50);                 // Limit length
      formNameInput.value = cleanTitle || 'Form Configuration';
    }
    
    Log.debug('Current URL:', State.currentUrl);
    Log.debug('Page Title:', State.currentPageTitle);
  },

  async checkConfig() {
    Log.debug('Checking config for URL:', State.currentUrl);
    
    const config = await ConfigManager.loadForUrl(State.currentUrl);
    
    Log.debug('Found config:', config?.name || 'None');

    if (config) {
      State.currentConfig = config;
      this.showDashboard(config);
    } else {
      Views.show('no-config');
    }
  },

  async loadData() {
    State.allConfigs = await Storage.getConfigs();
    State.allSessions = await Storage.getSessions();

    // Update counts
    const configCount = $('#config-count');
    if (configCount) configCount.textContent = State.allConfigs.length;

    const menuConfigCount = $('#menu-config-count');
    if (menuConfigCount) menuConfigCount.textContent = State.allConfigs.length;

    const menuSessionCount = $('#menu-session-count');
    if (menuSessionCount) menuSessionCount.textContent = State.allSessions.length;
  },

  // ========================================
  // RECORDING
  // ========================================

  async startRecording() {
    const formName = $('#form-name')?.value.trim() || State.currentPageTitle || 'Form Configuration';

    State.editingConfig = {
      name: formName,
      url_pattern: UrlUtils.createPattern(State.currentUrl)  // Use full URL for pattern
    };
    
    Log.debug('Starting recording for:', formName, 'Pattern:', State.editingConfig.url_pattern);

    // Reset live events
    this.liveEvents = [];
    this.liveFilter = 'all';

    // Live event display (set before starting)
    Recorder.onEvent = (event) => this.updateLiveEvents(event);

    // Start rrweb recording (uses built-in features)
    const success = await Recorder.start();

    if (success) {
      Views.show('recording');
      this.startTimer();
      Toast.success('Recording started');
    } else {
      Toast.error('Failed to start recording. Make sure you are on a page.');
    }
  },

  async stopRecording() {
    Log.debug('Stopping recording...');
    const result = await Recorder.stop();
    this.stopTimer();

    Log.debug('Stop result:', result);
    Log.debug('Events count:', result?.events?.length);

    if (result && result.events && result.events.length > 0) {
      Log.info(`Recorded ${result.events.length} events, ${result.duration_ms}ms`);

      // Log event types for debugging
      const eventTypes = {};
      result.events.forEach(e => {
        eventTypes[e.type] = (eventTypes[e.type] || 0) + 1;
      });
      Log.debug('Event types:', eventTypes);

      // Extract and auto-detect fields using rrweb event data
      const fields = FieldDetector.processFields(result.events);

      Log.info(`Detected ${fields.length} fields`);

      State.detectedFields = fields;
      State.sampleEvents = result.events;

      State.editingConfig = {
        ...State.editingConfig,
        sample: { events: result.events, duration_ms: result.duration_ms }
      };

      this.showConfigureView();
      Toast.success(`${result.events.length} events, ${fields.length} fields detected`);
    } else {
      Log.warn('No events in result:', result);
      Toast.warning('No events recorded');
      Views.show('no-config');
    }
  },

  startTimer() {
    const timerEl = $('#recording-time');
    const startTime = Date.now();

    State.recordingTimer = setInterval(() => {
      timerEl.textContent = formatTime(Date.now() - startTime);
    }, 1000);
  },

  stopTimer() {
    if (State.recordingTimer) {
      clearInterval(State.recordingTimer);
      State.recordingTimer = null;
    }
  },

  liveEvents: [],
  liveFilter: 'all',

  updateLiveEvents(event) {
    const parsed = EventParser.parse(event);
    if (!parsed) return;
    
    // Only show form-related events and errors (filter out noise)
    const relevantTypes = ['input', 'click', 'focus', 'blur', 'snapshot', 'error', 'console.error', 'console.warn', 'navigation'];
    if (!relevantTypes.includes(parsed.name) && !relevantTypes.includes(parsed.type) && parsed.type !== 'snapshot') {
      return;
    }

    // Store event with parsed info
    this.liveEvents.unshift({
      ...parsed,
      timestamp: event.timestamp || Date.now()
    });

    // Keep only last 50 events
    if (this.liveEvents.length > 50) {
      this.liveEvents = this.liveEvents.slice(0, 50);
    }

    this.renderLiveEvents();
  },

  renderLiveEvents() {
    const container = $('#live-events');
    if (!container) return;

    // Filter events
    let filtered;
    if (this.liveFilter === 'all') {
      filtered = this.liveEvents;
    } else if (this.liveFilter === 'error') {
      // Show all error types
      filtered = this.liveEvents.filter(e => 
        e.type === 'error' || e.name?.includes('error') || e.name?.includes('warn')
      );
    } else {
      filtered = this.liveEvents.filter(e => e.name === this.liveFilter || e.type === this.liveFilter);
    }

    if (!filtered.length) {
      container.innerHTML = '<div class="fields-empty"><p>No events yet</p></div>';
      return;
    }

    // Render using field-item style (consistent with configure view)
    container.innerHTML = filtered.slice(0, 20).map(e => `
      <div class="field-item live-event-item" data-type="${e.name}">
        <div class="field-header">
          <div class="field-info">
            <span class="field-icon">${e.icon}</span>
            <span class="field-label">${escapeHtml(e.label || e.name)}</span>
          </div>
          <span class="field-tag">${e.name}</span>
        </div>
      </div>
    `).join('');
  },

  setLiveFilter(filter) {
    this.liveFilter = filter;
    $$('[data-live-filter]').forEach(t => t.classList.toggle('active', t.dataset.liveFilter === filter));
    this.renderLiveEvents();
  },

  // ========================================
  // CONFIGURATION
  // ========================================

  showConfigureView() {
    Views.show('configure');

    // Header info
    $('#configure-title').textContent = State.editingConfig?.name || 'New Config';
    $('#sample-duration').textContent = formatDuration(State.editingConfig?.sample?.duration_ms || 0);
    $('#sample-field-count').textContent = State.detectedFields.length;

    // Reset to first tab (Fields)
    $$('.config-tab').forEach(t => t.classList.remove('active'));
    $$('.config-tab-content').forEach(c => c.classList.add('hidden'));
    $('.config-tab[data-config-tab="fields"]')?.classList.add('active');
    $('#config-tab-fields')?.classList.remove('hidden');

    // Render fields list
    FieldsUI.render(State.detectedFields, $('#fields-list'));

    // Load settings from existing config
    const config = State.editingConfig || {};
    const sq = config.sessionQuality || {};
    const rb = config.reportButton || {};
    const settings = config.settings || {};
    
    // Quality tab values
    $('#quality-enabled').checked = sq.enabled !== false;
    $('#weight-jsError').value = sq.weights?.jsError ?? 40;
    $('#weight-networkError').value = sq.weights?.networkError ?? 40;
    $('#weight-rageClick').value = sq.weights?.rageClick ?? 25;
    $('#weight-formAbandonment').value = sq.weights?.formAbandonment ?? 20;
    $('#weight-validationLoop').value = sq.weights?.validationLoop ?? 15;
    $('#weight-deadClick').value = sq.weights?.deadClick ?? 10;
    $('#threshold-critical').value = sq.thresholds?.critical ?? 80;
    $('#threshold-review').value = sq.thresholds?.review ?? 50;
    
    // Apply quality enabled state
    const qualityBody = $('#quality-body');
    if (qualityBody) {
      qualityBody.classList.toggle('disabled', !$('#quality-enabled').checked);
    }
    
    // Settings tab values
    $('#report-enabled').checked = rb.enabled ?? false;
    $('#report-mode').value = rb.mode || 'on_error';
    $('#report-mode').disabled = !rb.enabled;
    $('#sampling-rate').value = settings.sampling_rate ?? 0.25;

    // Load completion selector
    const completionSel = State.editingConfig?.fields?.completion?.selector || 
                          sq.formTracking?.completionSelector || '';
    $('#completion-selector').value = completionSel;
  },

  async saveConfiguration() {
    try {
      const config = ConfigManager.createFromFields({
        name: State.editingConfig?.name,
        urlPattern: State.editingConfig?.url_pattern,
        detectedFields: State.detectedFields,
        sampleEvents: State.sampleEvents
      });

      // Get completion selector
      const completionSelector = $('#completion-selector')?.value.trim();
      if (completionSelector) {
        config.fields.completion = { selector: completionSelector };
      }

      // Get session quality settings from UI
      config.sessionQuality = {
        enabled: $('#quality-enabled')?.checked ?? true,
        weights: {
          jsError: parseInt($('#weight-jsError')?.value) || 40,
          networkError: parseInt($('#weight-networkError')?.value) || 40,
          rageClick: parseInt($('#weight-rageClick')?.value) || 25,
          formAbandonment: parseInt($('#weight-formAbandonment')?.value) || 20,
          validationLoop: parseInt($('#weight-validationLoop')?.value) || 15,
          deadClick: parseInt($('#weight-deadClick')?.value) || 10
        },
        thresholds: {
          critical: parseInt($('#threshold-critical')?.value) || 80,
          review: parseInt($('#threshold-review')?.value) || 50
        },
        formTracking: {
          minInteractions: 3,
          completionSelector: completionSelector || '[data-recap-complete]'
        }
      };

      // Get report button settings
      config.reportButton = {
        enabled: $('#report-enabled')?.checked ?? false,
        mode: $('#report-mode')?.value || 'on_error',
        position: 'bottom-right',
        showAfterScore: 40
      };

      // Get sampling rate
      config.settings = {
        ...config.settings,
        sampling_rate: parseFloat($('#sampling-rate')?.value) || 0.25
      };

      const saved = await ConfigManager.save(config);

      State.currentConfig = saved;
      State.editingConfig = null;
      State.detectedFields = [];
      State.sampleEvents = [];

      Toast.success('Configuration saved');
      this.showDashboard(saved);
      await this.loadData();

    } catch (e) {
      Log.error('Save failed:', e);
      Toast.error('Failed to save: ' + e.message);
    }
  },

  // ========================================
  // DASHBOARD
  // ========================================

  showDashboard(config) {
    Views.show('dashboard');

    $('#dashboard-config-name').textContent = config.name || 'Untitled';
    // PRIVACY-FIRST: Show "clear" count (unmasked fields), all others are masked by default
    $('#mask-count').textContent = config.fields?.clear?.length || 0;
    $('#ignore-count').textContent = config.fields?.ignored?.length || 0;
    $('#step-count').textContent = config.fields?.steps?.length || 0;

    this.loadStats(config.id);
    this.loadRecentSessions(config.id);
  },

  async loadStats(configId) {
    const stats = await Storage.getStats(configId);

    $('#stat-sessions').textContent = stats.total;
    $('#stat-complete').textContent = `${stats.completeRate}%`;
    $('#stat-errors').textContent = `${stats.errorRate}%`;
  },

  async loadRecentSessions(configId) {
    const sessions = await Storage.getSessions({ config_id: configId });
    const container = $('#recent-sessions-list');
    if (!container) return;

    if (!sessions.length) {
      container.innerHTML = '<p class="empty-hint">No sessions recorded yet</p>';
      return;
    }

    container.innerHTML = sessions.slice(0, 3).map(s => this.renderSessionItem(s)).join('');

    container.querySelectorAll('.btn-replay').forEach(btn => {
      btn.addEventListener('click', () => this.replaySession(btn.dataset.sessionId));
    });
  },

  renderSessionItem(session) {
    const icons = { complete: '✅', error: '❌', dropped: '⏸', timeout: '⏱' };
    const icon = icons[session.status] || '⚪';

    return `
      <div class="session-item" data-id="${session.id}">
        <div class="session-status">${icon}</div>
        <div class="session-info">
          <span class="session-id">#${session.id.slice(-6)}</span>
          <span class="session-meta">${formatDuration(session.duration_ms)} • ${formatRelativeTime(session.started_at)}</span>
        </div>
        <button class="btn btn-sm btn-replay" data-session-id="${session.id}">▶</button>
      </div>
    `;
  },

  // ========================================
  // REPLAY
  // ========================================

  async replaySession(sessionId) {
    const session = await Storage.getSession(sessionId);
    if (!session) {
      Toast.error('Session not found');
      return;
    }

    Views.show('replay');

    $('#replay-session-id').textContent = `#${sessionId.slice(-6)}`;
    $('#replay-status').textContent = session.status;
    $('#replay-duration').textContent = formatDuration(session.duration_ms);

    // Use rrweb-player with BUILT-IN controls
    Player.create($('#replay-container'), session.events, {
      autoPlay: true,
      showController: true  // Use rrweb-player's built-in controller
    });
  },

  previewSample() {
    if (!State.sampleEvents?.length) {
      Toast.warning('No sample recording');
      return;
    }

    // PRIVACY-FIRST: Get "clear" selectors (fields that should NOT be masked)
    const clear = State.detectedFields.filter(f => f.action === 'none' && f.type === 'input');
    const clearSelectors = clear.map(f => f.selector);
    
    // Apply masking: mask ALL inputs EXCEPT those in clear list
    const maskedEvents = MaskingApplier.applyPrivacyFirst(State.sampleEvents, clearSelectors);

    // Show modal with player
    const modal = $('#modal-replay');
    if (modal) {
      modal.classList.remove('hidden');
      
      // Wait for modal to render before creating player
      requestAnimationFrame(() => {
        setTimeout(() => {
          Player.create($('#modal-player-container'), maskedEvents, {
            autoPlay: true,
            showController: true
          });
        }, 50);
      });
    }
  },

  // ========================================
  // EVENT LISTENERS
  // ========================================

  setupEvents() {
    // Menu
    $('#btn-menu')?.addEventListener('click', () => Views.show('menu'));
    $('#btn-close-menu')?.addEventListener('click', () => Views.back());

    // Recording
    $('#btn-start-record')?.addEventListener('click', () => this.startRecording());
    $('#btn-stop-record')?.addEventListener('click', () => this.stopRecording());

    // Configure
    $('#btn-cancel-config')?.addEventListener('click', () => {
      State.detectedFields = [];
      State.sampleEvents = [];
      Views.show('no-config');
    });
    $('#btn-preview-sample')?.addEventListener('click', () => this.previewSample());
    $('#btn-save-config')?.addEventListener('click', () => this.saveConfiguration());

    // Configure view filter tabs
    $$('.filter-tab[data-filter]').forEach(tab => {
      tab.addEventListener('click', () => {
        FieldsUI.setFilter(tab.dataset.filter, $('#fields-list'));
      });
    });

    // Config main tabs (Fields / Quality / Settings)
    $$('.config-tab[data-config-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        // Update active tab
        $$('.config-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Show corresponding content
        $$('.config-tab-content').forEach(c => c.classList.add('hidden'));
        $(`#config-tab-${tab.dataset.configTab}`)?.classList.remove('hidden');
      });
    });

    // Quality toggle - enable/disable quality settings
    $('#quality-enabled')?.addEventListener('change', (e) => {
      const body = $('#quality-body');
      if (body) {
        body.classList.toggle('disabled', !e.target.checked);
      }
    });

    // Report button toggle
    $('#report-enabled')?.addEventListener('change', (e) => {
      const modeSelect = $('#report-mode');
      if (modeSelect) {
        modeSelect.disabled = !e.target.checked;
      }
    });

    // Live recording filter tabs
    $$('.filter-tab[data-live-filter]').forEach(tab => {
      tab.addEventListener('click', () => {
        this.setLiveFilter(tab.dataset.liveFilter);
      });
    });

    // Dashboard
    $('#btn-edit-config')?.addEventListener('click', () => {
      if (State.currentConfig) {
        State.editingConfig = { ...State.currentConfig };
        // PRIVACY-FIRST: "clear" fields have action 'none' (not masked)
        // All other inputs will be masked by default
        State.detectedFields = [
          ...(State.currentConfig.fields?.clear || []).map(f => ({ ...f, action: 'none', type: 'input' })),
          ...(State.currentConfig.fields?.ignored || []).map(f => ({ ...f, action: 'ignore' })),
          ...(State.currentConfig.fields?.steps || []).map(f => ({ ...f, action: 'step' }))
        ];
        State.sampleEvents = State.currentConfig.sample?.events || [];
        this.showConfigureView();
      }
    });

    $('#btn-rerecord')?.addEventListener('click', () => this.startRecording());
    $('#btn-export-config')?.addEventListener('click', () => this.exportConfig());
    $('#btn-export-embed')?.addEventListener('click', () => this.exportEmbedScript());
    $('#btn-view-sessions')?.addEventListener('click', () => this.showAllSessions());

    // Menu items
    $('#menu-configs')?.addEventListener('click', () => this.showAllConfigs());
    $('#menu-sessions')?.addEventListener('click', () => this.showAllSessions());
    $('#menu-settings')?.addEventListener('click', () => Views.show('settings'));

    // Back buttons
    $$('.btn-back').forEach(btn => {
      btn.addEventListener('click', () => Views.back());
    });

    // Modal close
    $$('.modal-close, .modal-backdrop').forEach(el => {
      el.addEventListener('click', () => {
        $$('.modal').forEach(m => m.classList.add('hidden'));
        Player.destroy();
      });
    });

    // Settings
    $('#btn-clear-all')?.addEventListener('click', async () => {
      if (confirm('Clear ALL data? This cannot be undone.')) {
        await Storage.clearAll();
        Toast.success('All data cleared');
        await this.loadData();
        State.currentConfig = null;
        Views.show('no-config');
      }
    });
  },

  showAllConfigs() {
    Views.show('configs');
    const container = $('#all-configs-list');
    if (!container) return;

    if (!State.allConfigs.length) {
      container.innerHTML = '<p class="empty-hint">No configurations yet</p>';
      return;
    }

    container.innerHTML = State.allConfigs.map(c => `
      <div class="config-item" data-id="${c.id}">
        <div class="config-header">
          <span class="config-name">${escapeHtml(c.name)}</span>
          <span class="config-time">${formatRelativeTime(c.updated_at)}</span>
        </div>
        <div class="config-pattern">${escapeHtml(c.url_pattern)}</div>
        <div class="config-meta">
          <span>✅ ${c.fields?.clear?.length || 0}</span>
          <span>🚫 ${c.fields?.ignored?.length || 0}</span>
          <span>📍 ${c.fields?.steps?.length || 0}</span>
        </div>
        <div class="config-actions">
          <button class="btn btn-sm btn-open" data-id="${c.id}">Open</button>
          <button class="btn btn-sm btn-danger btn-delete" data-id="${c.id}">🗑</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.btn-open').forEach(btn => {
      btn.addEventListener('click', async () => {
        const config = await Storage.getConfig(btn.dataset.id);
        if (config) {
          State.currentConfig = config;
          this.showDashboard(config);
        }
      });
    });

    container.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Delete this configuration?')) {
          await ConfigManager.delete(btn.dataset.id);
          await this.loadData();
          this.showAllConfigs();
          Toast.info('Configuration deleted');
        }
      });
    });
  },

  showAllSessions() {
    Views.show('sessions');
    const container = $('#all-sessions-list');
    if (!container) return;

    if (!State.allSessions.length) {
      container.innerHTML = '<p class="empty-hint">No sessions recorded yet</p>';
      return;
    }

    container.innerHTML = State.allSessions.map(s => {
      const config = State.allConfigs.find(c => c.id === s.config_id);
      const icons = { complete: '✅', error: '❌', dropped: '⏸' };

      return `
        <div class="session-item-full" data-id="${s.id}">
          <div class="session-status">${icons[s.status] || '⚪'}</div>
          <div class="session-details">
            <span class="session-id">#${s.id.slice(-6)}</span>
            <span class="session-config">${escapeHtml(config?.name || 'Unknown')}</span>
            <span class="session-meta">${formatDuration(s.duration_ms)} • ${formatRelativeTime(s.started_at)}</span>
          </div>
          <button class="btn btn-sm btn-replay" data-session-id="${s.id}">▶ Replay</button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-replay').forEach(btn => {
      btn.addEventListener('click', () => this.replaySession(btn.dataset.sessionId));
    });
  },

  exportConfig() {
    if (!State.currentConfig) return;

    const json = ConfigBuilder.export(State.currentConfig);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `recap-${State.currentConfig.name.replace(/\s+/g, '-')}.json`;
    a.click();

    URL.revokeObjectURL(url);
    Toast.success('Config exported');
  },

  /**
   * Export embed script for production
   */
  exportEmbedScript() {
    if (!State.currentConfig) {
      Toast.error('No configuration to export');
      return;
    }

    const config = State.currentConfig;
    
    // PRIVACY-FIRST: Extract field selectors
    const clearFields = config.fields?.clear || [];
    const ignoredFields = config.fields?.ignored || [];
    const stepFields = config.fields?.steps || [];
    const clearSelectors = clearFields.map(f => f.selector).filter(Boolean);
    const ignoreSelectors = ignoredFields.map(f => f.selector).filter(Boolean);
    const stepSelectors = stepFields.map(f => f.selector).filter(Boolean);
    
    // Build rrweb options
    const rrwebOptions = {
      maskAllInputs: true,
      maskInputOptions: { password: true },
      clearSelectors: clearSelectors,
      ignoreSelector: ignoreSelectors.length ? ignoreSelectors.join(',') : null,
      stepSelectors: stepSelectors,
      sampling: { mousemove: 50, scroll: 150, input: 'last' },
      slimDOMOptions: { script: true, comment: true },
      recordCanvas: false,
      collectFonts: false
    };

    // Generate Embed Script (for HTML pages)
    const embedScript = this._generateEmbedScript(config);
    
    // Generate Console Script (for browser DevTools)
    const consoleScript = this._generateConsoleScript(config, clearSelectors, ignoreSelectors, stepSelectors);

    // Show in modal with tabs
    const modal = $('#modal-export');
    if (modal) {
      modal.classList.remove('hidden');
      const content = modal.querySelector('.modal-body');
      if (content) {
        content.innerHTML = `
          <div class="export-tabs">
            <button class="export-tab active" data-tab="embed">📄 Embed Script</button>
            <button class="export-tab" data-tab="console">🖥️ Console Script</button>
          </div>
          
          <div id="tab-embed" class="export-content active">
            <div class="export-info">
              <p>Add to your HTML (replace YOUR_CDN with your server):</p>
              <button class="btn btn-primary btn-sm copy-btn" data-target="embed">📋 Copy</button>
            </div>
            <pre class="code-block"><code id="code-embed">${escapeHtml(embedScript)}</code></pre>
          </div>
          
          <div id="tab-console" class="export-content hidden">
            <div class="export-info">
              <p>Paste in DevTools Console to test:</p>
              <button class="btn btn-primary btn-sm copy-btn" data-target="console">📋 Copy</button>
            </div>
            <pre class="code-block"><code id="code-console">${escapeHtml(consoleScript)}</code></pre>
            <p class="export-hint">Commands: <code>recapStop()</code> <code>recapDownload()</code> <code>recapEvents</code></p>
          </div>
        `;
        
        // Tab switching
        content.querySelectorAll('.export-tab').forEach(tab => {
          tab.addEventListener('click', () => {
            content.querySelectorAll('.export-tab').forEach(t => t.classList.remove('active'));
            content.querySelectorAll('.export-content').forEach(c => c.classList.add('hidden'));
            tab.classList.add('active');
            content.querySelector(`#tab-${tab.dataset.tab}`)?.classList.remove('hidden');
          });
        });
        
        // Copy buttons
        content.querySelectorAll('.copy-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const target = btn.dataset.target;
            const code = target === 'embed' ? embedScript : consoleScript;
            navigator.clipboard.writeText(code).then(() => {
              Toast.success('Copied to clipboard!');
            }).catch(() => {
              Toast.error('Copy failed');
            });
          });
        });
      }
    }
  },

  /**
   * Generate embed script for HTML pages
   * For production: uses configUrl (deployed to your server)
   */
  _generateEmbedScript(config) {
    const configId = config.id;
    const sq = config.sessionQuality || {};
    const rb = config.reportButton || {};
    const samplingRate = config.settings?.sampling_rate ?? 0.25;
    
    // Build session quality config from saved values
    const qualityConfig = sq.enabled !== false ? `
    // Session Quality Detection
    sessionQuality: {
      enabled: true,
      weights: {
        jsError: ${sq.weights?.jsError ?? 40},
        networkError: ${sq.weights?.networkError ?? 40},
        rageClick: ${sq.weights?.rageClick ?? 25},
        formAbandonment: ${sq.weights?.formAbandonment ?? 20},
        validationLoop: ${sq.weights?.validationLoop ?? 15},
        deadClick: ${sq.weights?.deadClick ?? 10}
      },
      thresholds: {
        critical: ${sq.thresholds?.critical ?? 80},
        review: ${sq.thresholds?.review ?? 50}
      },
      onCritical: (report) => console.warn('Critical session:', report)
    },` : `
    // Session Quality Detection (disabled)
    sessionQuality: { enabled: false },`;

    const reportConfig = rb.enabled ? `
    // Report Button
    reportButton: {
      enabled: true,
      mode: '${rb.mode || 'on_error'}',
      position: '${rb.position || 'bottom-right'}'
    },` : '';
    
    return `<!-- Recap Session Recording (Privacy-First) -->
<!-- Config: ${config.name} | Sampling: ${samplingRate * 100}% -->
<script type="module">
  // SDK from your CDN
  import { RecapSDK } from 'https://YOUR_CDN/recap-sdk.js';
  
  // Initialize with Cloudflare Worker API
  RecapSDK.init({
    // API endpoint (Cloudflare Worker)
    apiBase: 'https://recap-api.YOUR_DOMAIN.workers.dev',
    configId: '${configId}',
    ${qualityConfig}${reportConfig}
    // Sampling: ${samplingRate * 100}% of sessions
    samplingRate: ${samplingRate}
  });
<\/script>`;
  },

  /**
   * Generate console script for testing
   * PRIVACY-FIRST: maskAllInputs + clearSelectors for selective unmasking
   */
  _generateConsoleScript(config, clearSelectors, ignoreSelectors, stepSelectors) {
    const extId = typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome.runtime.id : 'EXTENSION_ID';
    const fileName = (config.name || 'recording').replace(/\s+/g, '-');
    const sq = config.sessionQuality || {};
    
    // PRIVACY-FIRST config with session quality from saved values
    const inlineConfig = {
      name: config.name,
      fields: {
        clear: clearSelectors.map(s => ({ selector: s })),
        ignored: ignoreSelectors.map(s => ({ selector: s })),
        steps: stepSelectors.map(s => ({ selector: s }))
      },
      rrweb_options: {
        maskAllInputs: true,
        clearSelectors: clearSelectors,
        stepSelectors: stepSelectors,
        ignoreSelector: ignoreSelectors.length ? ignoreSelectors.join(',') : null
      },
      sessionQuality: {
        enabled: sq.enabled !== false,
        weights: {
          jsError: sq.weights?.jsError ?? 40,
          networkError: sq.weights?.networkError ?? 40,
          rageClick: sq.weights?.rageClick ?? 25,
          formAbandonment: sq.weights?.formAbandonment ?? 20,
          validationLoop: sq.weights?.validationLoop ?? 15,
          deadClick: sq.weights?.deadClick ?? 10
        },
        thresholds: {
          critical: sq.thresholds?.critical ?? 80,
          review: sq.thresholds?.review ?? 50
        }
      },
      reportButton: config.reportButton || { enabled: false }
    };
    
    return `// Recap Console Test Script
// Config: ${config.name}
// Quality Detection: ${sq.enabled !== false ? 'ON' : 'OFF'}
(async()=>{
  // Load Recap SDK
  const s=document.createElement('script');
  s.src='chrome-extension://${extId}/lib/sdk/index.js';
  s.type='module';
  document.head.appendChild(s);
  await new Promise(r=>s.onload=r);
  
  // Initialize
  await RecapSDK.init({
    config: ${JSON.stringify(inlineConfig, null, 2)},
    debug: true,
    testMode: true
  });
  
  RecapSDK.start();
  console.log('%c🔴 Recording Started','color:red;font-weight:bold');
  console.log('Quality Detection: ${sq.enabled !== false ? 'ENABLED' : 'DISABLED'}');
  
  // Helper commands
  window.recapStop = () => {
    RecapSDK.stop();
    console.log('%c⏹ Recording Stopped','color:orange;font-weight:bold');
    console.table(RecapSDK.getQualityReport());
  };
  window.recapDownload = () => {
    const data = { 
      config: '${config.name}',
      events: RecapSDK.getEvents(), 
      quality: RecapSDK.getQualityReport(),
      exportedAt: new Date().toISOString()
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)]));
    a.download = '${fileName}-' + Date.now() + '.json';
    a.click();
    console.log('Downloaded:', a.download);
  };
  window.recapScore = () => {
    const score = RecapSDK.getQualityScore();
    const severity = RecapSDK.getQualitySeverity();
    console.log('%cQuality Score: ' + score + ' (' + severity + ')', 
      'color:' + (severity === 'critical' ? 'red' : severity === 'review' ? 'orange' : 'green') + ';font-weight:bold');
  };
  
  console.log('%cCommands: recapStop() | recapDownload() | recapScore()','color:gray');
})()`;
  }
};

// ============================================================================
// BOOTSTRAP
// ============================================================================

document.addEventListener('DOMContentLoaded', () => App.init());

// Export for debugging
window.RecapApp = App;
window.RecapState = State;


/**
 * Recap SDK v3.1.0
 * Unified SDK for Extension (testMode) and Production
 * 
 * @example Extension usage:
 * RecapSDK.init({ testMode: true, debug: true });
 * RecapSDK.start();
 * // ... user interacts ...
 * RecapSDK.stop();
 * const events = RecapSDK.getEvents();
 * 
 * @example Production usage:
 * RecapSDK.init({ 
 *   configUrl: '/api/configs/my-form',
 *   endpoint: '/api/recordings'
 * });
 * // Auto-starts and uploads
 */

import { RecapPlayer } from './player/player.js';

const VERSION = '3.1.0';
const RRWEB_CDN = 'https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.17/dist/rrweb.min.js';

// ============================================================================
// State
// ============================================================================

const state = {
  initialized: false,
  recording: false,
  testMode: false,
  debug: false,
  
  sessionId: null,
  startTime: null,
  events: [],
  
  config: null,
  endpoint: null,
  
  quality: {
    score: 0,
    signals: {
      jsErrors: 0,
      networkErrors: 0,
      rageClicks: 0,
      deadClicks: 0,
      validationLoops: 0,
      formAbandoned: false
    }
  }
};

let stopFn = null;

// ============================================================================
// Logging
// ============================================================================

const log = (...args) => {
  if (state.debug) console.log('%c[Recap]', 'color: #6366f1; font-weight: bold', ...args);
};

const warn = (...args) => console.warn('[Recap]', ...args);
const error = (...args) => console.error('[Recap]', ...args);

// ============================================================================
// Loader
// ============================================================================

async function loadRrweb() {
  if (typeof rrweb !== 'undefined' && typeof rrweb.record === 'function') {
    log('rrweb already loaded');
    return true;
  }
  
  log('Loading rrweb from CDN...');
  
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = RRWEB_CDN;
    script.onload = () => {
      log('rrweb loaded successfully');
      resolve(true);
    };
    script.onerror = () => {
      error('Failed to load rrweb');
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

// ============================================================================
// Quality Detection
// ============================================================================

const qualityDetectors = {
  abortController: null,
  
  start() {
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    
    // JS Errors
    window.addEventListener('error', this.handleJsError, { signal });
    window.addEventListener('unhandledrejection', this.handleRejection, { signal });
    
    // Rage clicks
    document.addEventListener('click', this.handleClick, { signal, capture: true });
    
    log('Quality detectors started');
  },
  
  stop() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      log('Quality detectors stopped');
    }
  },
  
  handleJsError(e) {
    if (!e.filename || e.filename.includes('extension://')) return;
    state.quality.signals.jsErrors++;
    RecapSDK._recalculateScore();
    log('JS Error detected:', e.message);
  },
  
  handleRejection(e) {
    state.quality.signals.jsErrors++;
    RecapSDK._recalculateScore();
    log('Unhandled rejection:', e.reason?.message || e.reason);
  },
  
  clickHistory: [],
  handleClick(e) {
    const now = Date.now();
    const { clientX: x, clientY: y } = e;
    
    // Track click history for rage detection
    qualityDetectors.clickHistory.push({ x, y, time: now });
    
    // Keep last 1 second of clicks
    qualityDetectors.clickHistory = qualityDetectors.clickHistory.filter(
      c => now - c.time < 1000
    );
    
    // Rage click: 3+ clicks in 50px radius within 1 second
    if (qualityDetectors.clickHistory.length >= 3) {
      const first = qualityDetectors.clickHistory[0];
      const allClose = qualityDetectors.clickHistory.every(
        c => Math.abs(c.x - first.x) < 50 && Math.abs(c.y - first.y) < 50
      );
      
      if (allClose) {
        state.quality.signals.rageClicks++;
        qualityDetectors.clickHistory = [];
        RecapSDK._recalculateScore();
        log('Rage click detected!');
      }
    }
    
    // Dead click detection
    const target = e.target;
    if (target.matches('img:not([onclick]), span:not([onclick]):not([role="button"]), div.banner')) {
      if (!target.closest('a, button, [onclick], [role="button"]')) {
        state.quality.signals.deadClicks++;
        RecapSDK._recalculateScore();
        log('Dead click detected on:', target.tagName);
      }
    }
  }
};

// ============================================================================
// Recording
// ============================================================================

function buildRrwebOptions(config = {}) {
  const clearSelectors = config.fields?.clear?.map(f => f.selector) || [];
  
  return {
    emit: (event) => {
      state.events.push(event);
      
      // In production mode, batch and send
      if (!state.testMode && state.events.length % 50 === 0) {
        RecapSDK._flush();
      }
    },
    
    // Privacy-first: mask all by default
    maskAllInputs: true,
    maskInputOptions: { password: true },
    
    // Custom mask function: unmask only "clear" fields
    maskInputFn: (text, element) => {
      if (element?.type === 'password') return '••••••••';
      
      // Check if element should be clear (not masked)
      if (clearSelectors.length > 0 && element) {
        const shouldClear = clearSelectors.some(sel => {
          try { return element.matches(sel); } catch { return false; }
        });
        if (shouldClear) return text;
      }
      
      return '••••••••';
    },
    
    // Ignore selectors
    ignoreSelector: config.fields?.ignored?.map(f => f.selector).join(',') || null,
    
    // Performance
    sampling: config.rrweb_options?.sampling || { 
      mousemove: 50, 
      scroll: 150, 
      input: 'last' 
    },
    slimDOMOptions: { script: true, comment: true },
    checkoutEveryNms: 10000,
    
    // Disable heavy features
    recordCanvas: false,
    collectFonts: false,
    inlineStylesheet: true
  };
}

// ============================================================================
// API
// ============================================================================

async function fetchConfig(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    warn('Failed to fetch config:', e.message);
    return null;
  }
}

async function sendRecording(endpoint, data) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      keepalive: true
    });
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log('Recording sent successfully');
    return true;
  } catch (e) {
    error('Failed to send recording:', e.message);
    return false;
  }
}

// ============================================================================
// Public API
// ============================================================================

export const RecapSDK = {
  VERSION,
  
  /**
   * Initialize the SDK
   * @param {Object} options
   * @param {boolean} options.testMode - Extension mode (no auto-upload)
   * @param {boolean} options.debug - Enable debug logs
   * @param {string} options.configUrl - URL to fetch config
   * @param {string} options.endpoint - API endpoint for recordings
   * @param {Object} options.config - Inline config object
   */
  async init(options = {}) {
    if (state.initialized) {
      warn('Already initialized');
      return;
    }
    
    state.testMode = options.testMode ?? false;
    state.debug = options.debug ?? false;
    state.endpoint = options.endpoint || null;
    
    log(`Initializing v${VERSION}`, { testMode: state.testMode });
    
    // Load rrweb
    const loaded = await loadRrweb();
    if (!loaded) {
      error('Failed to load rrweb - cannot initialize');
      return;
    }
    
    // Load config
    if (options.configUrl) {
      state.config = await fetchConfig(options.configUrl);
    } else if (options.config) {
      state.config = options.config;
    }
    
    state.initialized = true;
    log('Initialized successfully');
    
    // Auto-start in production mode
    if (!state.testMode && state.config) {
      this.start();
    }
  },
  
  /**
   * Start recording
   * @param {Object} config - Optional config override
   */
  start(config = null) {
    if (!state.initialized) {
      warn('Not initialized');
      return false;
    }
    
    if (state.recording) {
      warn('Already recording');
      return false;
    }
    
    // Use provided config or stored config
    const activeConfig = config || state.config || {};
    state.config = activeConfig;
    
    // Generate session ID
    state.sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    state.startTime = Date.now();
    state.events = [];
    state.quality = {
      score: 0,
      signals: {
        jsErrors: 0,
        networkErrors: 0,
        rageClicks: 0,
        deadClicks: 0,
        validationLoops: 0,
        formAbandoned: false
      }
    };
    
    log('Starting recording:', state.sessionId);
    
    // Build rrweb options
    const rrwebOptions = buildRrwebOptions(activeConfig);
    
    // Start rrweb recording
    stopFn = rrweb.record(rrwebOptions);
    
    // Start quality detectors
    if (activeConfig.sessionQuality?.enabled !== false) {
      qualityDetectors.start();
    }
    
    state.recording = true;
    log('Recording started');
    
    return true;
  },
  
  /**
   * Stop recording
   * @returns {Object} Recording summary
   */
  stop() {
    if (!state.recording) {
      warn('Not recording');
      return null;
    }
    
    log('Stopping recording...');
    
    // Stop rrweb
    if (stopFn) {
      stopFn();
      stopFn = null;
    }
    
    // Stop quality detectors
    qualityDetectors.stop();
    
    state.recording = false;
    
    const summary = {
      sessionId: state.sessionId,
      eventCount: state.events.length,
      duration: Date.now() - state.startTime,
      quality: { ...state.quality }
    };
    
    log('Recording stopped:', summary);
    
    // In production mode, send final recording
    if (!state.testMode && state.endpoint) {
      this._flush(true);
    }
    
    return summary;
  },
  
  /**
   * Check if currently recording
   */
  isRecording() {
    return state.recording;
  },
  
  /**
   * Get session ID
   */
  getSessionId() {
    return state.sessionId;
  },
  
  /**
   * Get recorded events (testMode only)
   */
  getEvents() {
    if (!state.testMode) {
      warn('getEvents() only available in testMode');
      return [];
    }
    return [...state.events];
  },
  
  /**
   * Get quality score
   */
  getQualityScore() {
    return state.quality.score;
  },
  
  /**
   * Get quality severity
   */
  getQualitySeverity() {
    const score = state.quality.score;
    const thresholds = state.config?.sessionQuality?.thresholds || { critical: 80, review: 50 };
    
    if (score >= thresholds.critical) return 'critical';
    if (score >= thresholds.review) return 'review';
    return 'normal';
  },
  
  /**
   * Get full quality report
   */
  getQualityReport() {
    return {
      score: state.quality.score,
      severity: this.getQualitySeverity(),
      signals: { ...state.quality.signals },
      thresholds: state.config?.sessionQuality?.thresholds || { critical: 80, review: 50 }
    };
  },
  
  /**
   * Get current config
   */
  getConfig() {
    return state.config;
  },
  
  /**
   * Add custom event
   */
  addCustomEvent(tag, payload) {
    if (!state.recording) {
      warn('Not recording');
      return;
    }
    
    if (typeof rrweb?.record?.addCustomEvent === 'function') {
      rrweb.record.addCustomEvent(tag, payload);
      log('Custom event:', tag, payload);
    }
  },
  
  /**
   * Reset state (for testing)
   */
  reset() {
    this.stop();
    state.initialized = false;
    state.config = null;
    state.events = [];
    log('SDK reset');
  },
  
  // ============================================================================
  // Internal Methods
  // ============================================================================
  
  _recalculateScore() {
    const weights = state.config?.sessionQuality?.weights || {
      jsError: 40,
      networkError: 40,
      rageClick: 25,
      formAbandonment: 20,
      validationLoop: 15,
      deadClick: 10
    };
    
    const signals = state.quality.signals;
    
    state.quality.score = 
      (signals.jsErrors || 0) * weights.jsError +
      (signals.networkErrors || 0) * weights.networkError +
      (signals.rageClicks || 0) * weights.rageClick +
      (signals.deadClicks || 0) * weights.deadClick +
      (signals.validationLoops || 0) * weights.validationLoop +
      (signals.formAbandoned ? weights.formAbandonment : 0);
    
    log('Quality score:', state.quality.score);
  },
  
  async _flush(final = false) {
    if (!state.endpoint || state.events.length === 0) return;
    
    const payload = {
      session_id: state.sessionId,
      config_id: state.config?.id,
      form_name: state.config?.name,
      events: state.events,
      duration_ms: Date.now() - state.startTime,
      quality: state.quality,
      metadata: {
        url: location.href,
        user_agent: navigator.userAgent,
        sdk_version: VERSION
      }
    };
    
    if (final) {
      // Clear events after final flush
      state.events = [];
    }
    
    await sendRecording(state.endpoint, payload);
  }
};

// ============================================================================
// Export Player
// ============================================================================

export { RecapPlayer };

// ============================================================================
// Auto-init from script attributes
// ============================================================================

if (typeof document !== 'undefined') {
  const script = document.currentScript;
  if (script && script.dataset.config) {
    const configUrl = script.dataset.config;
    const endpoint = script.dataset.endpoint;
    
    RecapSDK.init({ configUrl, endpoint });
  }
}

// Global export
if (typeof window !== 'undefined') {
  window.RecapSDK = RecapSDK;
  window.RecapPlayer = RecapPlayer;
}

export default RecapSDK;

/**
 * Recap SDK v3.0.0
 * Production-ready session recording with quality detection
 * 
 * @example
 * // Auto-init via script tag
 * <script src="recap-sdk.js" 
 *         data-config="/api/config.json"
 *         data-endpoint="/api/sessions"></script>
 * 
 * @example
 * // Manual init
 * RecapSDK.init({
 *   configUrl: '/api/config.json',
 *   endpoint: '/api/sessions',
 *   debug: true
 * });
 * 
 * @module RecapSDK
 */

import { State } from './core/state.js';
import { Logger } from './core/logger.js';
import { defaults } from './core/config.js';
import { Recording } from './recording/recorder.js';
import { Session } from './recording/session.js';
import { Transport } from './recording/transport.js';
import { SessionQuality } from './quality/index.js';
import { ReportButton } from './quality/report-button.js';

/** SDK Version */
const VERSION = '3.0.0';

/** @type {boolean} Whether SDK is initialized */
let initialized = false;

/** @type {Object} Current options */
let options = {};

/**
 * Generate unique session ID
 * @returns {string} Session ID
 */
function generateSessionId() {
  return 'sess_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * Check if session should be sampled
 * @param {number} rate - Sampling rate (0-1)
 * @returns {boolean} Whether to sample
 */
function shouldSample(rate = 1) {
  return Math.random() < rate;
}

/**
 * Load rrweb dynamically
 * @param {string} url - rrweb CDN URL
 * @returns {Promise<boolean>} Success
 */
async function loadRrweb(url) {
  if (typeof rrweb !== 'undefined' && typeof rrweb.record === 'function') {
    Logger.debug('rrweb already loaded');
    return true;
  }
  
  Logger.debug('Loading rrweb from:', url);
  
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => {
      Logger.debug('rrweb loaded successfully');
      resolve(true);
    };
    script.onerror = () => {
      Logger.error('Failed to load rrweb');
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

/**
 * Match URL against pattern
 * @param {string} pattern - URL pattern
 * @returns {boolean} Whether URL matches
 */
function matchesPattern(pattern) {
  if (!pattern || pattern === '*') return true;
  
  const path = location.pathname;
  
  // Convert pattern to regex
  const regex = new RegExp(
    '^' + pattern
      .replace(/:\w+/g, '[^/]+')  // :param placeholders
      .replace(/\*/g, '.*')       // Wildcards
      .replace(/\//g, '\\/')      // Escape slashes
    + '$',
    'i'
  );
  
  return regex.test(path);
}

/**
 * Recap SDK
 */
export const RecapSDK = {
  VERSION,
  
  /**
   * Initialize SDK
   * @param {Object} opts - SDK options
   * @returns {Promise<void>}
   */
  async init(opts = {}) {
    // Handle reinit for testing
    if (opts.testMode && initialized) {
      Logger.debug('Reinitializing for test mode');
      this.stop();
      State.reset();
      initialized = false;
    }
    
    if (initialized) {
      Logger.warn('SDK already initialized');
      return;
    }
    
    options = { ...defaults, ...opts };
    Logger.setDebug(options.debug);
    
    Logger.info('Recap SDK v' + VERSION + ' initializing...');
    
    try {
      // Load rrweb
      const rrwebLoaded = await loadRrweb(options.rrwebUrl);
      if (!rrwebLoaded) {
        throw new Error('Failed to load rrweb');
      }
      
      // Check for session to resume (cross-page)
      const savedSession = Session.load();
      if (savedSession?.recording && options.crossPage !== false) {
        Logger.info('Resuming session:', savedSession.sessionId);
        
        State.update({
          initialized: true,
          sessionId: savedSession.sessionId,
          config: savedSession.config,
          startTime: savedSession.startTime,
          quality: savedSession.quality || State.get().quality
        });
        
        initialized = true;
        
        // Start recording
        await this._startRecording();
        
        return;
      }
      
      // Load configuration
      let config = null;
      
      if (options.configUrl) {
        Logger.debug('Fetching config from:', options.configUrl);
        const response = await fetch(options.configUrl);
        if (!response.ok) {
          throw new Error(`Config fetch failed: ${response.status}`);
        }
        config = await response.json();
        Logger.debug('Config loaded:', config.name || config.form?.name);
      } else if (options.config) {
        config = options.config;
        Logger.debug('Using inline config');
      } else {
        config = {};
        Logger.debug('No config provided, using defaults');
      }
      
      State.update({ config });
      
      // Check sampling rate (skip in test mode)
      if (!options.testMode) {
        const samplingRate = config.sampling_rate ?? config.settings?.sampling_rate ?? 1;
        if (!shouldSample(samplingRate)) {
          Logger.debug('Session not sampled (rate:', samplingRate + ')');
          return;
        }
        
        // Check URL pattern
        const urlPattern = config.url_pattern || config.form?.path_pattern;
        if (urlPattern && !matchesPattern(urlPattern)) {
          Logger.debug('URL does not match pattern:', urlPattern);
          return;
        }
      }
      
      // Initialize state
      State.update({
        initialized: true,
        sessionId: generateSessionId(),
        startTime: Date.now()
      });
      
      initialized = true;
      Logger.info('SDK initialized, session:', State.getPath('sessionId'));
      
      // Call onReady callback
      if (options.onReady) {
        try {
          options.onReady();
        } catch (e) {
          Logger.error('onReady callback error:', e);
        }
      }
      
      // Start recording (unless test mode)
      if (!options.testMode) {
        await this._startRecording();
      } else {
        Logger.debug('Test mode - waiting for manual start()');
      }
      
    } catch (e) {
      Logger.error('SDK init failed:', e);
      if (options.onError) {
        options.onError(e);
      }
    }
  },
  
  /**
   * Start recording
   * @returns {boolean} Success
   */
  start() {
    if (!initialized) {
      Logger.warn('SDK not initialized');
      return false;
    }
    
    if (State.getPath('recording')) {
      Logger.warn('Already recording');
      return false;
    }
    
    return this._startRecording();
  },
  
  /**
   * Stop recording
   */
  stop() {
    if (!State.getPath('recording')) {
      return;
    }
    
    Logger.info('Stopping recording...');
    
    // Stop recording
    Recording.stop();
    
    // Stop quality detection
    SessionQuality.stop();
    
    // Stop report button
    ReportButton.destroy();
    
    // Final flush
    Transport.stop();
    
    // Clear session
    Session.clear();
    
    State.update({ recording: false });
    
    Logger.info('Recording stopped');
  },
  
  /**
   * Internal: Start recording with all features
   * @private
   * @returns {boolean} Success
   */
  _startRecording() {
    const config = State.getPath('config') || {};
    const rrwebOptions = config.rrweb_options || {};
    
    // Build clear selectors (fields NOT to mask)
    const clearSelectors = (config.fields?.clear || [])
      .map(f => f.selector)
      .filter(Boolean);
    
    // Build ignore selectors
    const ignoreSelectors = (config.fields?.ignored || [])
      .map(f => f.selector)
      .filter(Boolean);
    
    // Build step selectors
    const stepSelectors = (config.fields?.steps || [])
      .map(f => f.selector)
      .filter(Boolean);
    
    // Initialize transport
    Transport.init({
      endpoint: options.endpoint,
      batchSize: options.batchSize,
      flushInterval: options.flushInterval
    });
    
    // Start recording
    const started = Recording.start({
      clearSelectors,
      ignoreSelector: ignoreSelectors.length ? ignoreSelectors.join(', ') : null,
      stepSelectors,
      ...rrwebOptions,
      onEvent: (event) => {
        Transport.queue(event);
        
        // For test mode, post to window
        if (options.testMode) {
          window.postMessage({
            source: 'recap-sdk',
            type: 'RRWEB_EVENT',
            payload: { event, eventCount: State.get().events.length }
          }, '*');
        }
      }
    });
    
    if (!started) {
      return false;
    }
    
    State.update({ recording: true });
    
    // Setup session persistence for cross-page
    if (options.crossPage !== false) {
      Session.setupUnloadHandlers(() => Transport.flushAll());
    }
    
    // Start quality detection
    if (options.sessionQuality?.enabled !== false) {
      SessionQuality.start({
        weights: options.sessionQuality?.weights,
        thresholds: options.sessionQuality?.thresholds,
        rageClick: options.sessionQuality?.rageClick,
        deadClick: options.sessionQuality?.deadClick,
        validationLoop: options.sessionQuality?.validationLoop,
        formTracking: options.sessionQuality?.formTracking,
        onScoreChange: options.sessionQuality?.onScoreChange,
        onCritical: options.sessionQuality?.onCritical
      });
    }
    
    // Initialize report button
    if (options.reportButton?.enabled) {
      ReportButton.init({
        mode: options.reportButton.mode,
        position: options.reportButton.position,
        showAfterScore: options.reportButton.showAfterScore,
        categories: options.reportButton.categories,
        allowComment: options.reportButton.allowComment,
        onReport: options.reportButton.onReport
      });
    }
    
    Logger.info('Recording started');
    return true;
  },
  
  // ============================================================================
  // PUBLIC API
  // ============================================================================
  
  /**
   * Check if recording
   * @returns {boolean}
   */
  isRecording() {
    return State.getPath('recording') || false;
  },
  
  /**
   * Get session ID
   * @returns {string|null}
   */
  getSessionId() {
    return State.getPath('sessionId');
  },
  
  /**
   * Get recorded events
   * @returns {Array}
   */
  getEvents() {
    return [...(State.getPath('events') || [])];
  },
  
  /**
   * Get current configuration
   * @returns {Object}
   */
  getConfig() {
    return State.getPath('config') || {};
  },
  
  /**
   * Flush events to server
   * @returns {Promise<boolean>}
   */
  async flush() {
    return Transport.flush();
  },
  
  /**
   * Add custom rrweb event
   * @param {string} tag - Event tag
   * @param {*} payload - Event payload
   */
  addCustomEvent(tag, payload) {
    if (!State.getPath('recording')) {
      Logger.warn('Not recording - cannot add custom event');
      return;
    }
    
    if (typeof rrweb?.record?.addCustomEvent === 'function') {
      rrweb.record.addCustomEvent(tag, payload);
      Logger.debug('Custom event added:', tag);
    }
  },
  
  /**
   * Mark form as completed (for abandonment tracking)
   */
  markFormCompleted() {
    SessionQuality.markFormCompleted();
  },
  
  // ============================================================================
  // QUALITY API
  // ============================================================================
  
  /**
   * Get quality score
   * @returns {number}
   */
  getQualityScore() {
    return SessionQuality.getScore();
  },
  
  /**
   * Get quality severity
   * @returns {'normal'|'review'|'critical'}
   */
  getQualitySeverity() {
    return SessionQuality.getSeverity();
  },
  
  /**
   * Get quality signals
   * @returns {Object}
   */
  getQualitySignals() {
    return SessionQuality.getSignals();
  },
  
  /**
   * Get full quality report
   * @returns {Object}
   */
  getQualityReport() {
    return SessionQuality.getReport();
  },
  
  /**
   * Show report button manually
   */
  showReportButton() {
    ReportButton.show();
  }
};

// ============================================================================
// AUTO-INITIALIZATION
// ============================================================================

// Auto-init from script tag attributes
if (typeof document !== 'undefined') {
  const currentScript = document.currentScript;
  
  if (currentScript) {
    const configUrl = currentScript.dataset.config;
    const endpoint = currentScript.dataset.endpoint;
    const debug = currentScript.dataset.debug === 'true';
    
    if (configUrl || endpoint) {
      Logger.debug('Auto-initializing from script attributes');
      RecapSDK.init({ configUrl, endpoint, debug });
    }
  }
}

// Listen for extension test messages
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'recap-extension') return;
    
    const { type, payload } = event.data;
    
    switch (type) {
      case 'SDK_INIT':
        RecapSDK.init({ ...payload, testMode: true });
        break;
      case 'SDK_START':
        RecapSDK.start();
        break;
      case 'SDK_STOP':
        RecapSDK.stop();
        break;
      case 'SDK_GET_STATUS':
        window.postMessage({
          source: 'recap-sdk',
          type: 'SDK_STATUS',
          payload: {
            initialized,
            recording: RecapSDK.isRecording(),
            sessionId: RecapSDK.getSessionId(),
            eventCount: RecapSDK.getEvents().length,
            qualityScore: RecapSDK.getQualityScore()
          }
        }, '*');
        break;
    }
  });
}

// Expose globally for non-module usage
if (typeof window !== 'undefined') {
  window.RecapSDK = RecapSDK;
}

Logger.info('Recap SDK v' + VERSION + ' loaded');

export default RecapSDK;

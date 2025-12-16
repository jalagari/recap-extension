/**
 * Network Transport Module
 * Handles sending recording data to Cloudflare Worker API
 * 
 * API Endpoints:
 * - POST /api/recordings - Save session with events
 * - GET  /api/configs/match?url=... - Get config by URL
 * 
 * @module sdk/recording/transport
 */

import { State } from '../core/state.js';
import { Logger } from '../core/logger.js';

/** @type {string|null} API base URL */
let apiBase = null;

/** @type {string|null} Config ID for this session */
let configId = null;

/** @type {number} Batch size */
let batchSize = 50;

/** @type {number} Flush interval in ms */
let flushInterval = 10000;

/** @type {number|null} Flush timer */
let flushTimer = null;

/** @type {Array} Event queue */
let eventQueue = [];

/** @type {number} Retry count for failed requests */
let retryCount = 0;
const MAX_RETRIES = 3;

/**
 * Network Transport
 */
export const Transport = {
  /**
   * Initialize transport
   * @param {Object} config - Transport configuration
   * @param {string} config.endpoint - API base URL (e.g., https://recap-api.workers.dev)
   * @param {string} config.configId - Configuration ID
   * @param {number} config.batchSize - Events per batch
   * @param {number} config.flushInterval - Auto-flush interval in ms
   */
  init(config = {}) {
    apiBase = config.endpoint || config.apiBase || null;
    configId = config.configId || null;
    batchSize = config.batchSize || 50;
    flushInterval = config.flushInterval || 10000;
    eventQueue = [];
    retryCount = 0;
    
    if (apiBase) {
      // Normalize API base (remove trailing slash)
      apiBase = apiBase.replace(/\/$/, '');
      this._startAutoFlush();
      Logger.debug('Transport initialized:', { apiBase, configId, batchSize, flushInterval });
    } else {
      Logger.debug('Transport initialized without endpoint (local mode)');
    }
  },
  
  /**
   * Fetch configuration by URL
   * @param {string} url - URL to match
   * @returns {Promise<Object|null>} Configuration or null
   */
  async fetchConfig(url) {
    if (!apiBase) {
      Logger.debug('No API endpoint, cannot fetch config');
      return null;
    }
    
    try {
      const response = await fetch(`${apiBase}/api/configs/match?url=${encodeURIComponent(url)}`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.matched && data.config) {
        configId = data.config.id;
        Logger.info('Fetched config:', data.config.name);
        return data.config;
      }
      
      return null;
    } catch (e) {
      Logger.error('Failed to fetch config:', e.message);
      return null;
    }
  },
  
  /**
   * Queue event for sending
   * @param {Object} event - Event to queue
   */
  queue(event) {
    eventQueue.push(event);
    
    // Auto-flush when batch size reached
    if (eventQueue.length >= batchSize) {
      this.flush();
    }
  },
  
  /**
   * Flush queued events to server
   * @param {Object} options - Flush options
   * @returns {Promise<boolean>} Success
   */
  async flush(options = {}) {
    if (!apiBase && !options.force) {
      Logger.debug('No endpoint configured, skipping flush');
      return false;
    }
    
    const state = State.get();
    const events = options.events || [...eventQueue];
    
    if (events.length === 0) {
      return true;
    }
    
    // Clear queue
    eventQueue = [];
    
    // Build payload matching Cloudflare Worker API
    const payload = {
      sessionId: state.sessionId,
      configId: configId,
      url: location.href,
      startedAt: state.startTime ? new Date(state.startTime).toISOString() : new Date().toISOString(),
      endedAt: new Date().toISOString(),
      duration: Date.now() - (state.startTime || Date.now()),
      events,
      
      // Quality report
      quality: {
        score: state.quality?.score || 0,
        severity: state.quality?.severity || 'passive',
        signals: state.quality?.signals || {}
      },
      
      // User report (if provided)
      report: options.report || null
    };
    
    try {
      const endpoint = `${apiBase}/api/recordings`;
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true // Allow request to complete after page unload
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const result = await response.json();
      Logger.info('Saved recording:', result.sessionId, '- Events:', events.length);
      retryCount = 0;
      
      return true;
      
    } catch (e) {
      Logger.error('Flush failed:', e.message);
      
      // Re-queue events on failure (with retry limit)
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        eventQueue = [...events, ...eventQueue];
        Logger.debug('Re-queued events, retry', retryCount, 'of', MAX_RETRIES);
      } else {
        Logger.error('Max retries reached, dropping events');
      }
      
      return false;
    }
  },
  
  /**
   * Flush all remaining events (for session end)
   * @param {Object} options - Additional options
   * @returns {Promise<boolean>}
   */
  async flushAll(options = {}) {
    const allEvents = State.get().events;
    return this.flush({ 
      events: allEvents, 
      force: true,
      report: options.report || null
    });
  },
  
  /**
   * Submit user feedback report
   * @param {Object} report - User report
   * @returns {Promise<boolean>}
   */
  async submitReport(report) {
    return this.flushAll({ report });
  },
  
  /**
   * Get API base URL
   * @returns {string|null}
   */
  getApiBase() {
    return apiBase;
  },
  
  /**
   * Get config ID
   * @returns {string|null}
   */
  getConfigId() {
    return configId;
  },
  
  /**
   * Set config ID
   * @param {string} id - Config ID
   */
  setConfigId(id) {
    configId = id;
  },
  
  /**
   * Start auto-flush timer
   * @private
   */
  _startAutoFlush() {
    if (flushTimer) {
      clearInterval(flushTimer);
    }
    
    flushTimer = setInterval(() => {
      if (eventQueue.length > 0) {
        this.flush();
      }
    }, flushInterval);
  },
  
  /**
   * Stop auto-flush timer
   */
  stop() {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    
    // Final flush
    this.flush();
  },
  
  /**
   * Get pending event count
   * @returns {number}
   */
  getPendingCount() {
    return eventQueue.length;
  }
};


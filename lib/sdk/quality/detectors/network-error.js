/**
 * Network Error Detector
 * Intercepts fetch/XHR and detects failed requests
 * @module sdk/quality/detectors/network-error
 */

import { State } from '../../core/state.js';
import { Logger } from '../../core/logger.js';

/** Original fetch reference */
let originalFetch = null;

/** Original XHR open reference */
let originalXhrOpen = null;

/** Original XHR send reference */
let originalXhrSend = null;

/** @type {boolean} Whether detector is active */
let isActive = false;

/** @type {Set<number>} Error status codes */
const ERROR_CODES = new Set([400, 401, 403, 404, 500, 502, 503, 504]);

/**
 * Network Error Detector
 */
export const NetworkErrorDetector = {
  /** @type {number} Weight for scoring */
  weight: 40,
  
  /**
   * Start detecting network errors
   * @param {Object} config - Detector configuration
   */
  start(config = {}) {
    if (isActive) return;
    
    this._interceptFetch();
    this._interceptXhr();
    
    isActive = true;
    Logger.debug('NetworkErrorDetector started');
  },
  
  /**
   * Stop detecting and restore originals
   */
  stop() {
    if (!isActive) return;
    
    // Restore fetch
    if (originalFetch) {
      window.fetch = originalFetch;
      originalFetch = null;
    }
    
    // Restore XHR
    if (originalXhrOpen) {
      XMLHttpRequest.prototype.open = originalXhrOpen;
      originalXhrOpen = null;
    }
    if (originalXhrSend) {
      XMLHttpRequest.prototype.send = originalXhrSend;
      originalXhrSend = null;
    }
    
    isActive = false;
    Logger.debug('NetworkErrorDetector stopped');
  },
  
  /**
   * Intercept fetch API
   * @private
   */
  _interceptFetch() {
    if (typeof window.fetch !== 'function') return;
    
    originalFetch = window.fetch;
    
    window.fetch = async (...args) => {
      const [url, options] = args;
      const startTime = Date.now();
      
      try {
        const response = await originalFetch.apply(window, args);
        
        // Check for error status
        if (ERROR_CODES.has(response.status)) {
          this._recordError({
            type: 'fetch',
            url: typeof url === 'string' ? url : url.url,
            method: options?.method || 'GET',
            status: response.status,
            duration: Date.now() - startTime
          });
        }
        
        return response;
      } catch (error) {
        // Network failure (CORS, offline, etc.)
        this._recordError({
          type: 'fetch',
          url: typeof url === 'string' ? url : url.url,
          method: options?.method || 'GET',
          status: 0,
          error: error.message,
          duration: Date.now() - startTime
        });
        
        throw error;
      }
    };
  },
  
  /**
   * Intercept XMLHttpRequest
   * @private
   */
  _interceptXhr() {
    originalXhrOpen = XMLHttpRequest.prototype.open;
    originalXhrSend = XMLHttpRequest.prototype.send;
    
    const detector = this;
    
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._recapMethod = method;
      this._recapUrl = url;
      this._recapStartTime = Date.now();
      return originalXhrOpen.apply(this, [method, url, ...rest]);
    };
    
    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener('loadend', function() {
        if (ERROR_CODES.has(this.status) || this.status === 0) {
          detector._recordError({
            type: 'xhr',
            url: this._recapUrl,
            method: this._recapMethod,
            status: this.status,
            duration: Date.now() - this._recapStartTime
          });
        }
      });
      
      return originalXhrSend.apply(this, args);
    };
  },
  
  /**
   * Record network error
   * @private
   * @param {Object} errorData - Error details
   */
  _recordError(errorData) {
    // Skip extension/chrome URLs
    if (errorData.url?.includes('extension://') || errorData.url?.includes('chrome://')) {
      return;
    }
    
    Logger.signal('networkError', errorData);
    
    State.updateSignal('networkErrors', 1);
    
    // Add as rrweb custom event
    if (typeof rrweb?.record?.addCustomEvent === 'function') {
      rrweb.record.addCustomEvent('recap:network-error', {
        ...errorData,
        timestamp: Date.now()
      });
    }
  }
};


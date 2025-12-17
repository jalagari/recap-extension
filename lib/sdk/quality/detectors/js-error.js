/**
 * JavaScript Error Detector
 * Detects uncaught exceptions and unhandled promise rejections
 * @module sdk/quality/detectors/js-error
 */

import { State } from '../../core/state.js';
import { Logger } from '../../core/logger.js';

/** @type {AbortController|null} For cleanup */
let abortController = null;

/**
 * JS Error Detector
 */
export const JsErrorDetector = {
  /** @type {number} Weight for scoring */
  weight: 40,
  
  /**
   * Start detecting JS errors
   * @param {Object} config - Detector configuration
   */
  start(config = {}) {
    if (abortController) {
      this.stop();
    }
    
    abortController = new AbortController();
    const { signal } = abortController;
    
    // Handle uncaught errors
    window.addEventListener('error', this._handleError, { signal });
    
    // Handle unhandled promise rejections
    window.addEventListener('unhandledrejection', this._handleRejection, { signal });
    
    Logger.debug('JsErrorDetector started');
  },
  
  /**
   * Stop detecting
   */
  stop() {
    if (abortController) {
      abortController.abort();
      abortController = null;
      Logger.debug('JsErrorDetector stopped');
    }
  },
  
  /**
   * Handle error event
   * @private
   * @param {ErrorEvent} event - Error event
   */
  _handleError(event) {
    // Ignore errors from extensions or cross-origin scripts
    if (!event.filename || event.filename.includes('extension://')) {
      return;
    }
    
    const errorData = {
      type: 'uncaught',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      timestamp: Date.now()
    };
    
    Logger.signal('jsError', errorData);
    
    State.updateSignal('jsErrors', 1);
    
    // Add as rrweb custom event if available
    if (typeof rrweb?.record?.addCustomEvent === 'function') {
      rrweb.record.addCustomEvent('recap:error', errorData);
    }
  },
  
  /**
   * Handle unhandled rejection
   * @private
   * @param {PromiseRejectionEvent} event - Rejection event
   */
  _handleRejection(event) {
    const reason = event.reason;
    
    const errorData = {
      type: 'unhandledrejection',
      message: reason?.message || String(reason),
      stack: reason?.stack,
      timestamp: Date.now()
    };
    
    Logger.signal('jsError', errorData);
    
    State.updateSignal('jsErrors', 1);
    
    // Add as rrweb custom event if available
    if (typeof rrweb?.record?.addCustomEvent === 'function') {
      rrweb.record.addCustomEvent('recap:error', errorData);
    }
  }
};



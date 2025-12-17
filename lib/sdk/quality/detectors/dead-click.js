/**
 * Dead Click Detector
 * Detects clicks on non-interactive elements (confusion signal)
 * @module sdk/quality/detectors/dead-click
 */

import { State } from '../../core/state.js';
import { Logger } from '../../core/logger.js';

/** @type {AbortController|null} For cleanup */
let abortController = null;

/** @type {Object} Configuration */
let config = {
  detectOn: ['img:not([onclick])', 'span:not([onclick]):not([role="button"])'],
  ignore: ['[data-recap-safe]', 'button', 'a', 'input', '[role="button"]']
};

/** Interactive element selectors */
const INTERACTIVE_SELECTORS = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[onclick]',
  '[role="button"]',
  '[role="link"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * Dead Click Detector
 */
export const DeadClickDetector = {
  /** @type {number} Weight for scoring */
  weight: 10,
  
  /**
   * Start detecting dead clicks
   * @param {Object} cfg - Detector configuration
   */
  start(cfg = {}) {
    if (abortController) {
      this.stop();
    }
    
    config = { ...config, ...cfg };
    abortController = new AbortController();
    
    document.addEventListener('click', this._handleClick.bind(this), {
      signal: abortController.signal,
      capture: true
    });
    
    Logger.debug('DeadClickDetector started', config);
  },
  
  /**
   * Stop detecting
   */
  stop() {
    if (abortController) {
      abortController.abort();
      abortController = null;
      Logger.debug('DeadClickDetector stopped');
    }
  },
  
  /**
   * Handle click event
   * @private
   * @param {MouseEvent} event - Click event
   */
  _handleClick(event) {
    const target = event.target;
    
    // Skip if target or ancestors are interactive
    if (this._isInteractive(target)) {
      return;
    }
    
    // Skip if in ignore list
    if (this._shouldIgnore(target)) {
      return;
    }
    
    // Check if matches dead click patterns
    if (this._isDeadClickTarget(target)) {
      const deadClickData = {
        element: target.tagName.toLowerCase(),
        className: target.className?.toString().slice(0, 100),
        text: target.textContent?.trim().slice(0, 50),
        position: { x: event.clientX, y: event.clientY },
        timestamp: Date.now()
      };
      
      Logger.signal('deadClick', deadClickData);
      
      State.updateSignal('deadClicks', 1);
      
      // Add as rrweb custom event
      if (typeof rrweb?.record?.addCustomEvent === 'function') {
        rrweb.record.addCustomEvent('recap:dead-click', deadClickData);
      }
    }
  },
  
  /**
   * Check if element or ancestors are interactive
   * @private
   * @param {Element} element - Target element
   * @returns {boolean} Whether element is interactive
   */
  _isInteractive(element) {
    // Check element and ancestors
    let current = element;
    
    while (current && current !== document.body) {
      try {
        if (current.matches?.(INTERACTIVE_SELECTORS)) {
          return true;
        }
      } catch (e) {
        // Invalid selector match
      }
      current = current.parentElement;
    }
    
    return false;
  },
  
  /**
   * Check if element should be ignored
   * @private
   * @param {Element} element - Target element
   * @returns {boolean} Whether to ignore
   */
  _shouldIgnore(element) {
    const ignoreSelector = config.ignore.join(',');
    
    try {
      return element.matches?.(ignoreSelector) || 
             element.closest?.(ignoreSelector) !== null;
    } catch (e) {
      return false;
    }
  },
  
  /**
   * Check if element matches dead click patterns
   * @private
   * @param {Element} element - Target element
   * @returns {boolean} Whether element is a dead click target
   */
  _isDeadClickTarget(element) {
    const detectSelector = config.detectOn.join(',');
    
    try {
      return element.matches?.(detectSelector);
    } catch (e) {
      return false;
    }
  }
};



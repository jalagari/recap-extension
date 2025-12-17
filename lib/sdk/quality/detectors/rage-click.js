/**
 * Rage Click Detector
 * Detects rapid repeated clicks in same area (frustration signal)
 * @module sdk/quality/detectors/rage-click
 */

import { State } from '../../core/state.js';
import { Logger } from '../../core/logger.js';

/** @type {AbortController|null} For cleanup */
let abortController = null;

/** @type {Object} Configuration */
let config = {
  count: 3,
  windowMs: 1000,
  radiusPx: 50
};

/** @type {Array} Click history */
let clickHistory = [];

/**
 * Calculate distance between two points
 * @param {Object} p1 - Point 1 {x, y}
 * @param {Object} p2 - Point 2 {x, y}
 * @returns {number} Distance in pixels
 */
const distance = (p1, p2) => Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);

/**
 * Rage Click Detector
 */
export const RageClickDetector = {
  /** @type {number} Weight for scoring */
  weight: 25,
  
  /**
   * Start detecting rage clicks
   * @param {Object} cfg - Detector configuration
   */
  start(cfg = {}) {
    if (abortController) {
      this.stop();
    }
    
    config = { ...config, ...cfg };
    clickHistory = [];
    abortController = new AbortController();
    
    document.addEventListener('click', this._handleClick.bind(this), {
      signal: abortController.signal,
      capture: true
    });
    
    Logger.debug('RageClickDetector started', config);
  },
  
  /**
   * Stop detecting
   */
  stop() {
    if (abortController) {
      abortController.abort();
      abortController = null;
      clickHistory = [];
      Logger.debug('RageClickDetector stopped');
    }
  },
  
  /**
   * Handle click event
   * @private
   * @param {MouseEvent} event - Click event
   */
  _handleClick(event) {
    const now = Date.now();
    const click = {
      x: event.clientX,
      y: event.clientY,
      time: now,
      target: event.target.tagName
    };
    
    // Add to history
    clickHistory.push(click);
    
    // Remove old clicks outside window
    const windowStart = now - config.windowMs;
    clickHistory = clickHistory.filter(c => c.time >= windowStart);
    
    // Check for rage click
    if (this._detectRageClick(click)) {
      const rageData = {
        clickCount: clickHistory.length,
        position: { x: click.x, y: click.y },
        target: click.target,
        timestamp: now
      };
      
      Logger.signal('rageClick', rageData);
      
      State.updateSignal('rageClicks', 1);
      
      // Add as rrweb custom event
      if (typeof rrweb?.record?.addCustomEvent === 'function') {
        rrweb.record.addCustomEvent('recap:rage-click', rageData);
      }
      
      // Clear history to avoid double-counting
      clickHistory = [];
    }
  },
  
  /**
   * Detect if current click is part of a rage click
   * @private
   * @param {Object} currentClick - Current click
   * @returns {boolean} Whether rage click detected
   */
  _detectRageClick(currentClick) {
    if (clickHistory.length < config.count) {
      return false;
    }
    
    // Get recent clicks within window
    const recentClicks = clickHistory.slice(-config.count);
    
    // Check if all clicks are within radius
    const firstClick = recentClicks[0];
    const allNearby = recentClicks.every(
      click => distance(firstClick, click) <= config.radiusPx
    );
    
    return allNearby;
  }
};



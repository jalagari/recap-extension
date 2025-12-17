/**
 * Session Quality Module
 * Orchestrates all quality detectors and scoring
 * @module sdk/quality
 */

import { Logger } from '../core/logger.js';
import { JsErrorDetector } from './detectors/js-error.js';
import { NetworkErrorDetector } from './detectors/network-error.js';
import { RageClickDetector } from './detectors/rage-click.js';
import { DeadClickDetector } from './detectors/dead-click.js';
import { ValidationLoopDetector } from './detectors/validation-loop.js';
import { AbandonmentDetector } from './detectors/abandonment.js';
import { Scorer } from './scorer.js';

/** @type {boolean} Whether quality detection is active */
let isActive = false;

/** @type {Object} Current configuration */
let config = {};

/**
 * All detectors
 */
const detectors = {
  jsError: JsErrorDetector,
  networkError: NetworkErrorDetector,
  rageClick: RageClickDetector,
  deadClick: DeadClickDetector,
  validationLoop: ValidationLoopDetector,
  abandonment: AbandonmentDetector
};

/**
 * Session Quality Manager
 */
export const SessionQuality = {
  /**
   * Start all quality detectors
   * @param {Object} cfg - Quality configuration
   */
  start(cfg = {}) {
    if (isActive) {
      Logger.warn('SessionQuality already active');
      return;
    }
    
    config = cfg;
    
    // Initialize scorer
    Scorer.init({
      weights: cfg.weights,
      thresholds: cfg.thresholds,
      onScoreChange: cfg.onScoreChange,
      onCritical: cfg.onCritical
    });
    
    // Start all detectors with their configs
    JsErrorDetector.start();
    NetworkErrorDetector.start();
    RageClickDetector.start(cfg.rageClick);
    DeadClickDetector.start(cfg.deadClick);
    ValidationLoopDetector.start(cfg.validationLoop);
    AbandonmentDetector.start(cfg.formTracking);
    
    isActive = true;
    Logger.info('SessionQuality started with', Object.keys(detectors).length, 'detectors');
  },
  
  /**
   * Stop all quality detectors
   */
  stop() {
    if (!isActive) return;
    
    // Stop all detectors
    JsErrorDetector.stop();
    NetworkErrorDetector.stop();
    RageClickDetector.stop();
    DeadClickDetector.stop();
    ValidationLoopDetector.stop();
    AbandonmentDetector.stop();
    
    isActive = false;
    Logger.info('SessionQuality stopped');
  },
  
  /**
   * Check if quality detection is active
   * @returns {boolean} Whether active
   */
  isActive() {
    return isActive;
  },
  
  /**
   * Get current score
   * @returns {number} Current quality score
   */
  getScore() {
    return Scorer.getScore();
  },
  
  /**
   * Get current severity
   * @returns {'normal'|'review'|'critical'} Current severity
   */
  getSeverity() {
    return Scorer.getSeverity();
  },
  
  /**
   * Get current signals
   * @returns {Object} Signal counts
   */
  getSignals() {
    return Scorer.getSignals();
  },
  
  /**
   * Get full quality report
   * @returns {Object} Quality report
   */
  getReport() {
    return Scorer.getReport();
  },
  
  /**
   * Mark form as completed (for abandonment tracking)
   */
  markFormCompleted() {
    AbandonmentDetector.markCompleted();
  },
  
  /**
   * Get detector by name
   * @param {string} name - Detector name
   * @returns {Object|null} Detector instance
   */
  getDetector(name) {
    return detectors[name] || null;
  }
};

// Re-export individual components for direct access
export { Scorer };
export { JsErrorDetector, NetworkErrorDetector, RageClickDetector };
export { DeadClickDetector, ValidationLoopDetector, AbandonmentDetector };



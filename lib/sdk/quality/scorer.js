/**
 * Session Quality Scorer
 * Calculates quality score from detected signals
 * @module sdk/quality/scorer
 */

import { State } from '../core/state.js';
import { Logger } from '../core/logger.js';

/** @type {Object} Signal weights */
let weights = {};

/** @type {Object} Action thresholds */
let thresholds = {
  critical: 80,
  review: 50
};

/** @type {Function|null} Score change callback */
let onScoreChange = null;

/** @type {Function|null} Critical callback */
let onCritical = null;

/** @type {number} Last calculated score */
let lastScore = 0;

/** @type {string} Last severity level */
let lastSeverity = 'normal';

/**
 * Session Quality Scorer
 */
export const Scorer = {
  /**
   * Initialize scorer with config
   * @param {Object} config - Scorer configuration
   */
  init(config = {}) {
    weights = config.weights || {};
    thresholds = config.thresholds || thresholds;
    onScoreChange = config.onScoreChange || null;
    onCritical = config.onCritical || null;
    lastScore = 0;
    lastSeverity = 'normal';
    
    // Subscribe to state changes
    State.subscribe(this._handleStateChange.bind(this));
    
    Logger.debug('Scorer initialized', { weights, thresholds });
  },
  
  /**
   * Calculate score from current signals
   * @returns {number} Calculated score
   */
  calculate() {
    const { signals } = State.getPath('quality') || {};
    if (!signals) return 0;
    
    let score = 0;
    
    // Technical failures
    score += (signals.jsErrors || 0) * (weights.jsError || 40);
    score += (signals.networkErrors || 0) * (weights.networkError || 40);
    
    // Frustration signals
    score += (signals.rageClicks || 0) * (weights.rageClick || 25);
    score += (signals.formAbandoned ? 1 : 0) * (weights.formAbandonment || 20);
    
    // Design flaw signals
    score += (signals.validationLoops || 0) * (weights.validationLoop || 15);
    score += (signals.deadClicks || 0) * (weights.deadClick || 10);
    
    return score;
  },
  
  /**
   * Get current score
   * @returns {number} Current score
   */
  getScore() {
    return lastScore;
  },
  
  /**
   * Get severity level from score
   * @param {number} score - Score value
   * @returns {'normal'|'review'|'critical'} Severity level
   */
  getSeverity(score = lastScore) {
    if (score >= thresholds.critical) return 'critical';
    if (score >= thresholds.review) return 'review';
    return 'normal';
  },
  
  /**
   * Get current signals
   * @returns {Object} Current signals
   */
  getSignals() {
    return State.getPath('quality.signals') || {};
  },
  
  /**
   * Get full quality report
   * @returns {Object} Quality report
   */
  getReport() {
    return {
      score: lastScore,
      severity: lastSeverity,
      signals: this.getSignals(),
      thresholds,
      timestamp: Date.now()
    };
  },
  
  /**
   * Handle state changes
   * @private
   * @param {Object} newState - New state
   * @param {Object} prevState - Previous state
   */
  _handleStateChange(newState, prevState) {
    // Only recalculate if signals changed
    const newSignals = newState?.quality?.signals;
    const prevSignals = prevState?.quality?.signals;
    
    if (JSON.stringify(newSignals) === JSON.stringify(prevSignals)) {
      return;
    }
    
    const score = this.calculate();
    const severity = this.getSeverity(score);
    
    // Update state with new score
    State.updateScore(score);
    
    // Check for significant changes
    if (score !== lastScore) {
      Logger.debug('Score updated:', { score, severity, signals: newSignals });
      
      // Call onScoreChange callback
      if (onScoreChange) {
        try {
          onScoreChange(score, newSignals);
        } catch (e) {
          Logger.error('onScoreChange callback error:', e);
        }
      }
      
      // Check for severity escalation
      if (severity === 'critical' && lastSeverity !== 'critical') {
        Logger.warn('Session reached CRITICAL severity:', score);
        
        if (onCritical) {
          try {
            onCritical({
              score,
              signals: newSignals,
              sessionId: State.getPath('sessionId'),
              timestamp: Date.now()
            });
          } catch (e) {
            Logger.error('onCritical callback error:', e);
          }
        }
        
        // Flag session
        State.update({ quality: { ...newState.quality, flagged: true } });
      }
      
      lastScore = score;
      lastSeverity = severity;
    }
  }
};



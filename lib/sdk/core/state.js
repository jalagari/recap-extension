/**
 * SDK State Management Module
 * Centralized, immutable state with event emission
 * @module sdk/core/state
 */

/**
 * @typedef {Object} QualityState
 * @property {number} score - Current quality score
 * @property {Object} signals - Signal counts
 * @property {Array} clickHistory - Recent clicks for rage detection
 * @property {Object} validationErrors - Field validation error counts
 * @property {number} formInteractions - Form field interaction count
 * @property {boolean} formCompleted - Whether form was completed
 * @property {boolean} flagged - Whether session is flagged for review
 */

/** Initial state factory */
const createInitialState = () => ({
  // SDK state
  initialized: false,
  recording: false,
  
  // Session info
  sessionId: null,
  startTime: null,
  lastActivity: null,
  
  // Configuration
  config: null,
  
  // Events
  events: [],
  
  // Quality detection
  quality: {
    score: 0,
    signals: {
      jsErrors: 0,
      networkErrors: 0,
      rageClicks: 0,
      deadClicks: 0,
      validationLoops: 0,
      formAbandoned: false
    },
    clickHistory: [],
    validationErrors: {},
    formInteractions: 0,
    formCompleted: false,
    flagged: false
  }
});

/** @type {Object} Current state */
let state = createInitialState();

/** @type {Set<Function>} State change listeners */
const listeners = new Set();

/**
 * State manager with immutable updates
 */
export const State = {
  /**
   * Get current state (read-only copy)
   * @returns {Object} Current state
   */
  get() {
    return { ...state };
  },
  
  /**
   * Get specific state property
   * @param {string} path - Dot-notation path (e.g., 'quality.score')
   * @returns {*} Value at path
   */
  getPath(path) {
    return path.split('.').reduce((obj, key) => obj?.[key], state);
  },
  
  /**
   * Update state immutably
   * @param {Object|Function} updater - Partial state or updater function
   */
  update(updater) {
    const updates = typeof updater === 'function' ? updater(state) : updater;
    const prevState = state;
    
    state = this._deepMerge(state, updates);
    
    // Notify listeners
    this._notify(state, prevState);
  },
  
  /**
   * Update quality signals
   * @param {string} signal - Signal name
   * @param {number|boolean} value - New value or increment
   */
  updateSignal(signal, value) {
    this.update(prev => ({
      quality: {
        ...prev.quality,
        signals: {
          ...prev.quality.signals,
          [signal]: typeof value === 'boolean' 
            ? value 
            : (prev.quality.signals[signal] || 0) + value
        }
      }
    }));
  },
  
  /**
   * Update quality score
   * @param {number} score - New score
   */
  updateScore(score) {
    this.update({ quality: { ...state.quality, score } });
  },
  
  /**
   * Add event to events array
   * @param {Object} event - rrweb event
   */
  addEvent(event) {
    state.events.push(event);
    state.lastActivity = Date.now();
  },
  
  /**
   * Reset state to initial
   */
  reset() {
    state = createInitialState();
    this._notify(state, null);
  },
  
  /**
   * Subscribe to state changes
   * @param {Function} listener - Callback function
   * @returns {Function} Unsubscribe function
   */
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  
  /**
   * Deep merge helper
   * @private
   */
  _deepMerge(target, source) {
    if (!source) return target;
    
    const result = { ...target };
    
    for (const key of Object.keys(source)) {
      if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    
    return result;
  },
  
  /**
   * Notify listeners of state change
   * @private
   */
  _notify(newState, prevState) {
    for (const listener of listeners) {
      try {
        listener(newState, prevState);
      } catch (e) {
        console.error('[Recap] State listener error:', e);
      }
    }
  }
};



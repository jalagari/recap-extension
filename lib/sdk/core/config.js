/**
 * SDK Configuration Module
 * Handles configuration validation and defaults
 * @module sdk/core/config
 */

/** @type {Readonly<Object>} Default configuration */
export const DEFAULT_CONFIG = Object.freeze({
  // Recording
  endpoint: null,
  debug: false,
  
  // Session Quality Detection
  sessionQuality: {
    enabled: true,
    
    weights: {
      jsError: 40,
      networkError: 40,
      rageClick: 25,
      formAbandonment: 20,
      validationLoop: 15,
      deadClick: 10
    },
    
    thresholds: {
      critical: 80,
      review: 50
    },
    
    formTracking: {
      minInteractions: 3,
      completionSelector: '[data-recap-complete]'
    },
    
    rageClick: {
      count: 3,
      windowMs: 1000,
      radiusPx: 50
    },
    
    validationLoop: {
      count: 3,
      errorSelectors: [
        '.field-error',
        '[aria-invalid="true"]',
        '.is-invalid',
        '.error-message:not(:empty)'
      ]
    },
    
    deadClick: {
      detectOn: ['img:not([onclick])', 'span:not([onclick]):not([role="button"])'],
      ignore: ['[data-recap-safe]', 'button', 'a', 'input', '[role="button"]']
    },
    
    onScoreChange: null,
    onCritical: null
  },
  
  // Report Button
  reportButton: {
    enabled: false,
    mode: 'on_error',
    position: 'bottom-right',
    showAfterScore: 40,
    autoHideMs: 15000,
    categories: ['Bug', 'Slow', 'Confusing', 'Other'],
    allowComment: true,
    onReport: null
  }
});

/**
 * Deep merge two objects
 * @param {Object} target - Target object
 * @param {Object} source - Source object
 * @returns {Object} Merged object
 */
const deepMerge = (target, source) => {
  const result = { ...target };
  
  for (const key of Object.keys(source)) {
    if (source[key] instanceof Object && key in target && target[key] instanceof Object) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  
  return result;
};

/**
 * Validate and merge user config with defaults
 * @param {Object} userConfig - User provided configuration
 * @returns {Object} Validated and merged configuration
 */
export const createConfig = (userConfig = {}) => {
  const config = deepMerge(DEFAULT_CONFIG, userConfig);
  
  // Validate critical settings
  if (config.sessionQuality.enabled) {
    const { weights } = config.sessionQuality;
    
    // Ensure all weights are positive numbers
    for (const [key, value] of Object.entries(weights)) {
      if (typeof value !== 'number' || value < 0) {
        console.warn(`[Recap] Invalid weight for ${key}, using default`);
        weights[key] = DEFAULT_CONFIG.sessionQuality.weights[key];
      }
    }
  }
  
  return config;
};



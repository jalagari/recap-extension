/**
 * SDK Logger Module
 * Configurable logging with levels
 * @module sdk/core/logger
 */

/** @type {boolean} Debug mode flag */
let debugEnabled = false;

/** Log levels */
const LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

/** Current log level */
let currentLevel = LEVELS.WARN;

/**
 * Logger utility
 */
export const Logger = {
  /**
   * Enable/disable debug mode
   * @param {boolean} enabled - Whether debug is enabled
   */
  setDebug(enabled) {
    debugEnabled = enabled;
    currentLevel = enabled ? LEVELS.DEBUG : LEVELS.WARN;
  },
  
  /**
   * Set log level
   * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'} level - Log level
   */
  setLevel(level) {
    currentLevel = LEVELS[level] ?? LEVELS.WARN;
  },
  
  /**
   * Debug log (only when debug enabled)
   * @param {...*} args - Log arguments
   */
  debug(...args) {
    if (currentLevel <= LEVELS.DEBUG) {
      console.log('%c[Recap]', 'color: #6366f1', ...args);
    }
  },
  
  /**
   * Info log
   * @param {...*} args - Log arguments
   */
  info(...args) {
    if (currentLevel <= LEVELS.INFO) {
      console.info('%c[Recap]', 'color: #22c55e', ...args);
    }
  },
  
  /**
   * Warning log
   * @param {...*} args - Log arguments
   */
  warn(...args) {
    if (currentLevel <= LEVELS.WARN) {
      console.warn('[Recap]', ...args);
    }
  },
  
  /**
   * Error log
   * @param {...*} args - Log arguments
   */
  error(...args) {
    if (currentLevel <= LEVELS.ERROR) {
      console.error('[Recap]', ...args);
    }
  },
  
  /**
   * Log with custom styling
   * @param {string} label - Label text
   * @param {string} color - CSS color
   * @param {...*} args - Log arguments
   */
  styled(label, color, ...args) {
    if (debugEnabled) {
      console.log(`%c[Recap ${label}]`, `color: ${color}; font-weight: bold`, ...args);
    }
  },
  
  /**
   * Log quality signal detection
   * @param {string} signal - Signal name
   * @param {*} data - Signal data
   */
  signal(signal, data) {
    if (debugEnabled) {
      const icons = {
        jsError: '💥',
        networkError: '🌐',
        rageClick: '😤',
        deadClick: '👆',
        validationLoop: '🔄',
        formAbandonment: '🚪'
      };
      console.log(`%c[Recap ${icons[signal] || '📊'} ${signal}]`, 'color: #f59e0b', data);
    }
  }
};



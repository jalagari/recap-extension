/**
 * Recording Module
 * Handles rrweb recording with privacy-first masking
 * @module sdk/recording/recorder
 */

import { State } from '../core/state.js';
import { Logger } from '../core/logger.js';

/** @type {Function|null} rrweb stop function */
let stopFn = null;

/** @type {Object} Recording configuration */
let config = {};

/** @type {Array<string>} Clear selectors (fields NOT to mask) */
let clearSelectors = [];

/**
 * Recording Module
 */
export const Recording = {
  /**
   * Start rrweb recording
   * @param {Object} cfg - Recording configuration
   * @returns {boolean} Success
   */
  start(cfg = {}) {
    if (stopFn) {
      Logger.warn('Already recording');
      return false;
    }
    
    if (typeof rrweb === 'undefined') {
      Logger.error('rrweb not loaded');
      return false;
    }
    
    config = cfg;
    clearSelectors = cfg.clearSelectors || [];
    
    Logger.debug('Starting recording with config:', {
      maskAllInputs: true,
      clearSelectors: clearSelectors.length,
      stepSelectors: cfg.stepSelectors?.length || 0
    });
    
    try {
      stopFn = rrweb.record({
        emit: this._handleEvent.bind(this),
        
        // PRIVACY-FIRST: Mask all inputs by default
        maskAllInputs: true,
        maskInputOptions: { password: true, ...cfg.maskInputOptions },
        
        // Custom mask function: unmask only "clear" fields
        maskInputFn: this._maskInputFn.bind(this),
        
        // Ignoring
        ignoreSelector: cfg.ignoreSelector || null,
        blockSelector: cfg.blockSelector || '.recap-block',
        ignoreClass: cfg.ignoreClass || 'recap-ignore',
        blockClass: cfg.blockClass || 'recap-block',
        
        // Sampling
        sampling: cfg.sampling || {
          input: 'last',
          mousemove: false,
          scroll: 150
        },
        
        // Slim DOM for size reduction
        slimDOMOptions: cfg.slimDOMOptions || {
          script: true,
          comment: true,
          headFavicon: true,
          headWhitespace: true,
          headMetaSocial: true,
          headMetaRobots: true
        },
        
        // Other options
        checkoutEveryNms: cfg.checkoutEveryNms || 60000,
        inlineStylesheet: true,
        recordCanvas: cfg.recordCanvas ?? false,
        collectFonts: cfg.collectFonts ?? false
      });
      
      // Setup step tracking if configured
      if (cfg.stepSelectors?.length) {
        this._setupStepTracking(cfg.stepSelectors);
      }
      
      Logger.info('Recording started');
      return true;
      
    } catch (e) {
      Logger.error('Failed to start recording:', e);
      return false;
    }
  },
  
  /**
   * Stop recording
   * @returns {Array} Recorded events
   */
  stop() {
    if (stopFn) {
      stopFn();
      stopFn = null;
    }
    
    this._teardownStepTracking();
    
    const events = State.get().events;
    Logger.info('Recording stopped,', events.length, 'events');
    
    return events;
  },
  
  /**
   * Check if recording
   * @returns {boolean}
   */
  isRecording() {
    return stopFn !== null;
  },
  
  /**
   * Handle rrweb event
   * @private
   * @param {Object} event - rrweb event
   */
  _handleEvent(event) {
    // Apply privacy-first masking to incremental input events
    const maskedEvent = this._maskIncrementalInput(event);
    
    State.addEvent(maskedEvent);
    
    // Call event callback if configured
    if (config.onEvent) {
      config.onEvent(maskedEvent);
    }
  },
  
  /**
   * Privacy-first mask input function
   * Masks ALL inputs EXCEPT those in clearSelectors
   * @private
   * @param {string} text - Input text
   * @param {Element} element - Input element
   * @returns {string} Masked or original text
   */
  _maskInputFn(text, element) {
    // Passwords are NEVER unmasked
    if (element?.type === 'password') {
      return '••••••••';
    }
    
    // Check if element is in "clear" list (should NOT be masked)
    if (element && clearSelectors.length > 0) {
      for (const sel of clearSelectors) {
        try {
          if (element.matches?.(sel)) return text; // UNMASKED
          if (sel.startsWith('#') && element.id === sel.slice(1)) return text;
          if (sel.startsWith('[name=') && element.name) {
            const nameMatch = sel.match(/\[name="?([^"\]]+)"?\]/);
            if (nameMatch && element.name === nameMatch[1]) return text;
          }
        } catch (e) {}
      }
    }
    
    // Everything else is MASKED
    return '••••••••';
  },
  
  /**
   * Mask incremental input events (type 3, source 5)
   * @private
   * @param {Object} event - rrweb event
   * @returns {Object} Masked event
   */
  _maskIncrementalInput(event) {
    // Only process incremental snapshots with input source
    if (event.type !== 3 || event.data?.source !== 5 || !event.data?.text) {
      return event;
    }
    
    const nodeId = event.data?.id;
    if (!nodeId) return event;
    
    // Get node from rrweb mirror
    let node = null;
    try {
      node = rrweb.record?.mirror?.getNode(nodeId);
    } catch (e) {
      // If we can't get node, mask it (safe default)
      return { ...event, data: { ...event.data, text: '••••••••' } };
    }
    
    if (!node) {
      return { ...event, data: { ...event.data, text: '••••••••' } };
    }
    
    // Check if in clear list
    for (const sel of clearSelectors) {
      try {
        if (node.matches?.(sel) || 
            (sel.startsWith('#') && node.id === sel.slice(1))) {
          return event; // UNMASKED
        }
      } catch (e) {}
    }
    
    // MASK
    return { ...event, data: { ...event.data, text: '••••••••' } };
  },
  
  // ============================================================================
  // STEP TRACKING
  // ============================================================================
  
  /** @type {Function|null} Step click handler */
  _stepHandler: null,
  
  /** @type {number} Step counter */
  _stepCount: 0,
  
  /**
   * Setup step tracking via rrweb custom events
   * @private
   * @param {Array<string>} selectors - Step element selectors
   */
  _setupStepTracking(selectors) {
    this._stepCount = 0;
    
    this._stepHandler = (e) => {
      const target = e.target.closest('button, a, [role="button"], input[type="submit"]');
      if (!target) return;
      
      for (const sel of selectors) {
        try {
          if (target.matches(sel) || target.closest(sel)) {
            this._stepCount++;
            
            const label = target.textContent?.trim() ||
                          target.getAttribute('aria-label') ||
                          target.getAttribute('title') ||
                          `Step ${this._stepCount}`;
            
            // Add rrweb custom event
            if (typeof rrweb?.record?.addCustomEvent === 'function') {
              rrweb.record.addCustomEvent('recap:step', {
                step: this._stepCount,
                label: label.slice(0, 100),
                selector: sel,
                url: location.href,
                timestamp: Date.now()
              });
              
              Logger.debug(`📍 Step ${this._stepCount}: ${label}`);
            }
            
            break;
          }
        } catch (e) {}
      }
    };
    
    document.addEventListener('click', this._stepHandler, true);
    Logger.debug('Step tracking enabled for', selectors.length, 'selectors');
  },
  
  /**
   * Teardown step tracking
   * @private
   */
  _teardownStepTracking() {
    if (this._stepHandler) {
      document.removeEventListener('click', this._stepHandler, true);
      this._stepHandler = null;
    }
    this._stepCount = 0;
  }
};


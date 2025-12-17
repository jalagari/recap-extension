/**
 * Form Abandonment Detector
 * Detects when user starts form but doesn't complete it
 * @module sdk/quality/detectors/abandonment
 */

import { State } from '../../core/state.js';
import { Logger } from '../../core/logger.js';

/** @type {AbortController|null} For cleanup */
let abortController = null;

/** @type {Object} Configuration */
let config = {
  minInteractions: 3,
  completionSelector: '[data-recap-complete]'
};

/** @type {number} Form interaction count */
let interactionCount = 0;

/** @type {boolean} Whether form was completed */
let formCompleted = false;

/** @type {Set<string>} Interacted fields */
const interactedFields = new Set();

/**
 * Form Abandonment Detector
 */
export const AbandonmentDetector = {
  /** @type {number} Weight for scoring */
  weight: 20,
  
  /**
   * Start detecting form abandonment
   * @param {Object} cfg - Detector configuration
   */
  start(cfg = {}) {
    if (abortController) {
      this.stop();
    }
    
    config = { ...config, ...cfg };
    interactionCount = 0;
    formCompleted = false;
    interactedFields.clear();
    abortController = new AbortController();
    
    const { signal } = abortController;
    
    // Track form field interactions
    document.addEventListener('focus', this._handleFocus.bind(this), { signal, capture: true });
    document.addEventListener('input', this._handleInput.bind(this), { signal, capture: true });
    document.addEventListener('change', this._handleChange.bind(this), { signal, capture: true });
    
    // Track form submission
    document.addEventListener('submit', this._handleSubmit.bind(this), { signal, capture: true });
    
    // Check for completion on page unload
    window.addEventListener('beforeunload', this._handleUnload.bind(this), { signal });
    window.addEventListener('pagehide', this._handleUnload.bind(this), { signal });
    
    // Also observe for completion selector appearing
    this._observeCompletion();
    
    Logger.debug('AbandonmentDetector started', config);
  },
  
  /**
   * Stop detecting
   */
  stop() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    
    if (this._completionObserver) {
      this._completionObserver.disconnect();
      this._completionObserver = null;
    }
    
    interactionCount = 0;
    formCompleted = false;
    interactedFields.clear();
    
    Logger.debug('AbandonmentDetector stopped');
  },
  
  /**
   * Mark form as completed (call from outside if needed)
   */
  markCompleted() {
    formCompleted = true;
    Logger.debug('Form marked as completed');
  },
  
  /**
   * Get current interaction count
   * @returns {number} Interaction count
   */
  getInteractionCount() {
    return interactionCount;
  },
  
  /**
   * Handle focus event
   * @private
   * @param {FocusEvent} event - Focus event
   */
  _handleFocus(event) {
    const target = event.target;
    if (this._isFormField(target)) {
      this._recordInteraction(target);
    }
  },
  
  /**
   * Handle input event
   * @private
   * @param {InputEvent} event - Input event
   */
  _handleInput(event) {
    const target = event.target;
    if (this._isFormField(target)) {
      this._recordInteraction(target);
    }
  },
  
  /**
   * Handle change event
   * @private
   * @param {Event} event - Change event
   */
  _handleChange(event) {
    const target = event.target;
    if (this._isFormField(target)) {
      this._recordInteraction(target);
    }
  },
  
  /**
   * Handle form submission
   * @private
   * @param {SubmitEvent} event - Submit event
   */
  _handleSubmit(event) {
    formCompleted = true;
    Logger.debug('Form submitted, marking as completed');
  },
  
  /**
   * Handle page unload
   * @private
   */
  _handleUnload() {
    // Check for abandonment
    if (this._isAbandonment()) {
      const abandonmentData = {
        interactionCount,
        fieldsInteracted: interactedFields.size,
        timestamp: Date.now()
      };
      
      Logger.signal('formAbandonment', abandonmentData);
      
      State.updateSignal('formAbandoned', true);
      
      // Add as rrweb custom event (may not persist due to unload)
      if (typeof rrweb?.record?.addCustomEvent === 'function') {
        rrweb.record.addCustomEvent('recap:form-abandonment', abandonmentData);
      }
    }
  },
  
  /**
   * Observe for completion selector
   * @private
   */
  _observeCompletion() {
    // Check if already complete
    if (document.querySelector(config.completionSelector)) {
      formCompleted = true;
      return;
    }
    
    this._completionObserver = new MutationObserver((mutations) => {
      if (document.querySelector(config.completionSelector)) {
        formCompleted = true;
        this._completionObserver?.disconnect();
        Logger.debug('Completion selector detected');
      }
    });
    
    this._completionObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  },
  
  /**
   * Check if element is a form field
   * @private
   * @param {Element} element - Element to check
   * @returns {boolean} Whether element is a form field
   */
  _isFormField(element) {
    return element.matches?.('input:not([type="hidden"]), select, textarea');
  },
  
  /**
   * Record field interaction
   * @private
   * @param {Element} field - Form field
   */
  _recordInteraction(field) {
    const fieldId = field.id || field.name || field.getAttribute('data-field');
    
    if (fieldId && !interactedFields.has(fieldId)) {
      interactedFields.add(fieldId);
      interactionCount++;
      
      // Update state
      State.update(prev => ({
        quality: {
          ...prev.quality,
          formInteractions: interactionCount
        }
      }));
    }
  },
  
  /**
   * Check if current state is abandonment
   * @private
   * @returns {boolean} Whether form was abandoned
   */
  _isAbandonment() {
    return !formCompleted && interactionCount >= config.minInteractions;
  }
};



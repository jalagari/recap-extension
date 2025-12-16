/**
 * Validation Loop Detector
 * Detects repeated validation errors on same field (design flaw signal)
 * @module sdk/quality/detectors/validation-loop
 */

import { State } from '../../core/state.js';
import { Logger } from '../../core/logger.js';

/** @type {MutationObserver|null} DOM observer */
let observer = null;

/** @type {Object} Configuration */
let config = {
  count: 3,
  errorSelectors: [
    '.field-error',
    '[aria-invalid="true"]',
    '.is-invalid',
    '.error-message:not(:empty)'
  ]
};

/** @type {Map<string, number>} Field error counts */
const errorCounts = new Map();

/** @type {Set<string>} Fields already flagged */
const flaggedFields = new Set();

/**
 * Generate field identifier
 * @param {Element} element - Form field element
 * @returns {string|null} Field identifier
 */
const getFieldId = (element) => {
  return element.id || element.name || element.getAttribute('data-field');
};

/**
 * Validation Loop Detector
 */
export const ValidationLoopDetector = {
  /** @type {number} Weight for scoring */
  weight: 15,
  
  /**
   * Start detecting validation loops
   * @param {Object} cfg - Detector configuration
   */
  start(cfg = {}) {
    if (observer) {
      this.stop();
    }
    
    config = { ...config, ...cfg };
    errorCounts.clear();
    flaggedFields.clear();
    
    // Use MutationObserver to detect validation error changes
    observer = new MutationObserver(this._handleMutations.bind(this));
    
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-invalid']
    });
    
    // Also listen for invalid events on form fields
    document.addEventListener('invalid', this._handleInvalid.bind(this), { capture: true });
    
    Logger.debug('ValidationLoopDetector started', config);
  },
  
  /**
   * Stop detecting
   */
  stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    
    document.removeEventListener('invalid', this._handleInvalid, { capture: true });
    
    errorCounts.clear();
    flaggedFields.clear();
    
    Logger.debug('ValidationLoopDetector stopped');
  },
  
  /**
   * Handle DOM mutations
   * @private
   * @param {MutationRecord[]} mutations - DOM mutations
   */
  _handleMutations(mutations) {
    for (const mutation of mutations) {
      // Check for attribute changes (aria-invalid, class)
      if (mutation.type === 'attributes') {
        const element = mutation.target;
        
        if (this._hasValidationError(element)) {
          this._recordValidationError(element);
        }
      }
      
      // Check for added error message elements
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            this._checkForErrors(node);
          }
        }
      }
    }
  },
  
  /**
   * Handle native invalid event
   * @private
   * @param {Event} event - Invalid event
   */
  _handleInvalid(event) {
    const field = event.target;
    this._recordValidationError(field);
  },
  
  /**
   * Check element and children for validation errors
   * @private
   * @param {Element} element - Element to check
   */
  _checkForErrors(element) {
    const errorSelector = config.errorSelectors.join(',');
    
    try {
      // Check if element itself is an error indicator
      if (element.matches?.(errorSelector)) {
        // Find associated field
        const field = this._findAssociatedField(element);
        if (field) {
          this._recordValidationError(field);
        }
      }
      
      // Check children
      const errors = element.querySelectorAll?.(errorSelector);
      errors?.forEach(errorEl => {
        const field = this._findAssociatedField(errorEl);
        if (field) {
          this._recordValidationError(field);
        }
      });
    } catch (e) {
      // Invalid selector
    }
  },
  
  /**
   * Check if element has validation error
   * @private
   * @param {Element} element - Element to check
   * @returns {boolean} Whether has error
   */
  _hasValidationError(element) {
    return element.getAttribute('aria-invalid') === 'true' ||
           element.classList?.contains('is-invalid') ||
           element.classList?.contains('error');
  },
  
  /**
   * Find form field associated with error element
   * @private
   * @param {Element} errorElement - Error element
   * @returns {Element|null} Associated field
   */
  _findAssociatedField(errorElement) {
    // Check if error element is the field itself
    if (errorElement.matches?.('input, select, textarea')) {
      return errorElement;
    }
    
    // Check for aria-describedby reference
    const describedBy = errorElement.id;
    if (describedBy) {
      const field = document.querySelector(`[aria-describedby*="${describedBy}"]`);
      if (field) return field;
    }
    
    // Check parent form group
    const formGroup = errorElement.closest('.form-group, .field-wrapper, [data-field]');
    if (formGroup) {
      return formGroup.querySelector('input, select, textarea');
    }
    
    // Check previous sibling
    const prevSibling = errorElement.previousElementSibling;
    if (prevSibling?.matches?.('input, select, textarea')) {
      return prevSibling;
    }
    
    return null;
  },
  
  /**
   * Record validation error for field
   * @private
   * @param {Element} field - Form field
   */
  _recordValidationError(field) {
    const fieldId = getFieldId(field);
    if (!fieldId) return;
    
    // Skip if already flagged
    if (flaggedFields.has(fieldId)) return;
    
    // Increment error count
    const count = (errorCounts.get(fieldId) || 0) + 1;
    errorCounts.set(fieldId, count);
    
    // Check if threshold reached
    if (count >= config.count) {
      flaggedFields.add(fieldId);
      
      const loopData = {
        fieldId,
        fieldName: field.name || field.id,
        errorCount: count,
        timestamp: Date.now()
      };
      
      Logger.signal('validationLoop', loopData);
      
      State.updateSignal('validationLoops', 1);
      
      // Add as rrweb custom event
      if (typeof rrweb?.record?.addCustomEvent === 'function') {
        rrweb.record.addCustomEvent('recap:validation-loop', loopData);
      }
    }
  }
};


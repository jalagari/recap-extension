/**
 * Recap - Shared rrweb Utilities
 * Common configuration builder for both Trainer and Tester modes
 * @version 1.1.0
 * 
 * IMPORTANT: rrweb's maskInputFn only works during initial snapshot serialization.
 * For incremental input events, we must mask in the emit callback.
 */

(function() {
  'use strict';

  // ============================================================================
  // RRWEB OPTIONS BUILDER - Shared between Trainer and Tester
  // ============================================================================

  const RrwebUtils = {
    /**
     * Build rrweb record options from a configuration object
     * @param {Object} config - The recap configuration
     * @param {Function} emitCallback - Callback for emit events
     * @param {Object} options - Additional options (plugins, logging)
     * @returns {Object} rrweb.record options
     */
    buildRecordOptions(config, emitCallback, options = {}) {
      const { plugins = [], log = console.log } = options;
      
      // Extract selectors from config (handle both Trainer and exported config formats)
      const maskSelectors = config.masking?.selectors || [];
      const maskAll = config.masking?.maskAllInputs || config.masking?.mask_all_inputs;
      const ignoreSelectors = config.ignored?.selectors || [];
      const blockSelectors = config.blocked?.selectors || [];
      
      // Use rrweb_options if available (from exported config)
      const rrwebOpts = config.rrweb_options || {};
      
      // Build rrweb's ignoreSelector - combines config + default class
      const ignoreSelector = rrwebOpts.ignoreSelector || 
        (['.recap-ignore', ...ignoreSelectors].filter(Boolean).join(',') || null);
      
      // Build rrweb's blockSelector - combines config + default class  
      const blockSelector = rrwebOpts.blockSelector || 
        (['.recap-block', ...blockSelectors].filter(Boolean).join(',') || null);
      
      // Build maskTextSelector
      const maskTextSelector = rrwebOpts.maskTextSelector || 
        (maskSelectors.length ? maskSelectors.join(',') : null);
      
      log('[RrwebUtils] Building options:', {
        maskSelectorsCount: maskSelectors.length,
        maskSelectors: maskSelectors,
        ignoreSelectors: ignoreSelectors.length,
        blockSelectors: blockSelectors.length,
        maskAll: !!maskAll
      });
      
      // maskInputFn for initial snapshot (limited effectiveness for incremental events)
      const maskInputFn = this.createMaskInputFn(maskSelectors, log);
      log('[RrwebUtils] maskInputFn created:', typeof maskInputFn);
      
      // Create wrapper emit that masks incremental input events
      const maskedEmitCallback = this.createMaskedEmitCallback(emitCallback, maskSelectors, log);
      
      return {
        emit: maskedEmitCallback,
        
        // ============================================================
        // MASKING OPTIONS
        // ============================================================
        
        // Built-in input type masking
        maskInputOptions: rrwebOpts.maskInputOptions || {
          password: true,
          ...(maskAll && { text: true, email: true, tel: true, number: true })
        },
        
        // Selective input masking by selector (only works for initial snapshot!)
        maskInputFn,
        
        // Mask text content for matching elements
        maskTextSelector,
        
        // ============================================================
        // IGNORE/BLOCK OPTIONS
        // ============================================================
        
        ignoreSelector,
        blockSelector,
        ignoreClass: rrwebOpts.ignoreClass || 'recap-ignore',
        blockClass: rrwebOpts.blockClass || 'recap-block',
        
        // ============================================================
        // SAMPLING OPTIONS
        // ============================================================
        sampling: rrwebOpts.sampling || {
          input: 'last',
          mousemove: false,
          scroll: 150,
          media: 800
        },
        
        // ============================================================
        // PERFORMANCE OPTIONS
        // ============================================================
        recordCanvas: false,
        collectFonts: false,
        inlineStylesheet: true,
        
        plugins
      };
    },

    /**
     * Create an emit callback wrapper that masks incremental input events
     * This is necessary because rrweb's maskInputFn only works for initial snapshot!
     * @param {Function} originalEmit - Original emit callback
     * @param {Array} maskSelectors - Selectors to mask
     * @param {Function} log - Logging function
     * @returns {Function} Wrapped emit callback
     */
    createMaskedEmitCallback(originalEmit, maskSelectors, log = console.log) {
      if (!maskSelectors || !maskSelectors.length) {
        return originalEmit;
      }
      
      return (event, isCheckout) => {
        // Only process incremental snapshots (type 3) with input source (source 5)
        if (event.type === 3 && event.data?.source === 5 && event.data?.text) {
          const nodeId = event.data?.id;
          
          // Try to get the node from rrweb's mirror
          let node = null;
          try {
            node = typeof rrweb !== 'undefined' && rrweb.record?.mirror?.getNode(nodeId);
          } catch (e) {
            // Mirror might not be available
          }
          
          if (node) {
            // Check if this node matches any mask selector
            for (const sel of maskSelectors) {
              try {
                let matched = false;
                
                if (sel.startsWith('#')) {
                  const idPart = sel.slice(1);
                  if (node.id === idPart || (node.id && node.id.includes(idPart))) {
                    matched = true;
                  }
                } else if (sel.startsWith('[name=') && node.name) {
                  const nameMatch = sel.match(/\[name="?([^"\]]+)"?\]/);
                  if (nameMatch && (node.name === nameMatch[1] || node.name.includes(nameMatch[1]))) {
                    matched = true;
                  }
                } else if (sel.startsWith('.') && node.classList?.contains(sel.slice(1))) {
                  matched = true;
                } else if (node.matches?.(sel)) {
                  matched = true;
                }
                
                if (matched) {
                  log('[RrwebUtils] ✓ Masking incremental input for:', node.id || node.name || nodeId);
                  // Create masked copy of event
                  const maskedEvent = {
                    ...event,
                    data: {
                      ...event.data,
                      text: '••••••••'
                    }
                  };
                  return originalEmit(maskedEvent, isCheckout);
                }
              } catch (e) {
                // Invalid selector, continue
              }
            }
          }
        }
        
        // Pass through unmodified
        return originalEmit(event, isCheckout);
      };
    },

    /**
     * Create a maskInputFn that handles various selector formats
     * NOTE: This only works for initial snapshot serialization, not incremental events!
     * @param {Array} selectors - Array of selectors to mask
     * @param {Function} log - Logging function
     * @returns {Function} maskInputFn for rrweb
     */
    createMaskInputFn(selectors, log = console.log) {
      if (!selectors || !selectors.length) {
        log('[RrwebUtils] createMaskInputFn: No selectors provided');
        return undefined;
      }
      
      log('[RrwebUtils] createMaskInputFn: Creating with', selectors.length, 'selectors:', selectors);
      
      // Track if function is ever called
      let callCount = 0;
      
      return (text, element) => {
        callCount++;
        
        // Log first few calls to verify function is being invoked
        if (callCount <= 5) {
          log('[RrwebUtils] maskInputFn called #' + callCount, {
            textLength: text?.length,
            hasElement: !!element,
            elementTag: element?.tagName,
            elementId: element?.id,
            elementName: element?.name
          });
        }
        
        if (!element) return text;
        
        for (const sel of selectors) {
          try {
            // ID selector: #someId
            if (sel.startsWith('#')) {
              const idPart = sel.slice(1);
              if (element.id === idPart) {
                log('[RrwebUtils] ✓ MASKED (exact ID):', sel);
                return '••••••••';
              }
              if (element.id && element.id.includes(idPart)) {
                log('[RrwebUtils] ✓ MASKED (partial ID):', sel, '→', element.id);
                return '••••••••';
              }
            }
            
            // Name selector: [name="fieldName"]
            if (sel.startsWith('[name=')) {
              const nameMatch = sel.match(/\[name="?([^"\]]+)"?\]/);
              if (nameMatch && element.name) {
                const nameVal = nameMatch[1];
                if (element.name === nameVal || element.name.includes(nameVal)) {
                  log('[RrwebUtils] ✓ MASKED (name):', sel, '→', element.name);
                  return '••••••••';
                }
              }
            }
            
            // Class selector: .className
            if (sel.startsWith('.') && element.classList) {
              const className = sel.slice(1);
              if (element.classList.contains(className)) {
                log('[RrwebUtils] ✓ MASKED (class):', sel);
                return '••••••••';
              }
            }
            
            // Try CSS selector match as fallback
            if (typeof element.matches === 'function') {
              try {
                if (element.matches(sel)) {
                  log('[RrwebUtils] ✓ MASKED (CSS match):', sel);
                  return '••••••••';
                }
              } catch (matchErr) {
                // Invalid CSS selector, continue to next
              }
            }
          } catch (e) {
            console.warn('[RrwebUtils] Selector error:', sel, e.message);
          }
        }
        
        return text;
      };
    },

    /**
     * Validate that required events exist for replay
     * @param {Array} events - rrweb events array
     * @returns {Object} { valid: boolean, error: string|null }
     */
    validateEvents(events) {
      if (!events || !Array.isArray(events) || events.length < 2) {
        return { valid: false, error: 'Not enough events' };
      }
      
      const hasMeta = events.some(e => e.type === 4);
      const hasFullSnapshot = events.some(e => e.type === 2);
      
      if (!hasMeta) {
        return { valid: false, error: 'Missing Meta event' };
      }
      if (!hasFullSnapshot) {
        return { valid: false, error: 'Missing FullSnapshot' };
      }
      
      return { valid: true, error: null };
    }
  };

  // Export for different contexts
  if (typeof window !== 'undefined') {
    window.RrwebUtils = RrwebUtils;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RrwebUtils;
  }
})();


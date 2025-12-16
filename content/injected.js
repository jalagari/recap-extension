/**
 * Recap - Injected Script v8.0.0
 * With rrweb custom events for step tracking
 */

'use strict';

(function() {
  const log = (...args) => console.log('[Recap Page]', ...args);
  
  log('Script loaded');
  
  let stopFn = null;
  let isRecording = false;
  let stepSelectors = [];
  let stepCount = 0;
  
  // ============================================================================
  // Communication
  // ============================================================================
  
  function send(type, data = {}) {
    window.postMessage({ source: 'recap-page', type, data }, '*');
  }
  
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'recap-content') return;
    
    const { type, data } = e.data;
    
    switch (type) {
      case 'START':
        startRecording(data?.options || {});
        break;
      case 'STOP':
        stopRecording();
        break;
    }
  });
  
  // ============================================================================
  // Step Tracking via rrweb Custom Events
  // ============================================================================
  
  function setupStepTracking(selectors) {
    if (!selectors?.length) return;
    
    stepSelectors = selectors;
    stepCount = 0;
    
    log('Step tracking enabled for', selectors.length, 'selectors');
    
    // Listen for clicks on step elements
    document.addEventListener('click', handleStepClick, true);
  }
  
  function teardownStepTracking() {
    document.removeEventListener('click', handleStepClick, true);
    stepSelectors = [];
    stepCount = 0;
  }
  
  function handleStepClick(e) {
    if (!isRecording || !stepSelectors.length) return;
    
    const target = e.target.closest('button, a, [role="button"], input[type="submit"]');
    if (!target) return;
    
    // Check if this element matches any step selector
    for (const sel of stepSelectors) {
      try {
        if (target.matches(sel) || target.closest(sel)) {
          stepCount++;
          
          // Extract meaningful label
          const label = target.textContent?.trim() || 
                        target.getAttribute('aria-label') || 
                        target.getAttribute('title') ||
                        `Step ${stepCount}`;
          
          // Use rrweb's addCustomEvent for step tracking
          if (typeof rrweb?.record?.addCustomEvent === 'function') {
            rrweb.record.addCustomEvent('recap:step', {
              step: stepCount,
              label: label.slice(0, 100), // Limit length
              selector: sel,
              url: location.href,
              timestamp: Date.now()
            });
            
            log(`📍 Step ${stepCount}: ${label}`);
            
            // Also notify extension
            send('STEP', { step: stepCount, label, selector: sel });
          }
          
          break; // Only count once per click
        }
      } catch (e) {
        // Invalid selector
      }
    }
  }
  
  // ============================================================================
  // Recording
  // ============================================================================
  
  function startRecording(options = {}) {
    if (isRecording) return;
    
    if (typeof rrweb === 'undefined') {
      log('rrweb not available');
      return;
    }
    
    log('Starting recording...');
    
    // Setup step tracking if selectors provided
    if (options.stepSelectors?.length) {
      setupStepTracking(options.stepSelectors);
    }
    
    stopFn = rrweb.record({
      emit: (event) => send('EVENT', { event }),
      maskAllInputs: options.maskAllInputs ?? true,  // Privacy-first
      maskInputOptions: options.maskInputOptions || { password: true },
      maskInputFn: options.maskInputFn,
      maskTextSelector: options.maskTextSelector || null,
      ignoreSelector: options.ignoreSelector || null,
      blockSelector: options.blockSelector || null,
      sampling: options.sampling || { mousemove: 50, scroll: 150, input: 'last' },
      slimDOMOptions: options.slimDOMOptions || { script: true, comment: true },
      checkoutEveryNms: 10000,
      inlineStylesheet: true,
      recordCanvas: false,
      collectFonts: false
    });
    
    isRecording = true;
    log('Recording started');
    send('STARTED');
  }
  
  function stopRecording() {
    if (!isRecording) return;
    
    teardownStepTracking();
    
    if (stopFn) {
      stopFn();
      stopFn = null;
    }
    
    isRecording = false;
    log('Recording stopped');
    send('STOPPED');
  }
  
  // ============================================================================
  // Init
  // ============================================================================
  
  send('READY', { hasRrweb: typeof rrweb !== 'undefined' });
})();

/**
 * Recap - Production Recording SDK
 * 
 * Usage:
 * <script src="https://cdn.jsdelivr.net/npm/rrweb@latest/dist/rrweb.min.js"></script>
 * <script src="recorder.js"></script>
 * <script>
 *   RecapSDK.init({
 *     configUrl: '/config/form-config.json',
 *     // OR inline config:
 *     // config: { ... },
 *     endpoint: 'https://your-api.com/recordings',
 *     debug: false
 *   });
 * </script>
 * 
 * @version 1.0.0
 */

(function(global) {
  'use strict';

  const VERSION = '1.0.0';
  
  // ============================================================================
  // Configuration
  // ============================================================================
  
  const defaults = {
    configUrl: null,
    config: null,
    endpoint: null,
    batchSize: 50,           // Events per batch
    flushInterval: 10000,    // Send every 10s
    maxEvents: 5000,         // Max events before auto-flush
    sessionTimeout: 30 * 60 * 1000, // 30 min session timeout
    debug: false,
    onError: null,
    onReady: null,
    testMode: false          // For extension testing
  };

  // ============================================================================
  // State
  // ============================================================================
  
  const state = {
    initialized: false,
    recording: false,
    stopFn: null,
    events: [],
    sessionId: null,
    config: null,
    options: null,
    startTime: null,
    lastActivity: null
  };

  // ============================================================================
  // Utilities
  // ============================================================================
  
  const log = (...args) => state.options?.debug && console.log('[Recap SDK]', ...args);
  
  const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  
  const shouldSample = (rate) => Math.random() < (rate || 1);

  // ============================================================================
  // Network
  // ============================================================================
  
  const Network = {
    queue: [],
    sending: false,
    
    async send(data) {
      if (!state.options?.endpoint) {
        log('No endpoint configured, skipping send');
        return;
      }
      
      try {
        const response = await fetch(state.options.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          keepalive: true
        });
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        log('Sent', data.events?.length || 0, 'events');
        return true;
      } catch (e) {
        log('Send failed:', e.message);
        state.options?.onError?.(e);
        return false;
      }
    },
    
    flush() {
      if (!state.events.length) return;
      
      const payload = {
        session_id: state.sessionId,
        form_id: state.config?.form?.id,
        form_name: state.config?.form?.name,
        timestamp: Date.now(),
        duration: Date.now() - state.startTime,
        events: state.events.splice(0, state.events.length),
        metadata: {
          url: location.href,
          user_agent: navigator.userAgent,
          sdk_version: VERSION
        }
      };
      
      // For test mode, send to extension instead
      if (state.options?.testMode) {
        window.postMessage({ 
          source: 'recap-sdk', 
          type: 'RECORDING_DATA', 
          payload 
        }, '*');
        return;
      }
      
      this.send(payload);
    }
  };

  // ============================================================================
  // Recording
  // ============================================================================
  
  const Recording = {
    /**
     * Helper to mask incremental input events
     * CRITICAL: rrweb's maskInputFn only works for initial snapshot!
     * This function masks input values for incremental events.
     */
    maskIncrementalInput(event, maskSelectors) {
      // Only process incremental snapshots (type 3) with input source (source 5)
      if (event.type !== 3 || event.data?.source !== 5 || !event.data?.text) {
        return event;
      }
      
      const nodeId = event.data?.id;
      if (!nodeId) return event;
      
      // Get the node from rrweb's mirror
      let node = null;
      try {
        node = rrweb.record?.mirror?.getNode(nodeId);
      } catch (e) {
        return event;
      }
      
      if (!node) return event;
      
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
            log('Masking incremental input for:', node.id || node.name || nodeId);
            return {
              ...event,
              data: {
                ...event.data,
                text: '••••••••'
              }
            };
          }
        } catch (e) {
          // Invalid selector, continue
        }
      }
      
      return event;
    },
    
    start() {
      log('Recording.start() called, recording:', state.recording, 'rrweb:', typeof rrweb);
      if (state.recording) {
        log('Cannot start - already recording');
        return false;
      }
      if (typeof rrweb === 'undefined') {
        log('Cannot start - rrweb not loaded');
        return false;
      }
      
      state.sessionId = generateId();
      state.startTime = Date.now();
      state.lastActivity = Date.now();
      state.events = [];
      
      log('Starting recording, session:', state.sessionId);
      
      try {
        const maskSelectors = state.config?.masking?.selectors || [];
        
        // Define emit callback with incremental input masking
        const emitCallback = (event, isCheckout) => {
          // Apply masking to incremental input events
          const maskedEvent = maskSelectors.length > 0 
            ? this.maskIncrementalInput(event, maskSelectors) 
            : event;
          
          state.events.push(maskedEvent);
          state.lastActivity = Date.now();
          
          // Auto-flush when batch size reached
          if (state.events.length >= state.options.batchSize) {
            Network.flush();
          }
          
          // For test mode, also send individual events
          if (state.options?.testMode) {
            window.postMessage({ 
              source: 'recap-sdk', 
              type: 'RRWEB_EVENT', 
              payload: { event: maskedEvent, eventCount: state.events.length }
            }, '*');
          }
        };
        
        // Use shared RrwebUtils if available (for consistency with extension)
        let recordOptions;
        if (typeof window.RrwebUtils !== 'undefined') {
          log('Using shared RrwebUtils for config');
          log('Config passed to RrwebUtils:', {
            hasMasking: !!state.config?.masking,
            maskingSelectors: state.config?.masking?.selectors,
            hasRrwebOptions: !!state.config?.rrweb_options
          });
          recordOptions = window.RrwebUtils.buildRecordOptions(state.config, emitCallback, { log });
          log('rrweb options built:', {
            hasMaskInputFn: typeof recordOptions.maskInputFn === 'function',
            maskTextSelector: recordOptions.maskTextSelector,
            ignoreSelector: recordOptions.ignoreSelector
          });
        } else {
          // Standalone mode - build options inline
          log('Using standalone config (RrwebUtils not available)');
          const rrwebOptions = state.config?.rrweb_options || {};
          
          log('Masking config:', {
            selectors: maskSelectors,
            count: maskSelectors.length,
            maskAllInputs: state.config?.masking?.mask_all_inputs
          });
          
          recordOptions = {
            emit: emitCallback,
            ignoreSelector: rrwebOptions.ignoreSelector || null,
            blockSelector: rrwebOptions.blockSelector || '.recap-block',
            maskTextSelector: rrwebOptions.maskTextSelector || null,
            maskInputOptions: rrwebOptions.maskInputOptions || { password: true },
            ignoreClass: rrwebOptions.ignoreClass || 'recap-ignore',
            blockClass: rrwebOptions.blockClass || 'recap-block',
            sampling: rrwebOptions.sampling || { input: 'last', mousemove: false, scroll: 150 },
            recordCanvas: rrwebOptions.recordCanvas ?? false,
            collectFonts: rrwebOptions.collectFonts ?? false,
            inlineStylesheet: true
          };
          
          // Add maskInputFn for selective masking during initial snapshot
          if (maskSelectors.length > 0) {
            recordOptions.maskInputFn = (text, element) => {
              if (!element) return text;
              for (const sel of maskSelectors) {
                try {
                  if (element.matches?.(sel)) return '••••••••';
                  if (sel.startsWith('#') && element.id === sel.slice(1)) return '••••••••';
                  if (sel.startsWith('#') && element.id?.includes(sel.slice(1))) return '••••••••';
                  if (sel.startsWith('[name=') && element.name) {
                    const nameMatch = sel.match(/\[name="?([^"\]]+)"?\]/);
                    if (nameMatch && (element.name === nameMatch[1] || element.name.includes(nameMatch[1]))) {
                      return '••••••••';
                    }
                  }
                } catch (e) {}
              }
              return text;
            };
          }
        }
        
        // Add checkout for long sessions
        recordOptions.checkoutEveryNms = 60000;
        
        state.stopFn = rrweb.record(recordOptions);
        state.recording = true;
        
        // Setup periodic flush
        this.flushInterval = setInterval(() => {
          if (state.events.length > 0) {
            Network.flush();
          }
        }, state.options.flushInterval);
        
        // Setup page unload handler
        window.addEventListener('beforeunload', () => this.stop());
        window.addEventListener('pagehide', () => this.stop());
        
        log('Recording started');
        return true;
      } catch (e) {
        log('Failed to start recording:', e);
        state.options?.onError?.(e);
        return false;
      }
    },
    
    stop() {
      if (!state.recording) return;
      
      log('Stopping recording');
      
      if (state.stopFn) {
        state.stopFn();
        state.stopFn = null;
      }
      
      if (this.flushInterval) {
        clearInterval(this.flushInterval);
        this.flushInterval = null;
      }
      
      // Final flush
      Network.flush();
      
      state.recording = false;
      log('Recording stopped');
    },
    
    isRecording() {
      return state.recording;
    }
  };

  // ============================================================================
  // Public API
  // ============================================================================
  
  const RecapSDK = {
    VERSION,
    
    /**
     * Initialize the SDK
     * @param {Object} options - Configuration options
     */
    async init(options = {}) {
      // In test mode, allow re-initialization by resetting state
      if (options.testMode) {
        log('Test mode detected');
        if (state.initialized || state.recording) {
          log('Resetting SDK state for new test');
          this.stop();
          state.initialized = false;
          state.recording = false;
          state.events = [];
          state.config = null;
        }
      }
      
      if (state.initialized) {
        log('Already initialized');
        return;
      }
      
      state.options = { ...defaults, ...options };
      log('Initializing v' + VERSION);
      
      // Load configuration
      try {
        if (options.configUrl) {
          const response = await fetch(options.configUrl);
          state.config = await response.json();
          log('Config loaded from:', options.configUrl);
        } else if (options.config) {
          state.config = options.config;
          log('Using inline config');
        } else {
          log('No config provided, using defaults');
          state.config = {};
        }
        
        // Skip sampling and path checks in test mode
        if (!state.options.testMode) {
          // Check sampling rate
          const samplingRate = state.config?.sampling_rate ?? 1;
          if (!shouldSample(samplingRate)) {
            log('Session not sampled (rate:', samplingRate, ')');
            return;
          }
          
          // Check path pattern
          const pathPattern = state.config?.form?.path_pattern;
          if (pathPattern && !this.matchesPath(pathPattern)) {
            log('Path does not match pattern:', pathPattern);
            return;
          }
        } else {
          log('Test mode - skipping sampling/path checks');
        }
        
        state.initialized = true;
        log('SDK initialized successfully, testMode:', !!options.testMode);
        state.options?.onReady?.();
        
        // Auto-start if not in test mode
        if (!options.testMode) {
          Recording.start();
        } else {
          log('Test mode - waiting for manual start()');
        }
        
      } catch (e) {
        log('Init failed:', e);
        state.options?.onError?.(e);
      }
    },
    
    /**
     * Start recording manually
     */
    start() {
      log('RecapSDK.start() called, initialized:', state.initialized);
      if (!state.initialized) {
        log('Not initialized - cannot start');
        return false;
      }
      const result = Recording.start();
      log('Recording.start() result:', result, 'state.recording:', state.recording);
      return result;
    },
    
    /**
     * Stop recording
     */
    stop() {
      Recording.stop();
    },
    
    /**
     * Check if recording
     */
    isRecording() {
      return Recording.isRecording();
    },
    
    /**
     * Get current session ID
     */
    getSessionId() {
      return state.sessionId;
    },
    
    /**
     * Get recorded events (for testing)
     */
    getEvents() {
      return [...state.events];
    },
    
    /**
     * Manually flush events
     */
    flush() {
      Network.flush();
    },
    
    /**
     * Add custom event
     */
    addCustomEvent(tag, payload) {
      if (!state.recording) return;
      
      rrweb.record.addCustomEvent(tag, payload);
    },
    
    /**
     * Check if path matches pattern
     */
    matchesPath(pattern) {
      if (!pattern) return true;
      const path = location.pathname;
      
      // Convert pattern to regex
      // :id → \d+, :uuid → [a-f0-9-]+, :hash → [a-z0-9]+
      const regex = new RegExp(
        '^' + pattern
          .replace(/:\w+/g, '[^/]+')
          .replace(/\//g, '\\/')
        + '$',
        'i'
      );
      
      return regex.test(path);
    },
    
    /**
     * Get configuration
     */
    getConfig() {
      return state.config;
    }
  };

  // Expose to global
  global.RecapSDK = RecapSDK;
  
  // For extension testing - listen for messages
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'recap-extension') return;
    
    const { type, payload } = event.data;
    
    switch (type) {
      case 'SDK_INIT':
        RecapSDK.init({ ...payload, testMode: true });
        break;
      case 'SDK_START':
        RecapSDK.start();
        break;
      case 'SDK_STOP':
        RecapSDK.stop();
        break;
      case 'SDK_GET_STATUS':
        window.postMessage({
          source: 'recap-sdk',
          type: 'SDK_STATUS',
          payload: {
            initialized: state.initialized,
            recording: state.recording,
            sessionId: state.sessionId,
            eventCount: state.events.length
          }
        }, '*');
        break;
    }
  });

  log('SDK loaded v' + VERSION);

})(typeof window !== 'undefined' ? window : this);


/**
 * Recap - Production Recording SDK
 * 
 * SIMPLE USAGE (auto-loads everything):
 * <script src="https://your-cdn.com/recap-sdk.js" 
 *         data-config="/api/config/my-form.json"
 *         data-endpoint="/api/recordings"></script>
 * 
 * OR MANUAL:
 * <script src="recap-sdk.js"></script>
 * <script>
 *   RecapSDK.init({
 *     configUrl: '/api/config/my-form.json',
 *     endpoint: '/api/recordings'
 *   });
 * </script>
 * 
 * @version 2.0.0
 */

(function(global) {
  'use strict';

  const VERSION = '2.0.0';
  const RRWEB_CDN = 'https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.17/dist/rrweb.min.js';
  
  // ============================================================================
  // Configuration
  // ============================================================================
  
  const defaults = {
    configUrl: null,
    config: null,
    endpoint: null,
    rrwebUrl: RRWEB_CDN,     // Can override rrweb source
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
    rrwebLoaded: false,
    stopFn: null,
    events: [],
    sessionId: null,
    config: null,
    options: null,
    startTime: null,
    lastActivity: null
  };

  const STORAGE_KEY = 'recap_sdk_session';

  // ============================================================================
  // Session Persistence (for cross-page recording)
  // ============================================================================
  
  const Session = {
    save() {
      if (!state.recording) return;
      try {
        const data = {
          sessionId: state.sessionId,
          config: state.config,
          options: state.options,
          startTime: state.startTime,
          recording: true
        };
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        log('Session saved for cross-page continuation');
      } catch (e) {
        log('Session save failed:', e);
      }
    },
    
    load() {
      try {
        const data = sessionStorage.getItem(STORAGE_KEY);
        return data ? JSON.parse(data) : null;
      } catch (e) {
        log('Session load failed:', e);
        return null;
      }
    },
    
    clear() {
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch (e) {}
    },
    
    // Send events before page unload (but don't stop if cross-page enabled)
    flushBeforeUnload() {
      if (state.events.length > 0) {
        Network.flush();
      }
      // Save session for continuation on next page
      if (state.options?.crossPage !== false) {
        this.save();
      }
    }
  };

  // ============================================================================
  // Utilities
  // ============================================================================
  
  const log = (...args) => state.options?.debug && console.log('[Recap SDK]', ...args);
  
  const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  
  const shouldSample = (rate) => Math.random() < (rate || 1);

  // ============================================================================
  // Loader - Auto-load rrweb
  // ============================================================================
  
  const Loader = {
    async loadScript(url) {
      return new Promise((resolve, reject) => {
        // Check if already loaded
        if (url.includes('rrweb') && typeof rrweb !== 'undefined') {
          resolve();
          return;
        }
        
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Failed to load: ${url}`));
        document.head.appendChild(script);
      });
    },
    
    async ensureRrweb(rrwebUrl) {
      if (typeof rrweb !== 'undefined') {
        log('rrweb already loaded');
        state.rrwebLoaded = true;
        return true;
      }
      
      log('Loading rrweb from:', rrwebUrl || RRWEB_CDN);
      try {
        await this.loadScript(rrwebUrl || RRWEB_CDN);
        state.rrwebLoaded = true;
        log('rrweb loaded successfully');
        return true;
      } catch (e) {
        log('Failed to load rrweb:', e);
        return false;
      }
    }
  };

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
    
    /**
     * PRIVACY-FIRST: Mask ALL input events EXCEPT those in clearSelectors
     */
    applyPrivacyFirstMasking(event, clearSelectors) {
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
        // If we can't get the node, mask it (safe default)
        return { ...event, data: { ...event.data, text: '••••••••' } };
      }
      
      if (!node) {
        // Unknown node = mask it (safe default)
        return { ...event, data: { ...event.data, text: '••••••••' } };
      }
      
      // Check if this node is in the "clear" list (should NOT be masked)
      for (const sel of clearSelectors) {
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
            log('Clear (not masking):', node.id || node.name || nodeId);
            return event; // Return UNMASKED
          }
        } catch (e) {
          // Invalid selector, continue
        }
      }
      
      // NOT in clear list = MASK IT
      return { ...event, data: { ...event.data, text: '••••••••' } };
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
        // PRIVACY-FIRST: All inputs masked by default
        // clearSelectors = fields that should NOT be masked
        const clearSelectors = state.config?.rrweb_options?.clearSelectors || 
                               state.config?.fields?.clear?.map(f => f.selector) || [];
        
        log('Privacy-first config:', {
          maskAllInputs: true,
          clearSelectors: clearSelectors.length
        });
        
        // Define emit callback with privacy-first masking
        const emitCallback = (event, isCheckout) => {
          // PRIVACY-FIRST: mask ALL inputs except those in clear list
          const maskedEvent = this.applyPrivacyFirstMasking(event, clearSelectors);
          
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
        
        // Build rrweb record options with PRIVACY-FIRST approach
        const rrwebOptions = state.config?.rrweb_options || {};
        
        let recordOptions = {
          emit: emitCallback,
          // PRIVACY-FIRST: Mask ALL inputs by default
          maskAllInputs: true,
          maskInputOptions: { password: true, ...rrwebOptions.maskInputOptions },
          ignoreSelector: rrwebOptions.ignoreSelector || null,
          blockSelector: rrwebOptions.blockSelector || '.recap-block',
          ignoreClass: rrwebOptions.ignoreClass || 'recap-ignore',
          blockClass: rrwebOptions.blockClass || 'recap-block',
          sampling: rrwebOptions.sampling || { input: 'last', mousemove: false, scroll: 150 },
          recordCanvas: rrwebOptions.recordCanvas ?? false,
          collectFonts: rrwebOptions.collectFonts ?? false,
          inlineStylesheet: true
        };
        
        // PRIVACY-FIRST maskInputFn: mask ALL except clearSelectors
        recordOptions.maskInputFn = (text, element) => {
          // Passwords are NEVER unmasked
          if (element?.type === 'password') return '••••••••';
          
          // Check if element is in clear list (safe to show)
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
        };
        
        // Add checkout for long sessions
        recordOptions.checkoutEveryNms = 60000;
        
        state.stopFn = rrweb.record(recordOptions);
        state.recording = true;
        
        // Setup step tracking via rrweb custom events
        this.setupStepTracking();
        
        // Setup periodic flush
        this.flushInterval = setInterval(() => {
          if (state.events.length > 0) {
            Network.flush();
          }
        }, state.options.flushInterval);
        
        // Setup page unload handler - save session for cross-page continuation
        window.addEventListener('beforeunload', () => Session.flushBeforeUnload());
        window.addEventListener('pagehide', () => Session.flushBeforeUnload());
        
        log('Recording started');
        return true;
      } catch (e) {
        log('Failed to start recording:', e);
        state.options?.onError?.(e);
        return false;
      }
    },
    
    /**
     * Setup step tracking using rrweb custom events
     * Listens for clicks on step elements and calls addCustomEvent
     */
    setupStepTracking() {
      // Get step selectors from config
      const stepSelectors = state.config?.rrweb_options?.stepSelectors ||
                            state.config?.fields?.steps?.map(f => f.selector) || [];
      
      if (!stepSelectors.length) {
        log('No step selectors configured');
        return;
      }
      
      log('Step tracking enabled for', stepSelectors.length, 'selectors');
      
      // Store for cleanup
      this.stepCount = 0;
      this.stepHandler = (e) => {
        if (!state.recording) return;
        
        const target = e.target.closest('button, a, [role="button"], input[type="submit"]');
        if (!target) return;
        
        // Check if matches any step selector
        for (const sel of stepSelectors) {
          try {
            if (target.matches(sel) || target.closest(sel)) {
              this.stepCount++;
              
              const label = target.textContent?.trim() ||
                            target.getAttribute('aria-label') ||
                            target.getAttribute('title') ||
                            `Step ${this.stepCount}`;
              
              // Use rrweb's addCustomEvent
              if (typeof rrweb?.record?.addCustomEvent === 'function') {
                rrweb.record.addCustomEvent('recap:step', {
                  step: this.stepCount,
                  label: label.slice(0, 100),
                  selector: sel,
                  url: location.href,
                  timestamp: Date.now()
                });
                
                log(`📍 Step ${this.stepCount}: ${label}`);
              }
              
              break;
            }
          } catch (e) {}
        }
      };
      
      document.addEventListener('click', this.stepHandler, true);
    },
    
    /**
     * Cleanup step tracking
     */
    teardownStepTracking() {
      if (this.stepHandler) {
        document.removeEventListener('click', this.stepHandler, true);
        this.stepHandler = null;
      }
      this.stepCount = 0;
    },
    
    stop() {
      if (!state.recording) return;
      
      log('Stopping recording');
      
      // Cleanup step tracking
      this.teardownStepTracking();
      
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
      
      // Clear cross-page session (user explicitly stopped)
      Session.clear();
      
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
     * @param {string} options.configUrl - URL to fetch config JSON from
     * @param {Object} options.config - Inline config object (alternative to configUrl)
     * @param {string} options.endpoint - API endpoint for sending recordings
     * @param {string} options.rrwebUrl - Custom rrweb CDN URL (optional)
     * @param {boolean} options.debug - Enable debug logging
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
          Session.clear();
        }
      }
      
      if (state.initialized) {
        log('Already initialized');
        return;
      }
      
      state.options = { ...defaults, ...options };
      log('Initializing v' + VERSION);
      
      try {
        // Step 1: Load rrweb if not present
        const rrwebLoaded = await Loader.ensureRrweb(state.options.rrwebUrl);
        if (!rrwebLoaded) {
          throw new Error('Failed to load rrweb library');
        }
        
        // Step 2: Check for session to resume (cross-page continuation)
        const savedSession = Session.load();
        if (savedSession?.recording && !options.testMode) {
          log('Resuming session from previous page:', savedSession.sessionId);
          state.sessionId = savedSession.sessionId;
          state.config = savedSession.config;
          state.options = { ...state.options, ...savedSession.options };
          state.startTime = savedSession.startTime;
          state.initialized = true;
          state.events = []; // New page, new events (old ones were sent)
          
          // Start recording on this page
          Recording.start();
          log('Cross-page recording resumed');
          return;
        }
        
        // Step 3: Load configuration (new session)
        if (options.configUrl) {
          log('Fetching config from:', options.configUrl);
          const response = await fetch(options.configUrl);
          if (!response.ok) {
            throw new Error(`Config fetch failed: ${response.status}`);
          }
          state.config = await response.json();
          log('Config loaded:', state.config.name || state.config.form?.name);
        } else if (options.config) {
          state.config = options.config;
          log('Using inline config');
        } else {
          log('No config provided, using defaults');
          state.config = {};
        }
        
        // Step 4: Check sampling and path matching (skip in test mode)
        if (!state.options.testMode) {
          // Check sampling rate
          const samplingRate = state.config?.sampling_rate ?? state.config?.settings?.sampling_rate ?? 1;
          if (!shouldSample(samplingRate)) {
            log('Session not sampled (rate:', samplingRate, ')');
            return;
          }
          
          // Check path pattern
          const pathPattern = state.config?.url_pattern || state.config?.form?.path_pattern;
          if (pathPattern && pathPattern !== '*' && !this.matchesPath(pathPattern)) {
            log('Path does not match pattern:', pathPattern);
            return;
          }
        } else {
          log('Test mode - skipping sampling/path checks');
        }
        
        // Step 5: Ready!
        state.initialized = true;
        log('SDK initialized successfully');
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
    },
    
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

  // ============================================================================
  // Auto-Initialize from Script Data Attributes
  // ============================================================================
  // 
  // Enables zero-config usage:
  // <script src="recap-sdk.js" data-config="/api/config.json" data-endpoint="/api/recordings"></script>
  //
  
  function autoInit() {
    // Find the script tag that loaded us
    const scripts = document.querySelectorAll('script[src*="recap"]');
    let ourScript = null;
    
    for (const script of scripts) {
      if (script.src.includes('recap-sdk') || script.src.includes('recorder')) {
        ourScript = script;
        break;
      }
    }
    
    if (!ourScript) return;
    
    // Read data attributes
    const configUrl = ourScript.dataset.config || ourScript.getAttribute('data-config');
    const endpoint = ourScript.dataset.endpoint || ourScript.getAttribute('data-endpoint');
    const debug = ourScript.dataset.debug === 'true';
    
    if (configUrl || endpoint) {
      console.log('[Recap SDK] Auto-initializing from script attributes');
      RecapSDK.init({
        configUrl,
        endpoint,
        debug
      });
    }
  }
  
  // Run auto-init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    // Small delay to ensure script tag is in DOM
    setTimeout(autoInit, 0);
  }
  
  console.log('[Recap SDK] v' + VERSION + ' loaded');

})(typeof window !== 'undefined' ? window : this);


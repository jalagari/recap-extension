/**
 * Recap - Injected Script (Refactored)
 * Uses rrweb hooks and plugins properly
 * @version 2.0.0
 */

(function() {
  'use strict';

  // ============================================================================
  // Configuration
  // ============================================================================

  const Config = {
    VERSION: '2.2.0',
    DEBUG: true,  // Enable debug for troubleshooting
    STORAGE_KEY: 'recap_session',
    MESSAGE_SOURCE: { INJECTED: 'recap-injected', CONTENT: 'recap-content' }
  };

  // ============================================================================
  // State
  // ============================================================================

  const State = {
    isRecording: false,
    stopFn: null,
    config: {},
    events: []
  };

  // Original network functions (rrweb doesn't intercept network)
  const Originals = {
    fetch: window.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    consoleError: console.error,
    consoleWarn: console.warn
  };

  // ============================================================================
  // Utilities
  // ============================================================================

  const log = (...args) => Config.DEBUG && console.log('[Recap]', ...args);
  
  const send = (type, payload) => {
    window.postMessage({ source: Config.MESSAGE_SOURCE.INJECTED, type, payload }, '*');
  };

  const parseBody = (body) => {
    if (!body) return null;
    try {
      if (typeof body === 'string') {
        try { return JSON.parse(body); } catch {}
        if (body.includes('=')) {
          const obj = {};
          new URLSearchParams(body).forEach((v, k) => obj[k] = v);
          return Object.keys(obj).length ? obj : null;
        }
      }
      if (body instanceof FormData) {
        const obj = {};
        body.forEach((v, k) => obj[k] = typeof v === 'string' ? v : '[File]');
        return obj;
      }
      if (body instanceof URLSearchParams) {
        const obj = {};
        body.forEach((v, k) => obj[k] = v);
        return obj;
      }
    } catch {}
    return null;
  };

  // ============================================================================
  // Recording Module
  // ============================================================================

  const Recording = {
    start(config = {}) {
      log('Recording.start called with config:', JSON.stringify(config, null, 2));
      log('Masking selectors:', config?.masking?.selectors || []);
      if (State.isRecording) {
        log('Already recording, ignoring');
        return;
      }
      if (typeof rrweb === 'undefined') {
        log('rrweb not loaded!');
        send('RECORDING_ERROR', { message: 'rrweb not loaded' });
        return;
      }

      State.config = config;
      State.events = [];
      State.isRecording = true;

      try {
        log('Calling rrweb.record()');
        State.stopFn = rrweb.record(this.buildOptions(config));
        Network.intercept();
        ErrorCapture.setup();
        Navigation.setup();
        
        log('Recording started successfully');
        send('RECORDING_STARTED', { timestamp: Date.now(), version: Config.VERSION });
      } catch (error) {
        log('Recording failed:', error);
        State.isRecording = false;
        send('RECORDING_ERROR', { message: error.message });
      }
    },

    stop() {
      if (!State.isRecording) return;
      
      State.isRecording = false;
      if (State.stopFn) {
        State.stopFn();
        State.stopFn = null;
      }
      
      Network.restore();
      ErrorCapture.restore();
      
      log('Recording stopped, events:', State.events.length);
      send('RECORDING_STOPPED', { timestamp: Date.now(), eventCount: State.events.length });
    },

    buildOptions(config) {
      const plugins = [];
      
      // Use rrweb's console plugin if available (bundled in rrweb@2.x)
      if (typeof rrwebConsoleRecord !== 'undefined' && rrwebConsoleRecord.getRecordConsolePlugin) {
        try {
          plugins.push(rrwebConsoleRecord.getRecordConsolePlugin({
            level: ['error', 'warn', 'info'],
            lengthThreshold: 1000,
            logger: { log, warn: log, error: log } // Prevent plugin logs
          }));
          log('rrweb console plugin enabled');
        } catch (e) {
          log('Console plugin init failed:', e.message);
        }
      }

      const maskSelectors = config.masking?.selectors || [];
      const maskAll = config.masking?.maskAllInputs || config.masking?.mask_all_inputs;
      const ignoreSelectors = config.ignored?.selectors || [];
      const blockSelectors = config.blocked?.selectors || [];
      
      log('Building rrweb options with:', {
        maskSelectors: maskSelectors,
        maskAll: maskAll,
        ignoreSelectors: ignoreSelectors.length
      });
      
      const ignoreSelector = ['.recap-ignore', ...ignoreSelectors].filter(Boolean).join(',') || null;
      const blockSelector = ['.recap-block', ...blockSelectors].filter(Boolean).join(',') || null;
      
      // Build a Set of node IDs that should be masked (populated during snapshot)
      const maskedNodeIds = new Set();
      
      // Helper to check if a node ID should be masked
      const shouldMaskNodeId = (nodeId) => maskedNodeIds.has(nodeId);
      
      // Create maskInputFn for initial snapshot - also tracks which nodes to mask
      const maskInputFn = maskSelectors.length > 0 
        ? ((text, element) => {
            if (!element || !maskSelectors.length) return text;
            for (const sel of maskSelectors) {
              try {
                // Direct selector match
                if (element.matches?.(sel)) {
                  log('maskInputFn: MATCHED (CSS):', sel, '→', element.id || element.name);
                  return '••••••••';
                }
                // ID selector match
                if (sel.startsWith('#')) {
                  const idPart = sel.slice(1);
                  if (element.id === idPart || (element.id && element.id.includes(idPart))) {
                    log('maskInputFn: MATCHED (ID):', sel, '→', element.id);
                    return '••••••••';
                  }
                }
                // Name attribute match
                if (sel.startsWith('[name=') && element.name) {
                  const nameMatch = sel.match(/\[name="?([^"\]]+)"?\]/);
                  if (nameMatch) {
                    const nameVal = nameMatch[1];
                    if (element.name === nameVal || element.name.includes(nameVal)) {
                      log('maskInputFn: MATCHED (name):', sel, '→', element.name);
                      return '••••••••';
                    }
                  }
                }
                // Class selector match
                if (sel.startsWith('.') && element.classList?.contains(sel.slice(1))) {
                  log('maskInputFn: MATCHED (class):', sel);
                  return '••••••••';
                }
              } catch (e) { /* invalid selector */ }
            }
            return text;
          })
        : undefined;
      
      /**
       * CRITICAL: rrweb's maskInputFn only works for initial snapshot!
       * For incremental input events (type 3, source 5), we need to mask in the emit callback.
       * We check the node ID against elements that match our masking selectors.
       */
      const maskIncrementalInputEvent = (event) => {
        // Only process incremental snapshots with input source
        if (event.type !== 3 || event.data?.source !== 5) return event;
        
        const nodeId = event.data?.id;
        if (!nodeId) return event;
        
        // Get the actual DOM element using rrweb's mirror
        const node = rrweb.record?.mirror?.getNode(nodeId);
        if (!node) return event;
        
        // Check if this node matches any mask selector
        let shouldMask = false;
        for (const sel of maskSelectors) {
          try {
            if (sel.startsWith('#')) {
              const idPart = sel.slice(1);
              if (node.id === idPart || (node.id && node.id.includes(idPart))) {
                shouldMask = true;
                break;
              }
            } else if (sel.startsWith('[name=') && node.name) {
              const nameMatch = sel.match(/\[name="?([^"\]]+)"?\]/);
              if (nameMatch && (node.name === nameMatch[1] || node.name.includes(nameMatch[1]))) {
                shouldMask = true;
                break;
              }
            } else if (sel.startsWith('.') && node.classList?.contains(sel.slice(1))) {
              shouldMask = true;
              break;
            } else if (node.matches?.(sel)) {
              shouldMask = true;
              break;
            }
          } catch (e) { /* invalid selector */ }
        }
        
        if (shouldMask && event.data.text) {
          log('Masking incremental input for node:', nodeId, '→', node.id || node.name);
          // Clone event to avoid mutating original
          return {
            ...event,
            data: {
              ...event.data,
              text: '••••••••'
            }
          };
        }
        
        return event;
      };
      
      // Emit callback with input masking
      const emitCallback = (event, isCheckout) => {
        // Apply masking to incremental input events
        const maskedEvent = maskSelectors.length > 0 ? maskIncrementalInputEvent(event) : event;
        
        State.events.push(maskedEvent);
        send('RRWEB_EVENT', { event: maskedEvent, eventCount: State.events.length, isCheckout });
        const simplified = EventParser.parse(maskedEvent);
        if (simplified) send('TIMELINE_EVENT', simplified);
      };
      
      return {
        emit: emitCallback,
        maskInputOptions: {
          password: true,
          ...(maskAll && { text: true, email: true, tel: true, number: true })
        },
        maskInputFn,
        maskTextSelector: maskSelectors.length ? maskSelectors.join(',') : null,
        ignoreSelector,
        blockSelector,
        ignoreClass: 'recap-ignore',
        blockClass: 'recap-block',
        sampling: { input: 'last', mousemove: false, scroll: 150, media: 800 },
        recordCanvas: false,
        collectFonts: false,
        inlineStylesheet: true,
        plugins
      };
    }
  };

  // ============================================================================
  // Event Parser Module (Extracts simplified events from rrweb events)
  // ============================================================================

  const EventParser = {
    // rrweb event type constants
    // https://github.com/rrweb-io/rrweb/blob/master/packages/types/src/index.ts
    TYPES: { 
      DOM_CONTENT_LOADED: 0,
      LOAD: 1,
      FULL_SNAPSHOT: 2,
      INCREMENTAL_SNAPSHOT: 3,
      META: 4,
      CUSTOM: 5,
      PLUGIN: 6
    },
    // IncrementalSource enum
    SOURCES: { 
      MUTATION: 0,
      MOUSE_MOVE: 1,
      MOUSE_INTERACTION: 2,
      SCROLL: 3,
      VIEWPORT_RESIZE: 4,
      INPUT: 5,
      TOUCH_MOVE: 6,
      MEDIA_INTERACTION: 7,
      STYLE_SHEET: 8,
      CANVAS_MUTATION: 9,
      FONT: 10,
      LOG: 11,
      DRAG: 12,
      STYLE_DECLARATION: 13,
      SELECTION: 14,
      ADOPT_STYLE_SHEET: 15
    },
    // MouseInteractions enum
    MOUSE_TYPES: { 
      MOUSE_UP: 0,
      MOUSE_DOWN: 1,
      CLICK: 2,
      CONTEXT_MENU: 3,
      DBL_CLICK: 4,
      FOCUS: 5,
      BLUR: 6,
      TOUCH_START: 7,
      TOUCH_MOVE: 8,
      TOUCH_END: 9,
      TOUCH_CANCEL: 10
    },

    parse(event) {
      // Handle plugin events (console logs from rrweb console plugin)
      if (event.type === this.TYPES.PLUGIN) {
        return this.parsePluginEvent(event);
      }
      
      // Handle custom events (network events we added)
      if (event.type === this.TYPES.CUSTOM) {
        return this.parseCustomEvent(event);
      }
      
      // Only handle incremental snapshots for user interactions
      if (event.type !== this.TYPES.INCREMENTAL_SNAPSHOT) {
        return null;
      }
      
      const source = event.data?.source;
      
      // Input events (source 5)
      if (source === this.SOURCES.INPUT) {
        return this.parseInputEvent(event);
      }
      
      // Mouse interactions (source 2) - click, focus, blur, etc.
      if (source === this.SOURCES.MOUSE_INTERACTION) {
        return this.parseMouseEvent(event);
      }
      
      return null;
    },
    
    parseCustomEvent(event) {
      // Handle our custom network events
      if (event.data?.tag === 'network') {
        return {
          type: 'network',
          timestamp: event.timestamp,
          data: event.data.payload
        };
      }
      return null;
    },

    parsePluginEvent(event) {
      const plugin = event.data?.plugin;
      
      // Handle rrweb console plugin events
      if (plugin === 'rrweb/console@1') {
        const payload = event.data?.payload;
        const level = payload?.level;
        
        if (level === 'error' || level === 'warn') {
          return {
            type: 'error',
            timestamp: event.timestamp,
            data: {
              errorType: level,
              message: payload?.payload?.join(' ') || 'Unknown error',
              source: 'console'
            }
          };
        }
      }
      
      return null;
    },

    parseInputEvent(event) {
      const node = this.getNode(event.data.id);
      const visibility = this.checkVisibility(node);
      return {
        type: 'input',
        timestamp: event.timestamp,
        data: {
          selector: this.getSelector(node),
          value: event.data.text,
          label: this.getLabel(node),
          fieldType: node?.type || 'text',
          isVisible: visibility.isVisible,
          visibilityReason: visibility.reason
        }
      };
    },

    parseMouseEvent(event) {
      const node = this.getNode(event.data.id);
      const mouseType = event.data.type;
      
      // Map mouse interaction types to event types
      // 0=MouseUp, 1=MouseDown, 2=Click, 3=ContextMenu, 4=DblClick, 5=Focus, 6=Blur
      const typeMap = { 2: 'click', 3: 'click', 4: 'click', 5: 'focus', 6: 'blur' };
      const eventType = typeMap[mouseType];
      
      if (!eventType) return null;
      
      const visibility = this.checkVisibility(node);
      return {
        type: eventType,
        timestamp: event.timestamp,
        data: {
          selector: this.getSelector(node),
          text: this.getCaption(node),
          tagName: node?.tagName?.toLowerCase(),
          isVisible: visibility.isVisible,
          visibilityReason: visibility.reason
        }
      };
    },
    
    /**
     * Check if a DOM element is visible to the user
     * Returns { isVisible: boolean, reason: string }
     */
    checkVisibility(node) {
      if (!node || !node.getBoundingClientRect) {
        return { isVisible: false, reason: 'no-node' };
      }
      
      try {
        const style = window.getComputedStyle(node);
        
        // Check CSS visibility
        if (style.display === 'none') {
          return { isVisible: false, reason: 'display-none' };
        }
        if (style.visibility === 'hidden') {
          return { isVisible: false, reason: 'visibility-hidden' };
        }
        if (parseFloat(style.opacity) === 0) {
          return { isVisible: false, reason: 'opacity-zero' };
        }
        
        // Check if element has dimensions
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          return { isVisible: false, reason: 'zero-size' };
        }
        
        // Check if hidden input type
        if (node.type === 'hidden') {
          return { isVisible: false, reason: 'hidden-input' };
        }
        
        // Check if off-screen
        const viewWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewHeight = window.innerHeight || document.documentElement.clientHeight;
        if (rect.right < 0 || rect.bottom < 0 || rect.left > viewWidth || rect.top > viewHeight) {
          return { isVisible: false, reason: 'off-screen' };
        }
        
        // Check aria-hidden
        if (node.getAttribute?.('aria-hidden') === 'true') {
          return { isVisible: false, reason: 'aria-hidden' };
        }
        
        // Check parent visibility (up to 5 levels)
        let parent = node.parentElement;
        let depth = 0;
        while (parent && depth < 5) {
          const parentStyle = window.getComputedStyle(parent);
          if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') {
            return { isVisible: false, reason: 'parent-hidden' };
          }
          parent = parent.parentElement;
          depth++;
        }
        
        return { isVisible: true, reason: 'visible' };
      } catch (e) {
        return { isVisible: true, reason: 'check-failed' };
      }
    },

    getNode(id) {
      // Use rrweb's mirror API (the correct way!)
      return rrweb.record?.mirror?.getNode(id) || null;
    },

    getSelector(node) {
      if (!node) return '';
      if (node.id) return `#${node.id}`;
      if (node.name) return `[name="${node.name}"]`;
      if (node.className && typeof node.className === 'string') {
        return `.${node.className.split(' ')[0]}`;
      }
      return node.tagName?.toLowerCase() || '';
    },

    getLabel(node) {
      if (!node) return null;
      
      // Priority: aria-label > label[for] > parent label > placeholder
      const ariaLabel = node.getAttribute?.('aria-label');
      if (ariaLabel) return ariaLabel;
      
      if (node.id) {
        const label = document.querySelector(`label[for="${node.id}"]`);
        if (label) return label.textContent?.trim();
      }
      
      const parentLabel = node.closest?.('label');
      if (parentLabel) return parentLabel.textContent?.trim();
      
      return node.placeholder || null;
    },

    getCaption(node) {
      if (!node) return null;
      return node.textContent?.trim()?.substring(0, 50) 
        || node.getAttribute?.('aria-label') 
        || node.value 
        || null;
    }
  };

  // ============================================================================
  // Network Interception Module (rrweb doesn't capture network - we need this)
  // ============================================================================

  const Network = {
    intercept() {
      // Intercept fetch - with safety checks
      window.fetch = async function(...args) {
        const start = Date.now();
        const [url, options] = args;
        
        // Always call original fetch first to avoid breaking page
        try {
          const response = await Originals.fetch.apply(window, args);
          // Only record if still recording (page might be unloading)
          if (State.isRecording) {
            try {
              Network.record(url, options, response.status, start);
            } catch (e) {
              // Ignore recording errors - don't break page
            }
          }
          return response;
        } catch (error) {
          if (State.isRecording) {
            try {
              Network.record(url, options, 0, start, error.message);
            } catch (e) {
              // Ignore recording errors
            }
          }
          throw error;
        }
      };

      // Intercept XHR - with safety checks
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        try {
          this._recap = { method, url, start: Date.now() };
        } catch (e) {
          // Ignore
        }
        return Originals.xhrOpen.apply(this, [method, url, ...rest]);
      };

      XMLHttpRequest.prototype.send = function(body) {
        const xhr = this;
        try {
          if (body && xhr._recap) xhr._recap.body = body;
          
          xhr.addEventListener('loadend', () => {
            if (xhr._recap && State.isRecording) {
              try {
                Network.record(xhr._recap.url, {
                  method: xhr._recap.method,
                  body: xhr._recap.body
                }, xhr.status, xhr._recap.start);
              } catch (e) {
                // Ignore recording errors
              }
            }
          });
        } catch (e) {
          // Ignore setup errors
        }
        
        return Originals.xhrSend.apply(this, arguments);
      };
    },

    restore() {
      try {
        window.fetch = Originals.fetch;
        XMLHttpRequest.prototype.open = Originals.xhrOpen;
        XMLHttpRequest.prototype.send = Originals.xhrSend;
      } catch (e) {
        // Ignore restore errors
      }
    },

    record(url, options, status, startTime, error = null) {
      if (!State.isRecording) return;
      
      const event = {
        type: 'network',
        timestamp: startTime,
        data: {
          url: String(url).substring(0, 200),
          method: options?.method || 'GET',
          status,
          duration: Date.now() - startTime,
          body: parseBody(options?.body),
          error
        }
      };
      
      send('TIMELINE_EVENT', event);
      
      // Also add to rrweb recording as custom event
      if (rrweb.record?.addCustomEvent) {
        rrweb.record.addCustomEvent('network', event.data);
      }
    }
  };

  // ============================================================================
  // Error Capture Module (Fallback if rrweb console plugin not available)
  // ============================================================================

  const ErrorCapture = {
    listeners: [],

    setup() {
      // Only use fallback if rrweb console plugin is not available
      if (typeof rrwebConsoleRecord !== 'undefined') {
        log('Using rrweb console plugin for error capture');
        return;
      }

      log('Using fallback error capture');

      // Intercept console.error
      console.error = (...args) => {
        Originals.consoleError.apply(console, args);
        this.capture('error', args);
      };

      // Intercept console.warn
      console.warn = (...args) => {
        Originals.consoleWarn.apply(console, args);
        this.capture('warn', args);
      };

      // Global error handler
      const errorHandler = (event) => {
        this.capture('uncaught', [event.message, event.filename, event.lineno]);
      };
      window.addEventListener('error', errorHandler);
      this.listeners.push(['error', errorHandler]);

      // Unhandled promise rejection
      const rejectionHandler = (event) => {
        this.capture('promise', [event.reason?.message || String(event.reason)]);
      };
      window.addEventListener('unhandledrejection', rejectionHandler);
      this.listeners.push(['unhandledrejection', rejectionHandler]);
    },

    capture(type, args) {
      if (!State.isRecording) return;
      
      send('TIMELINE_EVENT', {
        type: 'error',
        timestamp: Date.now(),
        data: {
          errorType: type,
          message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
          source: 'fallback'
        }
      });
    },

    restore() {
      console.error = Originals.consoleError;
      console.warn = Originals.consoleWarn;
      this.listeners.forEach(([type, handler]) => window.removeEventListener(type, handler));
      this.listeners = [];
    }
  };

  // ============================================================================
  // Navigation Module (Handle page redirects)
  // ============================================================================

  const Navigation = {
    setup() {
      // Use passive listeners to not block navigation
      window.addEventListener('beforeunload', () => this.save(), { passive: true });
      window.addEventListener('pagehide', () => this.save(), { passive: true });
    },

    save() {
      if (!State.isRecording) return;
      try {
        // Save state AND events - essential for redirect continuity
        const data = {
          config: State.config,
          events: State.events,
          savedAt: Date.now(),
          fromUrl: location.href,
          wasRecording: true
        };
        
        // Try to save events - may fail if too large
        try {
          sessionStorage.setItem(Config.STORAGE_KEY, JSON.stringify(data));
          log('Saved', State.events.length, 'events for redirect');
        } catch (quotaError) {
          // If quota exceeded, save just the marker without events
          // Panel will keep its copy
          sessionStorage.setItem(Config.STORAGE_KEY, JSON.stringify({
            config: State.config,
            savedAt: Date.now(),
            fromUrl: location.href,
            wasRecording: true,
            eventsInPanel: true
          }));
          log('Quota exceeded, saved marker only');
        }
      } catch (e) {
        // Ignore - page might be unloading
      }
    },

    restore() {
      try {
        const saved = sessionStorage.getItem(Config.STORAGE_KEY);
        if (!saved) return null;
        
        sessionStorage.removeItem(Config.STORAGE_KEY);
        const data = JSON.parse(saved);
        
        // Only restore if recent (30s) and was recording
        if (Date.now() - data.savedAt > 30000) return null;
        if (!data.wasRecording) return null;
        
        log('Restoring session from:', data.fromUrl);
        return data;
      } catch (e) {
        // Ignore parse errors
      }
      return null;
    }
  };

  // ============================================================================
  // Message Handler
  // ============================================================================

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== Config.MESSAGE_SOURCE.CONTENT) return;

    const { type, payload } = event.data;
    log('Received from content:', type);
    
    switch (type) {
      case 'START_RECORDING':
        Recording.start(payload?.config);
        break;
      case 'STOP_RECORDING':
        Recording.stop();
        break;
      case 'GET_EVENTS':
        send('EVENTS_DATA', { events: State.events });
        break;
      default:
        log('Unknown message type:', type);
    }
  });

  // ============================================================================
  // Init
  // ============================================================================

  // Check for resume after redirect
  const saved = Navigation.restore();
  if (saved) {
    log('Resuming after redirect from:', saved.fromUrl);
    // Restore events if we have them, otherwise panel has them
    if (saved.events && saved.events.length) {
      State.events = saved.events;
      log('Restored', saved.events.length, 'events');
    }
    // Notify panel we're resuming
    send('RECORDING_RESUMED', { fromUrl: saved.fromUrl, eventCount: State.events.length });
    setTimeout(() => Recording.start(saved.config), 100);
  }

  // Signal ready
  send('INJECTED_READY', {
    hasRrweb: typeof rrweb !== 'undefined',
    hasConsolePlugin: typeof rrwebConsoleRecord !== 'undefined',
    version: Config.VERSION,
    resumed: !!saved
  });

  log(`Ready v${Config.VERSION}, rrweb: ${typeof rrweb !== 'undefined'}, consolePlugin: ${typeof rrwebConsoleRecord !== 'undefined'}`);

})();

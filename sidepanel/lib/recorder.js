/**
 * Recap - Recorder Module (ESM)
 * Leverages rrweb's built-in features for recording
 * @version 3.0.0
 */

import { Log } from './core.js';

// ============================================================================
// RRWEB FEATURE REFERENCE
// ============================================================================
// 
// We leverage these BUILT-IN rrweb features:
//
// MASKING (PII Protection):
// - maskInputOptions: { password: true, email: true, ... } - mask by input type
// - maskInputFn: (text, element) => masked - custom masking function
// - maskTextSelector: CSS selector for text nodes to mask
// - maskAllInputs: boolean - mask all inputs
//
// IGNORING (Size Reduction):
// - ignoreSelector: CSS selector for elements to completely ignore
// - blockSelector: CSS selector for elements to block (show placeholder)
// - blockClass: class name that blocks elements
// - ignoreClass: class name that ignores elements
//
// SAMPLING (Performance):
// - sampling.mousemove: number - sample rate for mouse moves
// - sampling.scroll: number - sample rate for scrolls  
// - sampling.input: 'all' | 'last' - how to record input events
// - sampling.mouseInteraction: boolean - capture mouse interactions
//
// SLIM DOM (Size Reduction):
// - slimDOMOptions: { script: true, comment: true, ... }
//
// PLUGINS:
// - rrwebConsolePlugin - capture console logs
// - getRecordNetworkPlugin - capture network requests
//
// ============================================================================

// ============================================================================
// STATE
// ============================================================================

let stopFn = null;
let isRecording = false;
let events = [];
let startTime = null;
let eventCallback = null;
let activeTabId = null;

// ============================================================================
// EXTENSION MESSAGING
// ============================================================================

const Messaging = {
  /**
   * Check if we're in extension context
   */
  get isExtension() {
    return typeof chrome !== 'undefined' && chrome.tabs && chrome.runtime;
  },

  /**
   * Get active tab ID
   */
  async getActiveTab() {
    if (!this.isExtension) return null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTabId = tab?.id;
      return activeTabId;
    } catch (e) {
      Log.error('Failed to get active tab:', e);
      return null;
    }
  },

  /**
   * Send message to content script
   */
  async sendToTab(type, data = {}) {
    if (!activeTabId) {
      await this.getActiveTab();
    }
    if (!activeTabId) {
      Log.warn('No active tab');
      return null;
    }
    try {
      return await chrome.tabs.sendMessage(activeTabId, { type, ...data });
    } catch (e) {
      Log.error('sendToTab failed:', e);
      return null;
    }
  },

  /**
   * Listen for messages from content script
   */
  onMessage(callback) {
    if (!this.isExtension) return;
    Log.debug('Setting up chrome.runtime.onMessage listener');
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      Log.debug('>>> Received message:', message?.type, 'from:', sender?.tab?.id || 'extension');
      callback(message, sender);
      sendResponse({ received: true });
      return true;
    });
  }
};

// ============================================================================
// RECORDER
// ============================================================================

export const Recorder = {
  /**
   * Check if rrweb is available (direct mode)
   */
  get isAvailable() {
    return typeof rrweb !== 'undefined' && typeof rrweb.record === 'function';
  },

  /**
   * Check if we're in extension context
   */
  get isExtension() {
    return Messaging.isExtension;
  },

  /**
   * Check if currently recording
   */
  get isRecording() {
    return isRecording;
  },

  /**
   * Get current events
   */
  get events() {
    return events;
  },

  /**
   * Set event callback (called for each event)
   */
  set onEvent(fn) {
    eventCallback = fn;
  },

  /**
   * Initialize - get active tab if in extension
   */
  async init() {
    Log.debug('Recorder.init() - isExtension:', Messaging.isExtension);
    
    if (Messaging.isExtension) {
      const tabId = await Messaging.getActiveTab();
      Log.debug('Active tab ID:', tabId);
      
      // Listen for events from content script
      Messaging.onMessage((message, sender) => {
        Log.debug('Message:', message.type);
        
        if (message.type === 'RRWEB_EVENT') {
          const event = message.event || message.payload?.event;
          if (event && isRecording) {
            events.push(event);
            Log.debug('Events:', events.length);
            if (eventCallback) eventCallback(event);
          }
        }
        
        if (message.type === 'RECORDING_STARTED') {
          Log.info('Recording started');
          isRecording = true;
        }
        
        if (message.type === 'RECORDING_RESUMED') {
          Log.info('Recording resumed on new page:', message.url);
          isRecording = true;
          
          // Add navigation event
          const navEvent = {
            type: 5,
            timestamp: Date.now(),
            data: { tag: 'page_navigation', payload: { url: message.url } }
          };
          events.push(navEvent);
          if (eventCallback) eventCallback(navEvent);
        }
        
        if (message.type === 'RECORDING_STOPPED') {
          Log.info('Recording stopped, events:', message.events?.length);
        }
      });
      
      Log.debug('Message listener set up');
    }
  },
  
  /**
   * Start recording with rrweb options
   * 
   * @param {Object} config - Configuration object with field settings
   * @returns {boolean|Promise<boolean>} Success
   */
  async start(config = {}) {
    if (isRecording) {
      Log.warn('Already recording');
      return false;
    }

    events = [];
    startTime = Date.now();

    // Build rrweb options from config - USING BUILT-IN FEATURES
    const rrwebOptions = this.buildRrwebOptions(config);
    
    Log.info('Starting recording with rrweb options:', {
      maskTextSelector: rrwebOptions.maskTextSelector ? 'set' : 'none',
      ignoreSelector: rrwebOptions.ignoreSelector ? 'set' : 'none',
      sampling: rrwebOptions.sampling
    });

    // EXTENSION MODE: Send to content script
    if (Messaging.isExtension) {
      try {
        const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        
        const response = await Messaging.sendToTab('START_RECORDING', { 
          options: rrwebOptions,
          sessionId
        });
        
        if (response?.success) {
          isRecording = true;
          Log.info('Recording started, sessionId:', sessionId);
          return true;
        } else {
          Log.error('Failed to start:', response?.error);
          return false;
        }
      } catch (e) {
        Log.error('Failed to start recording:', e);
        return false;
      }
    }

    // DIRECT MODE: Use rrweb directly (for browser testing)
    if (!this.isAvailable) {
      Log.error('rrweb not available');
      return false;
    }

    try {
      stopFn = rrweb.record({
        emit: (event, isCheckout) => {
          events.push(event);
          if (eventCallback) eventCallback(event, isCheckout);
        },
        ...rrwebOptions
      });

      isRecording = true;
      Log.info('Recording started (direct mode)');
      return true;

    } catch (e) {
      Log.error('Failed to start recording:', e);
      return false;
    }
  },

  /**
   * Stop recording
   * 
   * @returns {Object|Promise<Object>} { events, duration_ms }
   */
  async stop() {
    if (!isRecording) {
      Log.warn('Not recording');
      return null;
    }

    const duration = Date.now() - startTime;

    // EXTENSION MODE: Stop recording on content script
    // IMPORTANT: We use OUR accumulated events (from all pages), not content script's
    if (Messaging.isExtension) {
      try {
        // Tell content script to stop (we don't use its events response)
        await Messaging.sendToTab('STOP_RECORDING');
        
        isRecording = false;
        startTime = null;
        
        // Return OUR events array which has events from ALL pages (Form A + Form B)
        Log.info(`Recording stopped: ${events.length} events, ${duration}ms`);
        return { events: [...events], duration_ms: duration };
        
      } catch (e) {
        Log.error('Failed to stop recording via extension:', e);
        isRecording = false;
        return { events: [...events], duration_ms: duration };
      }
    }

    // DIRECT MODE
    try {
      if (stopFn) {
        stopFn();
        stopFn = null;
      }

      isRecording = false;
      startTime = null;

      Log.info(`Recording stopped (direct): ${events.length} events, ${duration}ms`);
      return { events: [...events], duration_ms: duration };

    } catch (e) {
      Log.error('Error stopping recording:', e);
      isRecording = false;
      return null;
    }
  },

  /**
   * Build rrweb options from config - LEVERAGING BUILT-IN FEATURES
   * 
   * PRIVACY-FIRST APPROACH:
   * - maskAllInputs: true - ALL inputs masked by default
   * - maskInputFn: selectively UNMASK fields marked as "clear"
   */
  buildRrwebOptions(config = {}) {
    const clear = config.fields?.clear || [];  // Fields to NOT mask
    const ignored = config.fields?.ignored || [];
    const steps = config.fields?.steps || [];  // Journey milestones

    // Build CSS selectors
    const clearSelectors = clear.map(f => f.selector).filter(Boolean);
    const ignoreSelectors = ignored.map(f => f.selector).filter(Boolean);
    const stepSelectors = steps.map(f => f.selector).filter(Boolean);

    return {
      // ==========================================
      // STEP TRACKING - via rrweb custom events
      // ==========================================
      stepSelectors,  // Passed to injected.js for addCustomEvent

      // ==========================================
      // MASKING - rrweb built-in (PRIVACY-FIRST)
      // ==========================================
      
      // MASK ALL INPUTS BY DEFAULT
      maskAllInputs: true,
      
      // Mask input options - reinforce password masking
      maskInputOptions: {
        password: true,  // Always mask passwords even if in clear list
        ...config.maskInputOptions
      },
      
      // Custom function to UNMASK specific fields (those marked as "clear")
      maskInputFn: (text, element) => {
        // Passwords are NEVER unmasked
        if (element?.type === 'password') {
          return '••••••••';
        }
        
        // Check if element is in the "clear" list (should NOT be masked)
        if (element && clearSelectors.length > 0) {
          const shouldClear = clearSelectors.some(sel => {
            try { return element.matches(sel); } catch { return false; }
          });
          if (shouldClear) {
            return text; // Return original value (unmasked)
          }
        }
        
        // Everything else is masked
        return '••••••••';
      },

      // ==========================================
      // IGNORING - rrweb built-in
      // ==========================================
      
      // Completely ignore these elements (not recorded at all)
      ignoreSelector: ignoreSelectors.length 
        ? ignoreSelectors.join(', ') 
        : null,
      
      // Block these elements (recorded as placeholder)
      blockSelector: config.blockSelector || '.ads, .chat-widget, [data-norecord]',
      
      // Ignore by class
      ignoreClass: 'recap-ignore',

      // ==========================================
      // SAMPLING - rrweb built-in
      // ==========================================
      
      sampling: {
        mousemove: 50,           // Sample every 50ms
        mouseInteraction: true,  // Capture clicks, hovers
        scroll: 150,             // Sample every 150ms
        input: 'last',           // Only record last input value
        ...config.sampling
      },

      // ==========================================
      // SLIM DOM - rrweb built-in (size reduction)
      // ==========================================
      
      slimDOMOptions: {
        script: true,                // Remove script contents
        comment: true,               // Remove comments
        headFavicon: true,           // Remove favicons
        headWhitespace: true,        // Remove head whitespace
        headMetaSocial: true,        // Remove social meta tags
        headMetaRobots: true,        // Remove robot meta tags
        headMetaHttpEquiv: true,     // Remove http-equiv meta
        headMetaAuthorship: true,    // Remove author meta
        headMetaVerification: true,  // Remove verification meta
        ...config.slimDOMOptions
      },

      // ==========================================
      // OTHER OPTIONS
      // ==========================================
      
      checkoutEveryNms: config.checkoutEveryNms || 10000,
      inlineStylesheet: true,
      recordCanvas: false,
      collectFonts: false
    };
  },

  /**
   * Get the rrweb mirror (for node lookups)
   */
  getMirror() {
    return rrweb.record?.mirror || null;
  }
};

// ============================================================================
// EVENT PARSER - Uses rrweb event types
// ============================================================================

export const EventParser = {
  // rrweb event types
  TYPES: {
    DOM_CONTENT_LOADED: 0,
    LOAD: 1,
    FULL_SNAPSHOT: 2,
    INCREMENTAL_SNAPSHOT: 3,
    META: 4,
    CUSTOM: 5,
    PLUGIN: 6
  },

  // Incremental snapshot sources
  SOURCES: {
    MUTATION: 0,
    MOUSE_MOVE: 1,
    MOUSE_INTERACTION: 2,
    SCROLL: 3,
    VIEWPORT_RESIZE: 4,
    INPUT: 5,
    TOUCH_MOVE: 6,
    MEDIA_INTERACTION: 7,
    STYLE_SHEET_RULE: 8,
    CANVAS_MUTATION: 9,
    FONT: 10,
    LOG: 11,
    DRAG: 12,
    STYLE_DECLARATION: 13,
    SELECTION: 14
  },

  // Mouse interaction types
  MOUSE_TYPES: {
    0: 'mouseup', 1: 'mousedown', 2: 'click', 3: 'contextmenu',
    4: 'dblclick', 5: 'focus', 6: 'blur', 7: 'touchstart',
    8: 'touchmove', 9: 'touchend', 10: 'touchcancel'
  },

  /**
   * Parse event for UI display
   */
  parse(event) {
    if (!event) return null;

    switch (event.type) {
      case this.TYPES.FULL_SNAPSHOT:
        return { icon: '📷', name: 'snapshot', type: 'snapshot' };
      
      case this.TYPES.META:
        return { icon: 'ℹ️', name: 'meta', type: 'meta' };
      
      case this.TYPES.INCREMENTAL_SNAPSHOT:
        return this.parseIncremental(event);
      
      case this.TYPES.CUSTOM:
        const tag = event.data?.tag;
        if (tag === 'page_navigation') {
          return { icon: '🔀', name: 'navigation', type: 'navigation', label: event.data?.payload?.url };
        }
        return { icon: '🏷️', name: tag || 'custom', type: 'custom' };
      
      default:
        return null;
    }
  },

  parseIncremental(event) {
    const source = event.data?.source;

    switch (source) {
      case this.SOURCES.INPUT:
        return {
          icon: '⌨️',
          name: 'input',
          type: 'input',
          nodeId: event.data?.id,
          value: event.data?.text,
          label: event.data?.text ? `"${event.data.text.slice(0, 15)}${event.data.text.length > 15 ? '...' : ''}"` : null
        };

      case this.SOURCES.MOUSE_INTERACTION:
        const mouseType = event.data?.type;
        const interactionType = this.MOUSE_TYPES[mouseType] || 'interaction';
        
        // Only return click, focus, blur - skip mouseup/mousedown noise
        if (![2, 5, 6].includes(mouseType)) return null; // 2=click, 5=focus, 6=blur
        
        return {
          icon: interactionType === 'click' ? '🖱️' : (interactionType === 'focus' ? '🎯' : '💨'),
          name: interactionType,
          type: interactionType,
          nodeId: event.data?.id
        };

      case this.SOURCES.SCROLL:
        return null; // Skip scroll events in live display

      case this.SOURCES.MUTATION:
        return null; // Skip mutation events in live display

      default:
        return null;
    }
  },

  /**
   * Extract field info from events and snapshot
   */
  extractFields(events) {
    const fields = new Map();
    const snapshot = events.find(e => e.type === this.TYPES.FULL_SNAPSHOT);
    
    if (!snapshot?.data?.node) return [];

    // Build node map from snapshot
    const nodeMap = new Map();
    this.traverseNode(snapshot.data.node, nodeMap);

    // Find interactive nodes from events
    for (const event of events) {
      if (event.type !== this.TYPES.INCREMENTAL_SNAPSHOT) continue;

      const nodeId = event.data?.id;
      if (!nodeId || fields.has(nodeId)) continue;

      const snapshotNode = nodeMap.get(nodeId);
      if (!snapshotNode) continue;

      const source = event.data?.source;

      // Input events
      if (source === this.SOURCES.INPUT) {
        fields.set(nodeId, this.buildFieldInfo(snapshotNode, 'input', event.data?.text));
      }

      // Click events
      if (source === this.SOURCES.MOUSE_INTERACTION && event.data?.type === 2) {
        fields.set(nodeId, this.buildFieldInfo(snapshotNode, 'click'));
      }
    }

    return [...fields.values()];
  },

  traverseNode(node, map) {
    if (node?.id) map.set(node.id, node);
    if (node?.childNodes) {
      for (const child of node.childNodes) {
        this.traverseNode(child, map);
      }
    }
  },

  buildFieldInfo(node, type, sampleValue = '') {
    const attrs = node.attributes || {};
    const tagName = (node.tagName || '').toLowerCase();

    // Determine if hidden
    const isHidden = this.checkHidden(node, attrs);
    
    // Check if should auto-ignore (decorative, UI chrome)
    const autoIgnore = this.shouldAutoIgnore(node, attrs);
    
    // Get text content - extract from child nodes for rrweb snapshots
    const textContent = this.extractTextContent(node).trim().slice(0, 50);
    
    // Determine action and reason
    let action = 'none';
    let source = 'user';
    let hiddenReason = null;
    
    if (isHidden) {
      action = 'ignore';
      source = 'auto';
      hiddenReason = this.getHiddenReason(node, attrs);
    } else if (autoIgnore.ignore) {
      action = 'ignore';
      source = 'auto';
      hiddenReason = autoIgnore.reason;
    }

    return {
      nodeId: node.id,
      type,
      tagName,
      selector: this.buildSelector(attrs, tagName),
      label: this.buildLabel(node, attrs),
      textContent: textContent,
      inputType: attrs.type || '',
      sampleValue,
      isHidden: isHidden || autoIgnore.ignore,
      hiddenReason,
      action,
      source
    };
  },
  
  // Extract text content from rrweb snapshot node (recursive)
  extractTextContent(node) {
    // If node has direct textContent property, use it
    if (node.textContent) {
      return node.textContent;
    }
    
    // For text nodes in rrweb format
    if (node.type === 3 && node.textContent) {
      return node.textContent;
    }
    
    // Recursively get text from child nodes
    if (node.childNodes && node.childNodes.length > 0) {
      let text = '';
      for (const child of node.childNodes) {
        // Text node (type 3 in rrweb)
        if (child.type === 3 && child.textContent) {
          text += child.textContent + ' ';
        }
        // Element node - recurse
        else if (child.childNodes) {
          text += this.extractTextContent(child) + ' ';
        }
      }
      return text.trim();
    }
    
    return '';
  },

  buildSelector(attrs, tagName) {
    if (attrs.id) return `#${attrs.id}`;
    if (attrs.name) return `[name="${attrs.name}"]`;
    if (attrs.class) {
      const firstClass = attrs.class.split(' ').filter(c => c)[0];
      if (firstClass) return `${tagName}.${firstClass}`;
    }
    return tagName;
  },

  buildLabel(node, attrs) {
    const tagName = (node.tagName || '').toLowerCase();
    
    // Try aria-label first (most explicit)
    if (attrs['aria-label']) return attrs['aria-label'];
    
    // For buttons/links, prioritize text content from children
    if (['button', 'a', 'submit'].includes(tagName) || attrs.type === 'submit' || attrs.type === 'button') {
      const text = this.extractTextContent(node).trim();
      if (text && text.length > 0) return text.slice(0, 40);
      if (attrs.value) return attrs.value;
      if (attrs.title) return attrs.title;
    }
    
    // For inputs, try label associations
    if (attrs.placeholder) return attrs.placeholder;
    if (attrs.title) return attrs.title;
    if (attrs.value && tagName === 'input') return `Value: ${attrs.value.slice(0, 20)}`;
    
    // Friendly name from name/id
    if (attrs.name) return this.humanize(attrs.name);
    if (attrs.id) return this.humanize(attrs.id);
    
    // For any element, try to get text content
    const textContent = this.extractTextContent(node).trim();
    if (textContent && textContent.length > 0) {
      return textContent.slice(0, 30);
    }
    
    // Fallback to text content from children
    const text = this.extractTextContent(node).trim();
    if (text && text.length > 0) return text.slice(0, 30);
    
    return tagName || 'Unknown';
  },
  
  // Convert camelCase/snake_case/kebab-case to Title Case
  humanize(str) {
    return str
      .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase
      .replace(/[-_]+/g, ' ')                // kebab/snake
      .replace(/\b\w/g, c => c.toUpperCase()) // Title Case
      .slice(0, 40);
  },

  checkHidden(node, attrs) {
    // Type hidden
    if (attrs.type === 'hidden') return true;
    
    // Hidden attribute
    if (attrs.hidden !== undefined) return true;
    
    // Aria hidden
    if (attrs['aria-hidden'] === 'true') return true;
    
    // Inline style checks
    const style = attrs.style || '';
    if (style.includes('display: none') || 
        style.includes('display:none') ||
        style.includes('visibility: hidden') || 
        style.includes('visibility:hidden') ||
        style.includes('opacity: 0') ||
        style.includes('opacity:0')) {
      return true;
    }
    
    // Common hidden class patterns
    const cls = attrs.class || '';
    if (/\b(hidden|hide|invisible|sr-only|visually-hidden|d-none)\b/i.test(cls)) {
      return true;
    }
    
    return false;
  },

  getHiddenReason(node, attrs) {
    if (attrs.type === 'hidden') return 'type=hidden';
    if (attrs.hidden !== undefined) return 'hidden attr';
    if (attrs['aria-hidden'] === 'true') return 'aria-hidden';
    
    const style = attrs.style || '';
    if (style.includes('display: none') || style.includes('display:none')) return 'display:none';
    if (style.includes('visibility: hidden') || style.includes('visibility:hidden')) return 'visibility:hidden';
    if (style.includes('opacity: 0') || style.includes('opacity:0')) return 'opacity:0';
    
    const cls = attrs.class || '';
    if (/\b(hidden|hide|invisible|sr-only|visually-hidden|d-none)\b/i.test(cls)) return 'hidden class';
    
    return 'hidden';
  },
  
  // Check if element should be auto-ignored (decorative, chrome, etc.)
  // NOTE: Buttons should NOT be auto-ignored - they are important interactions
  shouldAutoIgnore(node, attrs) {
    const tagName = (node.tagName || '').toLowerCase();
    const cls = attrs.class || '';
    const role = attrs.role || '';
    
    // NEVER auto-ignore buttons, links, or submit elements - they're important
    if (tagName === 'button' || tagName === 'a' || 
        attrs.type === 'submit' || attrs.type === 'button') {
      return { ignore: false };
    }
    
    // UI chrome patterns - icons, close buttons, etc. (but only for non-button elements)
    if (/\b(icon|close|dismiss|toggle|collapse|expand|caret|arrow|spinner|loader)\b/i.test(cls)) {
      return { ignore: true, reason: 'UI element' };
    }
    
    // Spans with icon-only content (no meaningful text)
    if (tagName === 'span') {
      const text = this.extractTextContent(node).trim();
      // Icons typically have single char or no text
      if (text.length <= 2 && !text.match(/\w/)) {
        return { ignore: true, reason: 'icon/decorative' };
      }
    }
    
    // Common non-interactive patterns
    if (role === 'presentation' || role === 'none') {
      return { ignore: true, reason: 'decorative role' };
    }
    
    return { ignore: false };
  }
};

// ============================================================================
// FIELD DETECTOR - Auto-detect masking/ignoring
// ============================================================================

export const FieldDetector = {
  // Patterns for sensitive fields that should be masked
  SENSITIVE_PATTERNS: [
    /password/i, /credit.?card/i, /card.?number/i, /cvv/i, /cvc/i,
    /ssn/i, /social.?security/i, /pin/i, /secret/i, /otp/i, /token/i,
    /account.?number/i, /routing.?number/i, /bank/i
  ],

  // Patterns for buttons that should be auto-marked as steps (journey milestones)
  STEP_PATTERNS: [
    /\b(next|continue|proceed|submit|confirm|complete|finish|done)\b/i,
    /\b(sign.?up|register|create|apply|start|begin)\b/i,
    /\b(save|update|send|verify|validate)\b/i,
    /\b(checkout|pay|order|book|reserve)\b/i,
    />>|→|▶/  // Arrow indicators
  ],

  /**
   * Auto-detect which fields should be masked
   * PRIVACY-FIRST: All input fields are masked by default!
   * Users can explicitly mark fields as "clear" (don't mask) if needed
   */
  autoDetectMasked(fields) {
    return fields.map(field => {
      // Skip if already has an action assigned
      if (field.action !== 'none') return field;
      
      // Only auto-mask input fields (text inputs, textareas, etc.)
      if (field.type !== 'input') return field;
      
      // Mark ALL inputs as masked by default (privacy-first)
      return { ...field, action: 'mask', source: 'auto' };
    });
  },

  /**
   * Auto-detect which buttons should be marked as steps (journey milestones)
   */
  autoDetectSteps(fields) {
    return fields.map(field => {
      // Only auto-mark buttons/clicks that haven't been assigned an action
      if (field.action !== 'none') return field;
      if (field.type !== 'click') return field;
      
      // Check if button label matches step patterns
      const label = field.label || field.textContent || '';
      const isStep = this.STEP_PATTERNS.some(p => p.test(label));
      
      if (isStep) {
        return { ...field, action: 'step', source: 'auto' };
      }
      return field;
    });
  },

  /**
   * Process fields with auto-detection
   */
  processFields(events) {
    let fields = EventParser.extractFields(events);
    fields = this.autoDetectMasked(fields);
    fields = this.autoDetectSteps(fields);  // Auto-mark steps
    return fields;
  }
};


/**
 * Recap - Core Module
 * Foundational utilities: DOM, State, Toast, Modal, Messaging
 * @version 1.0.0
 */

'use strict';

// ============================================================================
// CONSTANTS
// ============================================================================

const RecapConfig = {
  VERSION: '3.1.0',
  DEBUG: true,
  CONFIG_VERSION: '1.0.0'
};

const MessageTypes = Object.freeze({
  START_RECORDING: 'START_RECORDING',
  STOP_RECORDING: 'STOP_RECORDING',
  GET_FORM_INFO: 'GET_FORM_INFO',
  GET_EVENTS: 'GET_EVENTS',
  RRWEB_STATUS: 'RRWEB_STATUS',
  RECORDING_STARTED: 'RECORDING_STARTED',
  RECORDING_STOPPED: 'RECORDING_STOPPED',
  RECORDING_ERROR: 'RECORDING_ERROR',
  RRWEB_EVENT: 'RRWEB_EVENT',
  TIMELINE_EVENT: 'TIMELINE_EVENT'
});

const EventTypes = Object.freeze({
  ALL: 'all', INPUT: 'input', CLICK: 'click',
  NETWORK: 'network', ERROR: 'error', SESSION: 'session',
  FOCUS: 'focus', BLUR: 'blur', SCROLL: 'scroll',
  MUTATION: 'mutation', NAVIGATION: 'navigation'
});

// Events shown in timeline by default
const VisibleEvents = new Set([
  'input', 'click', 'network', 'error', 'session', 'navigation', 'submit'
]);

// Technical events hidden by default
const HiddenEvents = new Set([
  'focus', 'blur', 'scroll', 'mutation', 'viewport', 'meta', 'dom'
]);

// ============================================================================
// DOM UTILITIES
// ============================================================================

const DOM = {
  $(id) { return document.getElementById(id); },
  $$(sel, ctx = document) { return ctx.querySelectorAll(sel); },

  escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  },

  escapeAttr(str) {
    return String(str || '').replace(/[&'"<>]/g, c => ({
      '&': '&amp;', "'": '&#39;', '"': '&quot;', '<': '&lt;', '>': '&gt;'
    })[c]);
  },

  truncate(str, len) {
    return str?.length > len ? str.slice(0, len) + '...' : str || '';
  },

  formatTime(ms) {
    const secs = Math.floor(ms / 1000);
    return `${Math.floor(secs / 60).toString().padStart(2, '0')}:${(secs % 60).toString().padStart(2, '0')}`;
  },
  
  formatDuration(ms) {
    const secs = Math.round(ms / 1000);
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`;
  }
};

// ============================================================================
// STATE MANAGEMENT (Singleton)
// ============================================================================

const State = {
  // Mode
  currentMode: 'trainer',

  // Trainer state
  isRecording: false,
  recordingStartTime: null,
  recordingTimer: null,
  events: [],          // Timeline events
  rrwebEvents: [],     // Raw rrweb events
  activeTabId: null,
  activeFilter: EventTypes.ALL,
  showAllEvents: false,
  replayPlayer: null,
  ignoredFields: new Map(),

  // Tester state
  testerConfig: null,
  testerRecording: false,
  testerSessions: [],
  
  // Library state
  libraryConfigs: [],
  libraryRecordings: [],

  // Config
  config: {
    formId: '',
    formName: '',
    pathPattern: '',
    samplingRate: 0.25,
    masking: { selectors: [], maskAllInputs: false },
    network: { scrubKeys: [], stripHeaders: ['Authorization', 'Cookie'] },
    journey: { steps: [], successSelector: null },
    options: { captureConsole: true },
    ignored: { selectors: [] }
  },

  reset() {
    this.events = [];
    this.rrwebEvents = [];
    this.replayPlayer = null;
    this.ignoredFields.clear();
    this.config.masking.selectors = [];
    this.config.network.scrubKeys = [];
    this.config.journey.steps = [];
    this.config.journey.successSelector = null;
    this.config.ignored.selectors = [];
  }
};

// ============================================================================
// TOAST NOTIFICATIONS
// ============================================================================

const Toast = {
  show(message, type = 'success') {
    const container = DOM.$('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 200);
    }, 2500);
  },

  success(msg) { this.show(msg, 'success'); },
  error(msg) { this.show(msg, 'error'); },
  info(msg) { this.show(msg, 'info'); }
};

// ============================================================================
// MODAL SYSTEM
// ============================================================================

const Modal = {
  show(id) {
    const modal = DOM.$(id);
    if (modal) modal.style.display = 'flex';
  },

  hide(id) {
    const modal = DOM.$(id);
    if (modal) {
      modal.style.display = 'none';
      // Clean up player containers
      const playerContainers = ['fullscreen-player-container', 'session-player-container'];
      playerContainers.forEach(cid => {
        const container = DOM.$(cid);
        if (container && modal.contains(container)) container.innerHTML = '';
      });
    }
  },

  hideAll() {
    DOM.$$('.modal').forEach(m => this.hide(m.id));
  },

  content(title, body, actions = []) {
    const modal = DOM.$('event-modal');
    if (!modal) return;

    DOM.$('modal-title').textContent = title;
    DOM.$('modal-body').innerHTML = body;
    DOM.$('modal-actions').innerHTML = actions.map(a =>
      `<button class="btn ${a.class || 'btn-ghost'}" id="${a.id}">${a.label}</button>`
    ).join('');

    this.show('event-modal');

    actions.forEach(a => {
      DOM.$(a.id)?.addEventListener('click', () => {
        if (a.handler) a.handler();
        if (a.close !== false) this.hide('event-modal');
      });
    });
  }
};

// ============================================================================
// CHROME MESSAGING
// ============================================================================

const Messaging = {
  async sendToTab(type, payload = {}) {
    if (!State.activeTabId) throw new Error('No active tab');
    return chrome.tabs.sendMessage(State.activeTabId, { type, payload });
  },

  async sendToRuntime(type, payload = {}) {
    return chrome.runtime.sendMessage({ type, payload });
  },

  onMessage(handler) {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      handler(msg, sender, respond);
      return true;
    });
  }
};

// ============================================================================
// LOGGING
// ============================================================================

const Log = {
  debug(...args) {
    if (RecapConfig.DEBUG) console.log('[Recap]', ...args);
  },
  info(...args) {
    console.log('[Recap]', ...args);
  },
  warn(...args) {
    console.warn('[Recap]', ...args);
  },
  error(...args) {
    console.error('[Recap]', ...args);
  }
};

// Export for other modules
window.Recap = window.Recap || {};
Object.assign(window.Recap, {
  Config: RecapConfig,
  MessageTypes,
  EventTypes,
  VisibleEvents,
  HiddenEvents,
  DOM,
  State,
  Toast,
  Modal,
  Messaging,
  Log
});



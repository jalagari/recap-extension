/**
 * Recap SDK v3.2.0 - ESM Module
 * 
 * Auto-init:
 * <script type="module" src="https://your-worker.dev/sdk/recap.js"></script>
 * 
 * Import:
 * import { RecapSDK, RecapPlayer } from 'https://your-worker.dev/sdk/recap.js';
 * 
 * @module RecapSDK
 */

// =============================================================================
// CONSTANTS
// =============================================================================

const VERSION = '3.2.0';
const RRWEB_CDN = 'https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.17/dist/rrweb.min.js';
const RRWEB_PLAYER_CDN = 'https://cdn.jsdelivr.net/npm/rrweb-player@2.0.0-alpha.17/dist/index.js';
const RRWEB_PLAYER_CSS = 'https://cdn.jsdelivr.net/npm/rrweb-player@2.0.0-alpha.17/dist/style.css';

const API_BASE = (() => {
  try {
    return new URL(import.meta.url).origin;
  } catch {
    return 'http://localhost:8787';
  }
})();

// =============================================================================
// STATE
// =============================================================================

const state = {
  initialized: false,
  recording: false,
  debug: false,
  sessionId: null,
  startTime: null,
  events: [],
  config: null,
  quality: {
    score: 0,
    signals: { jsErrors: 0, networkErrors: 0, rageClicks: 0, deadClicks: 0 }
  }
};

let stopFn = null;
let abortController = null;
let clickHistory = [];

// =============================================================================
// UTILITIES
// =============================================================================

const log = (...args) => 
  state.debug && console.log('%c[Recap]', 'color:#6366f1;font-weight:bold', ...args);

const error = (...args) => 
  console.error('[Recap]', ...args);

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url.split('?')[0].split('#')[0];
  }
}

function generateSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// =============================================================================
// LOADERS
// =============================================================================

async function loadRrweb() {
  if (typeof rrweb !== 'undefined' && typeof rrweb.record === 'function') return true;
  log('Loading rrweb...');
  return loadScript(RRWEB_CDN);
}

async function loadRrwebPlayer() {
  if (typeof rrwebPlayer !== 'undefined') return true;
  
  if (!document.querySelector(`link[href="${RRWEB_PLAYER_CSS}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = RRWEB_PLAYER_CSS;
    document.head.appendChild(link);
  }
  
  return loadScript(RRWEB_PLAYER_CDN);
}

function loadScript(src) {
  return new Promise(resolve => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => { log('Loaded:', src); resolve(true); };
    script.onerror = () => { error('Failed:', src); resolve(false); };
    document.head.appendChild(script);
  });
}

// =============================================================================
// CONFIG
// =============================================================================

async function fetchConfigByUrl(pageUrl) {
  const url = normalizeUrl(pageUrl);
  log('Looking for config:', url);
  
  try {
    const res = await fetch(`${API_BASE}/api/configs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const { configs } = await res.json();
    
    for (const cfg of configs) {
      const pattern = normalizeUrl(cfg.url_pattern);
      if (url === pattern || 
          url.startsWith(pattern.replace('*', '')) ||
          (pattern.includes('*') && new RegExp('^' + pattern.replace(/\*/g, '.*') + '$').test(url))) {
        const fullRes = await fetch(`${API_BASE}/api/configs/${cfg.id}`);
        if (fullRes.ok) {
          const config = await fullRes.json();
          log('Found config:', config.name);
          return config;
        }
      }
    }
    
    log('No config found');
    return null;
  } catch (e) {
    error('Fetch failed:', e.message);
    return null;
  }
}

// =============================================================================
// RECORDING
// =============================================================================

function buildRrwebOptions(config = {}) {
  const clearSelectors = config?.fields?.clear?.map(f => f.selector) || [];

  return {
    emit: (event) => state.events.push(event),
    maskAllInputs: true,
    maskInputOptions: { password: true },
    maskInputFn: (text, el) => {
      if (el?.type === 'password') return '••••••••';
      if (clearSelectors.some(s => el?.matches?.(s))) return text;
      return '••••••••';
    },
    ignoreSelector: config?.fields?.ignored?.map(f => f.selector).join(',') || null,
    sampling: config?.rrweb_options?.sampling || { mousemove: 50, scroll: 150, input: 'last' },
    slimDOMOptions: { script: true, comment: true },
    checkoutEveryNms: 10000
  };
}

function startRecording(config = null) {
  if (!state.initialized || state.recording) return false;

  if (config) state.config = config;
  
  state.sessionId = generateSessionId();
  state.startTime = Date.now();
  state.events = [];
  state.quality = { score: 0, signals: { jsErrors: 0, networkErrors: 0, rageClicks: 0, deadClicks: 0 } };

  log('Recording:', state.sessionId);
  stopFn = rrweb.record(buildRrwebOptions(state.config));
  state.recording = true;
  
  return true;
}

function stopRecording() {
  if (!state.recording) return null;

  log('Stopping...');
  if (stopFn) { stopFn(); stopFn = null; }
  stopDetectors();
  state.recording = false;

  return {
    sessionId: state.sessionId,
    eventCount: state.events.length,
    duration: Date.now() - state.startTime,
    quality: { ...state.quality }
  };
}

// =============================================================================
// QUALITY DETECTION
// =============================================================================

function startDetectors() {
  abortController = new AbortController();
  const { signal } = abortController;

  // JS Errors
  window.addEventListener('error', (e) => {
    if (e.filename?.includes('extension://')) return;
    state.quality.signals.jsErrors++;
    recalculateScore();
    log('JS Error:', e.message);
  }, { signal });

  window.addEventListener('unhandledrejection', () => {
    state.quality.signals.jsErrors++;
    recalculateScore();
  }, { signal });

  // Click tracking
  document.addEventListener('click', (e) => {
    // Rage clicks
    const now = Date.now();
    clickHistory.push({ x: e.clientX, y: e.clientY, time: now });
    clickHistory = clickHistory.filter(c => now - c.time < 1000);

    if (clickHistory.length >= 3) {
      const first = clickHistory[0];
      if (clickHistory.every(c => Math.abs(c.x - first.x) < 50 && Math.abs(c.y - first.y) < 50)) {
        state.quality.signals.rageClicks++;
        clickHistory = [];
        recalculateScore();
        log('Rage click!');
      }
    }

    // Dead clicks
    if (!e.target.closest('a,button,input,select,textarea,[role="button"],[onclick]')) {
      state.quality.signals.deadClicks++;
      recalculateScore();
    }
  }, { signal, capture: true });

  log('Detectors ready');
}

function stopDetectors() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  clickHistory = [];
}

function recalculateScore() {
  const w = state.config?.sessionQuality?.weights || { jsError: 40, networkError: 40, rageClick: 25, deadClick: 10 };
  const s = state.quality.signals;
  state.quality.score = s.jsErrors * w.jsError + s.networkErrors * w.networkError + 
                        s.rageClicks * w.rageClick + s.deadClicks * w.deadClick;
}

// =============================================================================
// TRANSPORT
// =============================================================================

function buildPayload(extra = {}) {
  return {
    session_id: state.sessionId,
    config_id: state.config?.id,
    form_name: state.config?.name || document.title,
    events: state.events,
    event_count: state.events.length,
    duration_ms: Date.now() - state.startTime,
    timestamp: new Date().toISOString(),
    quality: state.quality,
    metadata: { url: location.href, user_agent: navigator.userAgent, sdk_version: VERSION },
    ...extra
  };
}

function setupAutoUpload() {
  const upload = () => {
    if (!state.recording || state.events.length < 10) return;
    const blob = new Blob([JSON.stringify(buildPayload())], { type: 'application/json' });
    navigator.sendBeacon(`${API_BASE}/api/recordings`, blob);
    log('Auto-uploaded');
  };

  window.addEventListener('beforeunload', upload);
  window.addEventListener('pagehide', upload);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') upload();
  });
}

async function uploadRecording(extra = {}) {
  try {
    const res = await fetch(`${API_BASE}/api/recordings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(extra))
    });
    log('Uploaded:', res.ok);
    return res.ok;
  } catch (e) {
    error('Upload failed:', e.message);
    return false;
  }
}

// =============================================================================
// REPORT UI
// =============================================================================

function createReportButton() {
  const mode = state.config?.sessionQuality?.reportButton?.mode || 'on_error';
  if (mode === 'disabled') return;

  const btn = document.createElement('button');
  btn.id = 'recap-report-btn';
  btn.innerHTML = '🐛 Report Issue';
  btn.style.cssText = `
    position:fixed;bottom:20px;right:20px;padding:10px 16px;
    background:#ef4444;color:white;border:none;border-radius:8px;
    font:500 14px system-ui,sans-serif;cursor:pointer;z-index:99999;
    box-shadow:0 4px 12px rgba(0,0,0,0.15);
    display:${mode === 'always' ? 'block' : 'none'};transition:transform 0.2s;
  `;
  
  btn.onmouseover = () => btn.style.transform = 'scale(1.05)';
  btn.onmouseout = () => btn.style.transform = 'scale(1)';
  btn.onclick = showReportModal;
  
  document.body.appendChild(btn);

  if (mode === 'on_error') {
    const threshold = state.config?.sessionQuality?.thresholds?.review || 50;
    setInterval(() => {
      if (state.quality.score >= threshold) btn.style.display = 'block';
    }, 2000);
  }
}

function showReportModal() {
  const overlay = document.createElement('div');
  overlay.id = 'recap-modal';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.5);
    z-index:100000;display:flex;align-items:center;justify-content:center;
  `;
  overlay.innerHTML = `
    <div style="background:white;padding:24px;border-radius:12px;max-width:400px;width:90%;font-family:system-ui,sans-serif">
      <h3 style="margin:0 0 16px;font-size:18px">Report an Issue</h3>
      <select id="recap-cat" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:12px">
        <option value="bug">Bug / Error</option>
        <option value="confusion">Confusing UI</option>
        <option value="slow">Slow / Performance</option>
        <option value="other">Other</option>
      </select>
      <textarea id="recap-cmt" rows="3" placeholder="What went wrong?" 
        style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:16px"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="recap-x" style="padding:8px 16px;background:#f3f4f6;border:none;border-radius:6px;cursor:pointer">Cancel</button>
        <button id="recap-ok" style="padding:8px 16px;background:#6366f1;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:500">Submit</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  
  document.getElementById('recap-x').onclick = () => overlay.remove();
  document.getElementById('recap-ok').onclick = async () => {
    const category = document.getElementById('recap-cat').value;
    const comment = document.getElementById('recap-cmt').value;
    
    stopRecording();
    const ok = await uploadRecording({ user_report: { category, comment, timestamp: new Date().toISOString() } });
    
    overlay.remove();
    showNotification(ok ? 'Thank you! Feedback submitted.' : 'Failed to submit.', ok ? 'success' : 'error');
  };
}

function showNotification(message, type) {
  const div = document.createElement('div');
  div.style.cssText = `
    position:fixed;top:20px;right:20px;padding:12px 20px;
    background:${type === 'success' ? '#22c55e' : '#ef4444'};
    color:white;border-radius:8px;font:14px system-ui,sans-serif;
    z-index:100001;box-shadow:0 4px 12px rgba(0,0,0,0.15);
  `;
  div.textContent = message;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 3000);
}

// =============================================================================
// PLAYER
// =============================================================================

export const RecapPlayer = {
  async play(container, events, options = {}) {
    if (!await loadRrwebPlayer()) {
      error('Failed to load player');
      return null;
    }

    if (typeof container === 'string') container = document.querySelector(container);
    if (!container) { error('Container not found'); return null; }
    
    container.innerHTML = '';

    return new rrwebPlayer({
      target: container,
      props: {
        events,
        width: options.width || container.clientWidth || 800,
        height: options.height || container.clientHeight || 600,
        autoPlay: options.autoPlay ?? true,
        showController: options.showController ?? true,
        mouseTail: options.mouseTail ?? false,
        ...options
      }
    });
  },

  async playFromRecording(container, id, options = {}) {
    try {
      const res = await fetch(`${API_BASE}/api/recordings/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const recording = await res.json();
      return this.play(container, recording.events, options);
    } catch (e) {
      error('Failed to load recording:', e.message);
      return null;
    }
  }
};

// =============================================================================
// MAIN SDK API
// =============================================================================

export const RecapSDK = {
  VERSION,
  API_BASE,
  
  async init(options = {}) {
    if (state.initialized) return;

    state.debug = options.debug ?? false;
    log(`Recap SDK v${VERSION}`);
    log('API:', API_BASE);

    state.config = options.config || await fetchConfigByUrl(location.href);
    
    if (!state.config) {
      log('No config. Inactive.');
      return;
    }

    const rate = state.config?.settings?.sampling_rate ?? 0.25;
    if (Math.random() > rate) {
      log('Not sampled (', rate, ')');
      return;
    }

    if (!await loadRrweb()) {
      error('Failed to load rrweb');
      return;
    }

    state.initialized = true;
    this.start();
  },

  start(config = null) {
    if (!startRecording(config)) return false;
    
    if (state.config?.sessionQuality?.enabled !== false) {
      startDetectors();
    }
    
    createReportButton();
    setupAutoUpload();
    return true;
  },

  stop: stopRecording,
  
  isRecording: () => state.recording,
  getSessionId: () => state.sessionId,
  getEvents: () => [...state.events],
  getQuality: () => ({ ...state.quality }),
  getConfig: () => state.config,
  
  addCustomEvent(tag, payload) {
    if (state.recording && typeof rrweb?.record?.addCustomEvent === 'function') {
      rrweb.record.addCustomEvent(tag, payload);
    }
  },
  
  upload: uploadRecording
};

// =============================================================================
// AUTO-INIT
// =============================================================================

if (typeof window !== 'undefined') {
  const scripts = document.querySelectorAll('script[type="module"]');
  for (const script of scripts) {
    if (script.src?.includes('/sdk/recap')) {
      RecapSDK.init({ debug: script.dataset.debug === 'true' });
      break;
    }
  }
  
  window.RecapSDK = RecapSDK;
  window.RecapPlayer = RecapPlayer;
}

export default RecapSDK;


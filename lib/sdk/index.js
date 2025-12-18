/**
 * Recap SDK v3.2.0 - ESM Module
 * 
 * Auto-init:
 * <script type="module" src="https://your-worker.dev/sdk/recap.js"></script>
 * 
 * Import:
 * import { RecapSDK, RecapPlayer } from 'https://your-worker.dev/sdk/recap.js';
 */


// src/sdk/core/state.js
var state = {
  initialized: false,
  recording: false,
  debug: false,
  sessionId: null,
  startTime: null,
  events: [],
  config: null,
  quality: {
    score: 0,
    signals: {
      jsErrors: 0,
      networkErrors: 0,
      rageClicks: 0,
      deadClicks: 0,
      validationLoops: 0
    }
  }
};
function generateSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// src/sdk/core/utils.js
var VERSION = "3.2.0";
var log = (...args) => state.debug && console.log("%c[Recap]", "color:#6366f1;font-weight:bold", ...args);
var error = (...args) => console.error("[Recap]", ...args);
function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url.split("?")[0].split("#")[0];
  }
}
function getApiBase() {
  try {
    return new URL(import.meta.url).origin;
  } catch {
    return "https://recap-api.crispr-api.workers.dev";
  }
}
var API_BASE = getApiBase();

// src/sdk/core/config.js
async function fetchConfigByUrl(pageUrl) {
  const url = normalizeUrl(pageUrl);
  log("Looking for config:", url);
  try {
    const res = await fetch(`${API_BASE}/api/configs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { configs } = await res.json();
    for (const cfg of configs) {
      if (urlMatches(url, cfg.url_pattern)) {
        const fullRes = await fetch(`${API_BASE}/api/configs/${cfg.id}`);
        if (fullRes.ok) {
          const config = await fullRes.json();
          log("Found config:", config.name);
          return config;
        }
      }
    }
    log("No config found");
    return null;
  } catch (e) {
    error("Fetch failed:", e.message);
    return null;
  }
}
function urlMatches(url, pattern) {
  const normalizedPattern = normalizeUrl(pattern);
  if (url === normalizedPattern) return true;
  if (url.startsWith(normalizedPattern.replace("*", ""))) return true;
  if (pattern.includes("*")) {
    return new RegExp("^" + normalizedPattern.replace(/\*/g, ".*") + "$").test(url);
  }
  return false;
}

// src/sdk/recording/loader.js
var RRWEB_CDN = "https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.17/dist/rrweb.min.js";
var RRWEB_PLAYER_CDN = "https://cdn.jsdelivr.net/npm/rrweb-player@2.0.0-alpha.17/dist/index.js";
var RRWEB_PLAYER_CSS_CDN = "https://cdn.jsdelivr.net/npm/rrweb-player@2.0.0-alpha.17/dist/style.css";
var RRWEB_LOCAL = "lib/rrweb.min.js";
var RRWEB_PLAYER_LOCAL = "lib/rrweb-player.min.js";
var RRWEB_PLAYER_CSS_LOCAL = "lib/rrweb-player.min.css";
var isExtension = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL;
function getUrl(localPath, cdnUrl) {
  if (isExtension) {
    return chrome.runtime.getURL(localPath);
  }
  return cdnUrl;
}
async function loadRrweb() {
  if (typeof rrweb !== "undefined" && typeof rrweb.record === "function") return true;
  const src = getUrl(RRWEB_LOCAL, RRWEB_CDN);
  log("Loading rrweb from:", isExtension ? "extension" : "CDN");
  return loadScript(src);
}
async function loadRrwebPlayer() {
  if (typeof rrwebPlayer !== "undefined") return true;
  const cssUrl = getUrl(RRWEB_PLAYER_CSS_LOCAL, RRWEB_PLAYER_CSS_CDN);
  if (!document.querySelector(`link[href="${cssUrl}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = cssUrl;
    document.head.appendChild(link);
  }
  const src = getUrl(RRWEB_PLAYER_LOCAL, RRWEB_PLAYER_CDN);
  log("Loading rrweb-player from:", isExtension ? "extension" : "CDN");
  return loadScript(src);
}
function loadScript(src) {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => {
      log("Loaded:", src);
      resolve(true);
    };
    script.onerror = () => {
      error("Failed:", src);
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

// src/sdk/recording/recorder.js
var SESSION_KEY = "recap_session";
var EVENTS_KEY = "recap_events";
var QUALITY_KEY = "recap_quality";
var stopFn = null;
async function initRecorder() {
  return loadRrweb();
}
function startRecording(config = null) {
  if (!state.initialized) return false;
  const resumed = checkResumedSession();
  if (config) state.config = config;
  if (!resumed) {
    state.sessionId = generateSessionId();
    state.startTime = Date.now();
    state.events = [];
    state.quality = { score: 0, signals: { jsErrors: 0, networkErrors: 0, rageClicks: 0, deadClicks: 0 } };
  }
  log("Recording:", state.sessionId, resumed ? "(resumed)" : "(new)");
  stopFn = rrweb.record(buildRrwebOptions(state.config));
  state.recording = true;
  setupPersistence();
  return true;
}
function stopRecording() {
  if (!state.recording) return null;
  log("Stopping...");
  if (stopFn) {
    stopFn();
    stopFn = null;
  }
  state.recording = false;
  clearPersistedSession();
  return {
    sessionId: state.sessionId,
    eventCount: state.events.length,
    duration: Date.now() - state.startTime,
    quality: { ...state.quality }
  };
}
function addCustomEvent(tag, payload) {
  if (state.recording && typeof rrweb?.record?.addCustomEvent === "function") {
    rrweb.record.addCustomEvent(tag, payload);
  }
}
function checkResumedSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (session?.isRecording) {
      state.sessionId = session.sessionId;
      state.startTime = session.startTime;
      state.config = session.config;
      const events = JSON.parse(sessionStorage.getItem(EVENTS_KEY) || "[]");
      state.events = events;
      const quality = JSON.parse(sessionStorage.getItem(QUALITY_KEY) || "null");
      if (quality) state.quality = quality;
      log("Resumed session with", events.length, "events, quality:", state.quality.score);
      return true;
    }
  } catch (e) {
    log("Failed to resume session:", e.message);
  }
  return false;
}
function setupPersistence() {
  const persistState = () => {
    if (!state.recording) return;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        isRecording: true,
        sessionId: state.sessionId,
        startTime: state.startTime,
        config: state.config
      }));
      sessionStorage.setItem(EVENTS_KEY, JSON.stringify(state.events));
      sessionStorage.setItem(QUALITY_KEY, JSON.stringify(state.quality));
    } catch (e) {
      log("Failed to persist state:", e.message);
    }
  };
  window.addEventListener("beforeunload", persistState);
  window.addEventListener("pagehide", persistState);
}
function clearPersistedSession() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(EVENTS_KEY);
  sessionStorage.removeItem(QUALITY_KEY);
}
function buildRrwebOptions(config = {}) {
  const clearSelectors = config?.fields?.clear?.map((f) => f.selector) || [];
  return {
    emit: (event) => state.events.push(event),
    maskAllInputs: true,
    maskInputOptions: { password: true },
    maskInputFn: (text, el) => {
      if (el?.type === "password") return "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
      if (clearSelectors.some((s) => el?.matches?.(s))) return text;
      return "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
    },
    ignoreSelector: config?.fields?.ignored?.map((f) => f.selector).join(",") || null,
    sampling: config?.rrweb_options?.sampling || { mousemove: 50, scroll: 150, input: "last" },
    slimDOMOptions: { script: true, comment: true },
    checkoutEveryNms: 1e4
  };
}

// src/sdk/recording/transport.js
function setupAutoUpload() {
  const upload = () => {
    if (!state.recording || state.events.length < 10) return;
    const blob = new Blob([JSON.stringify(buildPayload())], { type: "application/json" });
    navigator.sendBeacon(`${API_BASE}/api/recordings`, blob);
    log("Auto-uploaded");
  };
  window.addEventListener("beforeunload", upload);
  window.addEventListener("pagehide", upload);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") upload();
  });
}
async function uploadRecording(extra = {}) {
  try {
    const res = await fetch(`${API_BASE}/api/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(extra))
    });
    log("Uploaded:", res.ok);
    return res.ok;
  } catch (e) {
    error("Upload failed:", e.message);
    return false;
  }
}
async function fetchRecording(id) {
  try {
    const res = await fetch(`${API_BASE}/api/recordings/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (e) {
    error("Fetch failed:", e.message);
    return null;
  }
}
function buildPayload(extra = {}) {
  return {
    session_id: state.sessionId,
    config_id: state.config?.id,
    form_name: state.config?.name || document.title,
    events: state.events,
    event_count: state.events.length,
    duration_ms: Date.now() - state.startTime,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    quality: state.quality,
    metadata: { url: location.href, user_agent: navigator.userAgent, sdk_version: VERSION },
    ...extra
  };
}

// src/sdk/quality/scorer.js
var DEFAULT_WEIGHTS = {
  jsError: 40,
  networkError: 40,
  rageClick: 25,
  deadClick: 10,
  validationLoop: 15
};
function recalculateScore() {
  const w = { ...DEFAULT_WEIGHTS, ...state.config?.sessionQuality?.weights };
  const s = state.quality.signals;
  state.quality.score = (s.jsErrors || 0) * w.jsError + (s.networkErrors || 0) * w.networkError + (s.rageClicks || 0) * w.rageClick + (s.deadClicks || 0) * w.deadClick + (s.validationLoops || 0) * w.validationLoop;
  state.quality.severity = getQualitySeverity();
  notifyQualityUpdate();
}
function getQualitySeverity() {
  const thresholds = state.config?.sessionQuality?.thresholds || {
    review: 50,
    critical: 80
  };
  if (state.quality.score >= thresholds.critical) return "critical";
  if (state.quality.score >= thresholds.review) return "review";
  return "good";
}
function notifyQualityUpdate() {
  if (typeof window !== "undefined" && state.recording) {
    window.postMessage({
      type: "RECAP_QUALITY_UPDATE",
      quality: { ...state.quality },
      severity: state.quality.severity
    }, "*");
  }
}

// src/sdk/quality/detectors.js
var abortController = null;
var clickHistory = [];
var validationAttempts = /* @__PURE__ */ new Map();
var originalFetch = null;
function startDetectors() {
  abortController = new AbortController();
  const { signal } = abortController;
  window.addEventListener("error", (e) => {
    if (e.filename?.includes("extension://")) return;
    state.quality.signals.jsErrors++;
    recalculateScore();
    addCustomEvent("quality_signal", {
      type: "js_error",
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno
    });
    log("JS Error:", e.message);
  }, { signal });
  window.addEventListener("unhandledrejection", (e) => {
    state.quality.signals.jsErrors++;
    recalculateScore();
    addCustomEvent("quality_signal", {
      type: "unhandled_rejection",
      reason: String(e.reason)
    });
  }, { signal });
  originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = args[0]?.toString() || args[0]?.url || "";
    const startTime = Date.now();
    try {
      const response = await originalFetch.apply(this, args);
      addCustomEvent("network_request", {
        url: url.slice(0, 200),
        method: args[1]?.method || "GET",
        status: response.status,
        duration: Date.now() - startTime,
        ok: response.ok
      });
      if (!response.ok && response.status >= 400) {
        state.quality.signals.networkErrors++;
        recalculateScore();
        addCustomEvent("quality_signal", {
          type: "network_error",
          url: url.slice(0, 200),
          status: response.status
        });
        log("Network Error:", response.status, url);
      }
      return response;
    } catch (err) {
      state.quality.signals.networkErrors++;
      recalculateScore();
      addCustomEvent("quality_signal", {
        type: "network_error",
        url: url.slice(0, 200),
        error: err.message
      });
      log("Network Error:", err.message);
      throw err;
    }
  };
  document.addEventListener("click", (e) => {
    detectRageClick(e);
    detectDeadClick(e);
  }, { signal, capture: true });
  document.addEventListener("invalid", (e) => {
    const form = e.target?.form;
    if (!form) return;
    const formId = form.id || form.name || form.action || "unknown";
    const attempts = (validationAttempts.get(formId) || 0) + 1;
    validationAttempts.set(formId, attempts);
    if (attempts >= 3) {
      state.quality.signals.validationLoops++;
      recalculateScore();
      validationAttempts.set(formId, 0);
      addCustomEvent("quality_signal", {
        type: "validation_loop",
        form: formId,
        field: e.target?.name || e.target?.id,
        attempts
      });
      log("Validation loop detected");
    }
  }, { signal, capture: true });
  log("All detectors started");
}
function stopDetectors() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  if (originalFetch) {
    window.fetch = originalFetch;
    originalFetch = null;
  }
  clickHistory = [];
  validationAttempts.clear();
  log("Detectors stopped");
}
function detectRageClick(e) {
  const now = Date.now();
  clickHistory.push({ x: e.clientX, y: e.clientY, time: now, target: e.target });
  clickHistory = clickHistory.filter((c) => now - c.time < 1e3);
  if (clickHistory.length >= 3) {
    const first = clickHistory[0];
    const isNearby = clickHistory.every(
      (c) => Math.abs(c.x - first.x) < 50 && Math.abs(c.y - first.y) < 50
    );
    if (isNearby) {
      state.quality.signals.rageClicks++;
      recalculateScore();
      const target = e.target;
      const selector = getElementSelector(target);
      addCustomEvent("quality_signal", {
        type: "rage_click",
        selector,
        clicks: clickHistory.length,
        x: e.clientX,
        y: e.clientY
      });
      clickHistory = [];
      log("Rage click on:", selector);
    }
  }
}
function detectDeadClick(e) {
  const target = e.target;
  const isInteractive = target.closest('a,button,input,select,textarea,[role="button"],[onclick]');
  if (!isInteractive) {
    state.quality.signals.deadClicks++;
    recalculateScore();
    addCustomEvent("quality_signal", {
      type: "dead_click",
      selector: getElementSelector(target),
      x: e.clientX,
      y: e.clientY
    });
  }
}
function getElementSelector(el) {
  if (!el) return "unknown";
  if (el.id) return `#${el.id}`;
  if (el.className && typeof el.className === "string") {
    return `${el.tagName.toLowerCase()}.${el.className.split(" ").slice(0, 2).join(".")}`;
  }
  return el.tagName?.toLowerCase() || "unknown";
}
function analyzeRrwebEvents(events) {
  const insights = {
    totalEvents: events.length,
    interactions: { clicks: 0, inputs: 0, scrolls: 0 },
    pageViews: 0,
    inputFields: /* @__PURE__ */ new Set(),
    clickTargets: [],
    errors: [],
    slowInteractions: []
  };
  let lastInteractionTime = 0;
  events.forEach((event) => {
    if (event.type === 2) {
      insights.pageViews++;
    }
    if (event.type === 3) {
      const source = event.data?.source;
      if (source === 2 && event.data?.type === 2) {
        insights.interactions.clicks++;
        if (lastInteractionTime && event.timestamp - lastInteractionTime > 500) {
          insights.slowInteractions.push({
            type: "slow_response",
            delay: event.timestamp - lastInteractionTime
          });
        }
        lastInteractionTime = event.timestamp;
      }
      if (source === 5) {
        insights.interactions.inputs++;
        if (event.data?.id) {
          insights.inputFields.add(event.data.id);
        }
      }
      if (source === 3) {
        insights.interactions.scrolls++;
      }
    }
    if (event.type === 5 && event.data?.tag === "quality_signal") {
      insights.errors.push(event.data.payload);
    }
  });
  return {
    ...insights,
    inputFieldCount: insights.inputFields.size,
    avgInteractionsPerPage: insights.pageViews > 0 ? Math.round((insights.interactions.clicks + insights.interactions.inputs) / insights.pageViews) : 0
  };
}

// src/sdk/quality/report-ui.js
var reportButton = null;
var visibilityInterval = null;
function createReportButton() {
  const mode = state.config?.reportButton?.mode || state.config?.sessionQuality?.reportButton?.mode || "on_error";
  log("Report button mode:", mode);
  if (mode === "disabled" || mode === "never") {
    log("Report button disabled");
    return;
  }
  removeReportButton();
  reportButton = document.createElement("button");
  reportButton.id = "recap-report-btn";
  reportButton.innerHTML = "\u{1F41B} Report Issue";
  reportButton.style.cssText = `
    position:fixed;bottom:20px;right:20px;padding:10px 16px;
    background:#ef4444;color:white;border:none;border-radius:8px;
    font:500 14px system-ui,sans-serif;cursor:pointer;z-index:99999;
    box-shadow:0 4px 12px rgba(0,0,0,0.15);
    display:${mode === "always" ? "block" : "none"};
    transition:transform 0.2s;
  `;
  reportButton.onmouseover = () => reportButton.style.transform = "scale(1.05)";
  reportButton.onmouseout = () => reportButton.style.transform = "scale(1)";
  reportButton.onclick = showReportModal;
  document.body.appendChild(reportButton);
  log("Report button created");
  if (mode === "on_error") {
    const threshold = state.config?.sessionQuality?.thresholds?.review || 50;
    log("Will show button when score >=", threshold);
    visibilityInterval = setInterval(() => {
      if (reportButton && state.quality.score >= threshold) {
        reportButton.style.display = "block";
        log("Showing report button (score:", state.quality.score, ")");
      }
    }, 1e3);
  }
}
function removeReportButton() {
  if (reportButton) {
    reportButton.remove();
    reportButton = null;
  }
  if (visibilityInterval) {
    clearInterval(visibilityInterval);
    visibilityInterval = null;
  }
}
function showReportModal() {
  const overlay = document.createElement("div");
  overlay.id = "recap-modal";
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.5);
    z-index:100000;display:flex;align-items:center;justify-content:center;
  `;
  overlay.innerHTML = `
    <div style="background:white;padding:24px;border-radius:12px;max-width:420px;width:90%;font-family:system-ui,sans-serif">
      <h3 style="margin:0 0 16px;font-size:18px;font-weight:600">\u{1F41B} Report an Issue</h3>
      
      <div style="margin-bottom:12px">
        <label style="display:block;font-size:13px;font-weight:500;margin-bottom:4px;color:#374151">Category</label>
        <select id="recap-cat" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;background:white">
          <option value="bug">\u{1F41B} Bug / Error</option>
          <option value="confusion">\u{1F615} Confusing UI</option>
          <option value="slow">\u{1F422} Slow / Performance</option>
          <option value="other">\u{1F4DD} Other</option>
        </select>
      </div>
      
      <div style="margin-bottom:16px">
        <label style="display:block;font-size:13px;font-weight:500;margin-bottom:4px;color:#374151">What went wrong?</label>
        <textarea id="recap-cmt" rows="4" placeholder="Describe the issue you encountered..." 
          style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;resize:vertical"></textarea>
      </div>
      
      <div style="background:#f3f4f6;padding:12px;border-radius:8px;margin-bottom:16px;font-size:12px;color:#6b7280">
        <strong>Session Info:</strong><br>
        Score: ${state.quality.score} | 
        JS Errors: ${state.quality.signals.jsErrors} | 
        Network: ${state.quality.signals.networkErrors} |
        Clicks: ${state.quality.signals.rageClicks + state.quality.signals.deadClicks}
      </div>
      
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="recap-x" style="padding:10px 20px;background:#f3f4f6;border:none;border-radius:8px;cursor:pointer;font-size:14px">Cancel</button>
        <button id="recap-ok" style="padding:10px 20px;background:#6366f1;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:500;font-size:14px">Submit Report</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };
  document.getElementById("recap-x").onclick = () => overlay.remove();
  document.getElementById("recap-ok").onclick = async () => {
    const category = document.getElementById("recap-cat").value;
    const comment = document.getElementById("recap-cmt").value;
    const submitBtn = document.getElementById("recap-ok");
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";
    log("Submitting report:", category, comment);
    stopRecording();
    stopDetectors();
    removeReportButton();
    const ok = await uploadRecording({
      user_report: {
        category,
        comment,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        url: location.href
      }
    });
    log("Upload result:", ok);
    overlay.remove();
    showNotification(
      ok ? "Thank you! Your feedback has been submitted." : "Failed to submit. Please try again.",
      ok ? "success" : "error"
    );
  };
}
function showNotification(message, type) {
  const div = document.createElement("div");
  div.style.cssText = `
    position:fixed;top:20px;right:20px;padding:14px 24px;
    background:${type === "success" ? "#22c55e" : "#ef4444"};
    color:white;border-radius:10px;font:14px system-ui,sans-serif;
    z-index:100001;box-shadow:0 4px 12px rgba(0,0,0,0.15);
    animation:slideIn 0.3s ease-out;
  `;
  div.textContent = message;
  document.body.appendChild(div);
  setTimeout(() => {
    div.style.opacity = "0";
    div.style.transition = "opacity 0.3s";
    setTimeout(() => div.remove(), 300);
  }, 3e3);
}

// src/sdk/player/player.js
var RecapPlayer = {
  async play(container, events, options = {}) {
    if (!await loadRrwebPlayer()) {
      error("Failed to load player");
      return null;
    }
    if (typeof container === "string") container = document.querySelector(container);
    if (!container) {
      error("Container not found");
      return null;
    }
    container.innerHTML = "";
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
    const recording = await fetchRecording(id);
    if (!recording?.events) {
      error("Recording not found");
      return null;
    }
    return this.play(container, recording.events, options);
  }
};

// src/sdk/index.js
var RecapSDK = {
  VERSION,
  API_BASE,
  async init(options = {}) {
    if (state.initialized) return;
    state.debug = options.debug ?? false;
    log(`Recap SDK v${VERSION}`);
    log("API:", API_BASE);
    state.config = options.config || await fetchConfigByUrl(location.href);
    if (!state.config) {
      log("No config. Inactive.");
      return;
    }
    const rate = state.config?.settings?.sampling_rate ?? 0.25;
    if (Math.random() > rate) {
      log("Not sampled (", rate, ")");
      return;
    }
    if (!await initRecorder()) {
      error("Failed to load rrweb");
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
  stop() {
    stopDetectors();
    return stopRecording();
  },
  // Getters
  isRecording: () => state.recording,
  getSessionId: () => state.sessionId,
  getEvents: () => [...state.events],
  getQuality: () => ({ ...state.quality }),
  getConfig: () => state.config,
  getSeverity: getQualitySeverity,
  // Actions
  addCustomEvent,
  upload: uploadRecording
};
if (typeof window !== "undefined") {
  const scripts = document.querySelectorAll('script[type="module"]');
  for (const script of scripts) {
    if (script.src?.includes("/sdk/recap")) {
      RecapSDK.init({ debug: script.dataset.debug === "true" });
      break;
    }
  }
  window.RecapSDK = RecapSDK;
  window.RecapPlayer = RecapPlayer;
}
var index_default = RecapSDK;
export {
  API_BASE,
  RecapPlayer,
  RecapSDK,
  VERSION,
  addCustomEvent,
  analyzeRrwebEvents,
  createReportButton,
  index_default as default,
  error,
  fetchConfigByUrl,
  fetchRecording,
  getQualitySeverity,
  initRecorder,
  loadRrweb,
  loadRrwebPlayer,
  log,
  recalculateScore,
  setupAutoUpload,
  startDetectors,
  startRecording,
  state,
  stopDetectors,
  stopRecording,
  uploadRecording
};

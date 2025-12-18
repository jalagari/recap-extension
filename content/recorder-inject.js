/**
 * Recap Recorder v3.2.0 - IIFE for Extension Injection
 * Built from SDK source - DO NOT EDIT DIRECTLY
 */

var RecapRecorder = (() => {
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
  var import_meta = {};
  var log = (...args) => state.debug && console.log("%c[Recap]", "color:#6366f1;font-weight:bold", ...args);
  function getApiBase() {
    try {
      return new URL(import_meta.url).origin;
    } catch {
      return "https://recap-api.crispr-api.workers.dev";
    }
  }
  var API_BASE = getApiBase();

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

  // src/sdk/recording/loader.js
  var isExtension = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL;

  // src/sdk/recording/recorder.js
  function addCustomEvent(tag, payload) {
    if (state.recording && typeof rrweb?.record?.addCustomEvent === "function") {
      rrweb.record.addCustomEvent(tag, payload);
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

  // src/sdk/recorder-entry.js
  var SESSION_KEY = "recap_session";
  var EVENTS_KEY = "recap_events";
  var QUALITY_KEY = "recap_quality";
  var stopFn = null;
  var reportButton = null;
  var visibilityInterval = null;
  function getSession() {
    try {
      const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      if (!session) return null;
      const currentOrigin = window.location.origin;
      const currentUrl = window.location.href;
      if (session.domain && session.domain !== currentOrigin) {
        console.warn("[Recap Page] Session domain mismatch, clearing:", {
          sessionDomain: session.domain,
          currentDomain: currentOrigin
        });
        clearSession();
        return null;
      }
      if (session.startUrl && session.config?.url_pattern) {
        const configPattern = session.config.url_pattern;
        const patternRegex = new RegExp("^" + configPattern.replace(/\*/g, ".*") + "$");
        if (!patternRegex.test(currentUrl)) {
          console.warn("[Recap Page] Session config pattern mismatch, clearing:", {
            configPattern,
            currentUrl,
            startUrl: session.startUrl
          });
          clearSession();
          return null;
        }
      }
      return session;
    } catch {
      return null;
    }
  }
  function setSession(session) {
    const sessionWithContext = {
      ...session,
      domain: window.location.origin,
      startUrl: session.startUrl || window.location.href,
      timestamp: Date.now()
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionWithContext));
  }
  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(EVENTS_KEY);
    sessionStorage.removeItem(QUALITY_KEY);
  }
  function persistEvents() {
    try {
      fetch("http://127.0.0.1:7243/ingest/9c0706a5-a4ba-48be-93f5-8b6a38a9ae3e", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: "recorder-entry.js:47", message: "Persisting events before page unload", data: { eventCount: state.events?.length || 0, hasEvents: !!state.events, isRecording: state.recording, sessionId: state.sessionId, firstEventType: state.events?.[0]?.type, lastEventType: state.events?.[state.events.length - 1]?.type }, timestamp: Date.now(), sessionId: "debug-session", runId: "run1", hypothesisId: "A" }) }).catch(() => {
      });
      sessionStorage.setItem(EVENTS_KEY, JSON.stringify(state.events));
      const stored = sessionStorage.getItem(EVENTS_KEY);
      fetch("http://127.0.0.1:7243/ingest/9c0706a5-a4ba-48be-93f5-8b6a38a9ae3e", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: "recorder-entry.js:52", message: "Events persisted to sessionStorage", data: { storedLength: stored ? JSON.parse(stored).length : 0, storedExists: !!stored }, timestamp: Date.now(), sessionId: "debug-session", runId: "run1", hypothesisId: "A" }) }).catch(() => {
      });
    } catch (e) {
      console.warn("[Recap Page] Failed to persist events:", e.message);
      fetch("http://127.0.0.1:7243/ingest/9c0706a5-a4ba-48be-93f5-8b6a38a9ae3e", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: "recorder-entry.js:56", message: "Failed to persist events", data: { error: e.message, eventCount: state.events?.length || 0 }, timestamp: Date.now(), sessionId: "debug-session", runId: "run1", hypothesisId: "A" }) }).catch(() => {
      });
    }
  }
  function loadPersistedEvents() {
    try {
      const stored = sessionStorage.getItem(EVENTS_KEY);
      const events = stored ? JSON.parse(stored) : [];
      fetch("http://127.0.0.1:7243/ingest/9c0706a5-a4ba-48be-93f5-8b6a38a9ae3e", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: "recorder-entry.js:55", message: "Loading persisted events after page load", data: { storedExists: !!stored, loadedEventCount: events.length, firstEventType: events[0]?.type, lastEventType: events[events.length - 1]?.type, firstEventTimestamp: events[0]?.timestamp, lastEventTimestamp: events[events.length - 1]?.timestamp }, timestamp: Date.now(), sessionId: "debug-session", runId: "run1", hypothesisId: "B" }) }).catch(() => {
      });
      return events;
    } catch (e) {
      fetch("http://127.0.0.1:7243/ingest/9c0706a5-a4ba-48be-93f5-8b6a38a9ae3e", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: "recorder-entry.js:62", message: "Failed to load persisted events", data: { error: e.message }, timestamp: Date.now(), sessionId: "debug-session", runId: "run1", hypothesisId: "B" }) }).catch(() => {
      });
      return [];
    }
  }
  function persistQuality() {
    try {
      sessionStorage.setItem(QUALITY_KEY, JSON.stringify(state.quality));
    } catch (e) {
      console.warn("[Recap Page] Failed to persist quality:", e.message);
    }
  }
  function loadPersistedQuality() {
    try {
      const stored = sessionStorage.getItem(QUALITY_KEY);
      if (stored) {
        state.quality = JSON.parse(stored);
        return true;
      }
    } catch (e) {
      console.warn("[Recap Page] Failed to load quality:", e.message);
    }
    return false;
  }
  function startRecording(config, resumedEvents = [], options = {}) {
    const { forceRestart = false, autoStart = false } = options;
    if (state.recording) {
      if (autoStart) {
        console.log("[Recap Page] Already recording, ignoring auto-start");
        return true;
      }
      if (forceRestart) {
        console.log("[Recap Page] Force restart: stopping current recording");
        stopRecording();
      } else {
        console.log("[Recap Page] Already recording");
        return true;
      }
    }
    if (typeof rrweb?.record !== "function") {
      console.error("[Recap Page] rrweb not loaded");
      return false;
    }
    state.config = config || state.config;
    if (!resumedEvents || resumedEvents.length === 0) {
      state.sessionId = generateSessionId();
      state.startTime = Date.now();
    } else {
      const session = getSession();
      if (session?.sessionId) {
        state.sessionId = session.sessionId;
        state.startTime = session.startTime;
      } else {
        state.sessionId = generateSessionId();
        state.startTime = Date.now();
      }
    }
    state.events = resumedEvents || [];
    state.recording = true;
    const initialEventCount = (resumedEvents || []).length;
    const lastResumedTimestamp = resumedEvents && resumedEvents.length > 0 ? resumedEvents[resumedEvents.length - 1]?.timestamp : null;
    try {
      fetch("http://127.0.0.1:7243/ingest/9c0706a5-a4ba-48be-93f5-8b6a38a9ae3e", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: "recorder-entry.js:125", message: "Starting recording with resumed events", data: { sessionId: state.sessionId, resumedEventCount: initialEventCount, isResuming: initialEventCount > 0, firstResumedEventType: resumedEvents?.[0]?.type, lastResumedEventType: resumedEvents?.[resumedEvents.length - 1]?.type, forceRestart, autoStart }, timestamp: Date.now(), sessionId: "debug-session", runId: "run1", hypothesisId: "C" }) }).catch(() => {
      });
    } catch (e) {
    }
    console.log("[Recap] Recording started:", {
      sessionId: state.sessionId,
      configName: config?.name || "No config",
      configId: config?.id,
      resumedEventCount: initialEventCount,
      isResuming: initialEventCount > 0,
      startTime: new Date(state.startTime).toISOString(),
      timestamp: state.startTime,
      url: window.location.href,
      forceRestart,
      autoStart
    });
    const clearSelectors = config?.fields?.clear?.map((f) => f.selector) || [];
    stopFn = rrweb.record({
      emit: (event) => {
        try {
          const isSnapshot = event.type === 2;
          const isFirstNewEvent = state.events.length === initialEventCount;
          if (isFirstNewEvent || isSnapshot) {
            fetch("http://127.0.0.1:7243/ingest/9c0706a5-a4ba-48be-93f5-8b6a38a9ae3e", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: "recorder-entry.js:162", message: "New event emitted", data: { eventType: event.type, isSnapshot, isFirstNewEvent, resumedEventCount: initialEventCount, currentEventCount: state.events.length, willBeCount: state.events.length + 1, eventTimestamp: event.timestamp, lastResumedTimestamp, hasResumedSnapshot: initialEventCount > 0 && resumedEvents?.[0]?.type === 2 }, timestamp: Date.now(), sessionId: "debug-session", runId: "run1", hypothesisId: "D" }) }).catch(() => {
            });
          }
        } catch (e) {
        }
        state.events.push(event);
        window.postMessage({
          type: "RECAP_EVENT",
          event: summarizeEvent(event),
          eventCount: state.events.length
        }, "*");
      },
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
    });
    if (config?.sessionQuality?.enabled !== false) {
      startDetectors();
    }
    createReportButton();
    return true;
  }
  function stopRecording() {
    if (!state.recording) return { events: [], quality: null };
    if (stopFn) {
      try {
        stopFn();
      } catch (e) {
        if (e.name === "SecurityError" || e.message?.includes("removeEventListener")) {
        } else {
          console.warn("[Recap Page] Error stopping rrweb recording (non-fatal):", e.message);
        }
      } finally {
        stopFn = null;
      }
    }
    stopDetectors();
    removeReportButton();
    state.recording = false;
    const allEvents = [...state.events];
    fetch("http://127.0.0.1:7243/ingest/9c0706a5-a4ba-48be-93f5-8b6a38a9ae3e", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: "recorder-entry.js:167", message: "Stopping recording - final event count", data: { totalEventCount: allEvents.length, firstEventType: allEvents[0]?.type, lastEventType: allEvents[allEvents.length - 1]?.type, firstEventTimestamp: allEvents[0]?.timestamp, lastEventTimestamp: allEvents[allEvents.length - 1]?.timestamp, hasSnapshot: allEvents.some((e) => e.type === 2), snapshotCount: allEvents.filter((e) => e.type === 2).length }, timestamp: Date.now(), sessionId: "debug-session", runId: "run1", hypothesisId: "E" }) }).catch(() => {
    });
    const qualityForServer = {
      score: state.quality.score || 0,
      severity: getQualitySeverity(),
      signals: {
        jsErrors: state.quality.signals?.jsErrors || 0,
        networkErrors: state.quality.signals?.networkErrors || 0,
        rageClicks: state.quality.signals?.rageClicks || 0,
        deadClicks: state.quality.signals?.deadClicks || 0,
        validationLoops: state.quality.signals?.validationLoops || 0
      }
    };
    const endTime = Date.now();
    const duration = endTime - state.startTime;
    console.log("[Recap] Recording ended:", {
      sessionId: state.sessionId,
      eventCount: allEvents.length,
      durationMs: duration,
      durationFormatted: `${Math.floor(duration / 1e3)}s`,
      qualityScore: qualityForServer.score,
      qualitySeverity: qualityForServer.severity,
      qualitySignals: qualityForServer.signals,
      startTime: new Date(state.startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      timestamp: endTime,
      url: window.location.href,
      hasSnapshot: allEvents.some((e) => e.type === 2),
      snapshotCount: allEvents.filter((e) => e.type === 2).length,
      firstEventType: allEvents[0]?.type,
      lastEventType: allEvents[allEvents.length - 1]?.type
    });
    clearSession();
    return { events: allEvents, quality: qualityForServer };
  }
  function summarizeEvent(event) {
    let label = "";
    const type = event.type;
    const source = event.data?.source;
    if (type === 2) label = "\u{1F4F8} Snapshot";
    else if (type === 3) {
      if (source === 2) {
        const mouseType = event.data?.type;
        if (mouseType === 2) label = "\u{1F446} Click";
        else if (mouseType === 1) label = "\u{1F5B1}\uFE0F Move";
      } else if (source === 5) label = "\u2328\uFE0F Input";
      else if (source === 3) label = "\u{1F4DC} Scroll";
      else if (source === 0) label = "\u{1F504} Mutation";
      else label = "\u26A1 Change";
    } else if (type === 5) {
      const tag = event.data?.tag;
      if (tag === "quality_signal") label = "\u26A0\uFE0F " + (event.data?.payload?.type || "Signal");
      else label = "\u{1F4CC} " + (tag || "Custom");
    } else {
      label = `Event ${type}`;
    }
    return { type, source, label, timestamp: event.timestamp, id: event.data?.id };
  }
  function createReportButton() {
    try {
      const mode = state.config?.reportButton?.mode || state.config?.sessionQuality?.reportButton?.mode || "on_error";
      console.log("[Recap Page] Report button mode:", mode);
      if (mode === "disabled" || mode === "never") return;
      if (!document.body) {
        console.log("[Recap Page] document.body not ready, retrying report button creation...");
        if (document.readyState === "loading") {
          const handler = () => {
            setTimeout(() => {
              if (document.body) {
                createReportButton();
              } else {
                setTimeout(() => createReportButton(), 500);
              }
            }, 100);
          };
          document.addEventListener("DOMContentLoaded", handler, { once: true });
        } else {
          setTimeout(() => {
            if (document.body) {
              createReportButton();
            } else {
              setTimeout(() => createReportButton(), 500);
            }
          }, 100);
        }
        return;
      }
      removeReportButton();
      reportButton = document.createElement("button");
      reportButton.id = "recap-report-btn";
      reportButton.innerHTML = "\u{1F41B} Report Issue";
      reportButton.style.cssText = `
      position: fixed; bottom: 20px; right: 20px;
      padding: 10px 16px; background: #ef4444; color: white;
      border: none; border-radius: 8px;
      font: 500 14px system-ui, sans-serif; cursor: pointer; z-index: 99999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      display: ${mode === "always" ? "block" : "none"};
      transition: transform 0.2s;
    `;
      reportButton.onmouseover = () => {
        if (reportButton) reportButton.style.transform = "scale(1.05)";
      };
      reportButton.onmouseout = () => {
        if (reportButton) reportButton.style.transform = "scale(1)";
      };
      reportButton.onclick = showReportModal;
      document.body.appendChild(reportButton);
      if (mode === "on_error") {
        const threshold = state.config?.sessionQuality?.thresholds?.review || 50;
        visibilityInterval = setInterval(() => {
          try {
            if (reportButton && state.quality?.score >= threshold) {
              reportButton.style.display = "block";
            }
          } catch (err) {
            console.error("[Recap Page] Error in visibility check:", err);
          }
        }, 1e3);
      }
    } catch (err) {
      console.error("[Recap Page] Error creating report button:", err);
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
    try {
      if (!document.body) {
        console.warn("[Recap Page] document.body not ready, cannot show modal");
        return;
      }
      const overlay = document.createElement("div");
      overlay.id = "recap-modal";
      overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.5);
      z-index: 100000; display: flex; align-items: center; justify-content: center;
    `;
      const modal = document.createElement("div");
      modal.style.cssText = `
      background: white; padding: 24px; border-radius: 12px;
      max-width: 420px; width: 90%;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
    `;
      modal.innerHTML = `
      <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b;">Report an Issue</h3>
      <p style="margin: 0 0 16px; font-size: 14px; color: #64748b;">
        Describe what went wrong. Your session recording will be attached.
      </p>
      <textarea id="recap-report-text" placeholder="What happened?" 
        style="width: 100%; height: 100px; padding: 12px; border: 1px solid #e2e8f0; 
               border-radius: 8px; font-size: 14px; resize: none; margin-bottom: 16px;"></textarea>
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="recap-report-cancel" 
          style="padding: 8px 16px; background: #f1f5f9; color: #475569; 
                 border: none; border-radius: 6px; cursor: pointer;">Cancel</button>
        <button id="recap-report-submit" 
          style="padding: 8px 16px; background: #ef4444; color: white; 
                 border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">Submit Report</button>
      </div>
    `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const textarea = document.getElementById("recap-report-text");
      if (textarea) textarea.focus();
      const cancelBtn = document.getElementById("recap-report-cancel");
      if (cancelBtn) cancelBtn.onclick = () => overlay.remove();
      overlay.onclick = (e) => {
        try {
          if (e.target === overlay) overlay.remove();
        } catch (err) {
          console.error("[Recap Page] Error in overlay click:", err);
        }
      };
      const submitBtn = document.getElementById("recap-report-submit");
      if (submitBtn) {
        submitBtn.onclick = async () => {
          try {
            const textEl = document.getElementById("recap-report-text");
            const text = textEl?.value || "";
            if (submitBtn) {
              submitBtn.disabled = true;
              submitBtn.textContent = "Uploading...";
            }
            const recordingResult = stopRecording();
            const payload = {
              session_id: `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              config_id: state.config?.id || "user_report",
              form_name: document.title || "User Report",
              events: recordingResult.events || [],
              event_count: recordingResult.events?.length || 0,
              duration_ms: Date.now() - (state.startTime || Date.now()),
              quality: recordingResult.quality,
              user_report: {
                text,
                category: "user_report",
                timestamp: Date.now(),
                url: location.href
              },
              metadata: {
                url: location.href,
                user_agent: navigator.userAgent
              },
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            };
            const response = await fetch(`${API_BASE}/api/recordings`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
            overlay.remove();
            showToast(
              response.ok ? "\u2713 Report submitted, thank you!" : "\u2717 Upload failed, please try again",
              response.ok ? "#10b981" : "#ef4444"
            );
          } catch (err) {
            console.error("[Recap Page] Upload failed:", err);
            try {
              overlay.remove();
            } catch {
            }
            showToast("\u2717 Upload failed: " + (err?.message || "Unknown error"), "#ef4444");
          }
        };
      }
    } catch (err) {
      console.error("[Recap Page] Error creating report modal:", err);
    }
  }
  function showToast(message, bgColor) {
    try {
      if (!document.body) {
        console.warn("[Recap Page] Cannot show toast, document.body not ready");
        return;
      }
      const toast = document.createElement("div");
      toast.style.cssText = `
      position: fixed; bottom: 20px; right: 20px;
      background: ${bgColor}; color: white;
      padding: 12px 20px; border-radius: 8px;
      font-size: 14px; z-index: 999999;
      animation: fadeIn 0.3s ease;
    `;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => {
        try {
          toast.style.opacity = "0";
          toast.style.transition = "opacity 0.3s";
          setTimeout(() => {
            try {
              toast.remove();
            } catch {
            }
          }, 300);
        } catch {
        }
      }, 3e3);
    } catch (err) {
      console.error("[Recap Page] Error showing toast:", err);
    }
  }
  window.addEventListener("message", (e) => {
    try {
      if (e.source !== window || !e.data?.type?.startsWith("RECAP_")) return;
      if (e.data.type.endsWith("_RESPONSE") || e.data.type === "RECAP_EVENT" || e.data.type === "RECAP_READY") return;
      const { type, config: cfg, requestId, forceRestart, autoStart } = e.data;
      let response = {};
      try {
        switch (type) {
          case "RECAP_START":
            console.log("[Recap] RECAP_START message received:", {
              autoStart: autoStart || false,
              forceRestart: forceRestart || false,
              configName: cfg?.name,
              configId: cfg?.id,
              alreadyRecording: state.recording,
              url: window.location.href,
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            });
            const resumedEvents = loadPersistedEvents();
            const startResult = startRecording(cfg, resumedEvents, { forceRestart, autoStart });
            response = {
              success: startResult,
              sessionId: state.sessionId
            };
            console.log("[Recap] RECAP_START result:", {
              success: startResult,
              sessionId: state.sessionId,
              isRecording: state.recording,
              eventCount: state.events?.length || 0
            });
            break;
          case "RECAP_RESTART":
            response = {
              success: startRecording(cfg, [], { forceRestart: true })
            };
            break;
          case "RECAP_STOP":
            try {
              const result = stopRecording();
              response = { success: true, events: result.events, quality: result.quality };
            } catch (err) {
              if (err.name === "SecurityError" || err.message?.includes("removeEventListener")) {
                const allEvents = [...state.events || []];
                const qualityForServer = {
                  score: state.quality?.score || 0,
                  severity: getQualitySeverity(),
                  signals: {
                    jsErrors: state.quality?.signals?.jsErrors || 0,
                    networkErrors: state.quality?.signals?.networkErrors || 0,
                    rageClicks: state.quality?.signals?.rageClicks || 0,
                    deadClicks: state.quality?.signals?.deadClicks || 0,
                    validationLoops: state.quality?.signals?.validationLoops || 0
                  }
                };
                state.recording = false;
                response = { success: true, events: allEvents, quality: qualityForServer };
              } else {
                console.warn("[Recap] Unexpected error during stopRecording:", err?.message || err);
                const allEvents = [...state.events || []];
                const qualityForServer = {
                  score: state.quality?.score || 0,
                  severity: getQualitySeverity(),
                  signals: {
                    jsErrors: state.quality?.signals?.jsErrors || 0,
                    networkErrors: state.quality?.signals?.networkErrors || 0,
                    rageClicks: state.quality?.signals?.rageClicks || 0,
                    deadClicks: state.quality?.signals?.deadClicks || 0,
                    validationLoops: state.quality?.signals?.validationLoops || 0
                  }
                };
                state.recording = false;
                response = { success: true, events: allEvents, quality: qualityForServer };
              }
            }
            break;
          case "RECAP_STATUS":
            response = {
              isRecording: state.recording,
              eventCount: state.events?.length || 0,
              config: state.config,
              startTime: state.startTime,
              quality: state.quality
            };
            break;
          case "RECAP_GET_EVENTS":
            response = { events: (state.events || []).map(summarizeEvent) };
            break;
          case "RECAP_GET_QUALITY":
            response = {
              quality: state.quality,
              severity: getQualitySeverity()
            };
            break;
          case "RECAP_PING":
            response = { ready: true, rrwebLoaded: typeof rrweb !== "undefined" };
            break;
          default:
            response = { error: "Unknown message type" };
        }
      } catch (err) {
        if (err.name === "SecurityError" && (err.message?.includes("removeEventListener") || err.message?.includes("security policy"))) {
          response = { error: "SecurityError (non-fatal)", success: false };
        } else {
          console.error("[Recap Page] Error handling message:", err);
          response = { error: err.message || "Unknown error" };
        }
      }
      window.postMessage({ type: type + "_RESPONSE", requestId, ...response }, "*");
    } catch (err) {
      console.error("[Recap Page] Fatal error in message handler:", err);
    }
  });
  try {
    const session = getSession();
    if (session?.isRecording) {
      const currentOrigin = window.location.origin;
      const currentUrl = window.location.href;
      console.log("[Recap Page] Checking session resume:", {
        sessionDomain: session.domain,
        currentDomain: currentOrigin,
        sessionStartUrl: session.startUrl,
        currentUrl,
        hasConfig: !!session.config,
        sessionId: session.sessionId
      });
      if (session.domain && session.domain !== currentOrigin) {
        console.warn("[Recap Page] Domain mismatch, not resuming:", {
          sessionDomain: session.domain,
          currentDomain: currentOrigin
        });
        clearSession();
      } else {
        console.log("[Recap Page] Resuming recording from previous page");
        const resumedEvents = loadPersistedEvents();
        loadPersistedQuality();
        setTimeout(() => {
          try {
            startRecording(session.config, resumedEvents);
          } catch (err) {
            console.error("[Recap Page] Error resuming recording:", err);
            clearSession();
          }
        }, 200);
      }
    }
  } catch (err) {
    console.error("[Recap Page] Error during initialization:", err);
  }
  window.addEventListener("beforeunload", () => {
    try {
      if (state.recording) {
        setSession({
          isRecording: true,
          config: state.config,
          startTime: state.startTime,
          sessionId: state.sessionId,
          startUrl: window.location.href
          // Store current URL for validation
        });
        persistEvents();
        persistQuality();
      }
    } catch (err) {
      console.error("[Recap Page] Error in beforeunload:", err);
    }
  });
  window.addEventListener("pagehide", () => {
    try {
      if (state.recording) {
        setSession({ isRecording: true, config: state.config, startTime: state.startTime });
        persistEvents();
      }
    } catch (err) {
      console.error("[Recap Page] Error in pagehide:", err);
    }
  });
  try {
    console.log("[Recap Page] Ready");
    window.postMessage({ type: "RECAP_READY" }, "*");
  } catch (err) {
    console.error("[Recap Page] Error sending ready message:", err);
  }
})();

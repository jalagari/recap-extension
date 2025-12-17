/**
 * Recap Recording Logic
 * Injected into page context to use rrweb
 * Supports cross-page recording via sessionStorage
 */

(function() {
  if (window.__recapInjected) return;
  window.__recapInjected = true;
  
  console.log('[Recap Page] Injected');
  
  const SESSION_KEY = 'recap_session';
  const EVENTS_KEY = 'recap_events';
  let isRecording = false;
  let events = [];
  let stopFn = null;
  let config = null;
  let startTime = null;
  
  // ============================================================================
  // Session Management
  // ============================================================================
  
  function getSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
  }
  
  function setSession(session) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
  
  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(EVENTS_KEY);
  }
  
  function persistEvents() {
    // Store events in chunks to avoid storage limits
    try {
      sessionStorage.setItem(EVENTS_KEY, JSON.stringify(events));
    } catch (e) {
      console.warn('[Recap Page] Failed to persist events:', e.message);
    }
  }
  
  function loadPersistedEvents() {
    try {
      const stored = sessionStorage.getItem(EVENTS_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  }
  
  // ============================================================================
  // Recording
  // ============================================================================
  
  function startRecording(cfg = {}, resumedEvents = []) {
    if (isRecording) {
      console.log('[Recap Page] Already recording');
      return true;
    }
    
    if (typeof rrweb === 'undefined' || typeof rrweb.record !== 'function') {
      console.error('[Recap Page] rrweb not loaded');
      return false;
    }
    
    config = cfg;
    events = resumedEvents || [];
    isRecording = true;
    startTime = Date.now();
    
    const clearSelectors = config.fields?.clear?.map(f => f.selector) || [];
    
    const options = {
      emit: (event) => {
        events.push(event);
        
        // Notify extension of new event (for live display)
        const summary = summarizeEvent(event);
        if (summary.label && summary.label !== 'Meta') {
          window.postMessage({ 
            type: 'RECAP_EVENT', 
            event: summary,
            eventCount: events.length
          }, '*');
        }
      },
      maskAllInputs: true,
      maskInputFn: (text, element) => {
        if (element?.type === 'password') return '••••••••';
        if (clearSelectors.some(sel => {
          try { return element?.matches?.(sel); } catch { return false; }
        })) {
          return text;
        }
        return '••••••••';
      },
      ignoreSelector: config.fields?.ignored?.map(f => f.selector).join(',') || null,
      sampling: { mousemove: 50, scroll: 150, input: 'last' },
      slimDOMOptions: { script: true, comment: true },
      recordCanvas: false,
      collectFonts: false
    };
    
    stopFn = rrweb.record(options);
    console.log('[Recap Page] Recording started, resumed events:', resumedEvents.length);
    
    setSession({ isRecording: true, config, startTime });
    return true;
  }
  
  function stopRecording() {
    if (!isRecording) return [];
    
    if (stopFn) {
      stopFn();
      stopFn = null;
    }
    
    isRecording = false;
    const allEvents = [...events];
    
    clearSession();
    
    console.log('[Recap Page] Stopped,', allEvents.length, 'events');
    return allEvents;
  }
  
  function summarizeEvent(event) {
    let label = '';
    const type = event.type;
    const source = event.data?.source;
    
    // Type 3 = Incremental snapshot
    if (type === 3) {
      // Source types: 0=Mutation, 1=MouseMove, 2=MouseInteraction, 3=Scroll, 5=Input
      if (source === 2) {
        // MouseInteraction types: 0=MouseUp, 1=MouseDown, 2=Click
        const interactionType = event.data?.type;
        if (interactionType === 2 || interactionType === 1) {
          label = 'Click';
        }
      } else if (source === 5) {
        label = 'Input';
      } else if (source === 3) {
        label = 'Scroll';
      }
    } else if (type === 2) {
      label = 'Snapshot';
    } else if (type === 4) {
      label = 'Meta';
    }
    
    return {
      type,
      source,
      label,
      timestamp: event.timestamp,
      id: event.data?.id
    };
  }
  
  // ============================================================================
  // Message Handler
  // ============================================================================
  
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.type?.startsWith('RECAP_')) return;
    if (e.data.type.endsWith('_RESPONSE') || e.data.type === 'RECAP_EVENT' || e.data.type === 'RECAP_READY') return;
    
    const { type, config: cfg, requestId } = e.data;
    let response = {};
    
    switch (type) {
      case 'RECAP_START':
        response = { success: startRecording(cfg) };
        break;
      case 'RECAP_STOP':
        response = { success: true, events: stopRecording() };
        break;
      case 'RECAP_STATUS':
        response = { isRecording, eventCount: events.length };
        break;
      case 'RECAP_GET_EVENTS':
        response = { events: events.map(summarizeEvent) };
        break;
      case 'RECAP_PING':
        response = { ready: true, rrwebLoaded: typeof rrweb !== 'undefined' };
        break;
    }
    
    window.postMessage({ type: type + '_RESPONSE', requestId, ...response }, '*');
  });
  
  // ============================================================================
  // Cross-page Continuity
  // ============================================================================
  
  // Check for resumed session on load
  const session = getSession();
  if (session?.isRecording) {
    console.log('[Recap Page] Resuming recording from previous page');
    const resumedEvents = loadPersistedEvents();
    console.log('[Recap Page] Loaded', resumedEvents.length, 'persisted events');
    
    // Wait a bit for rrweb to be ready
    setTimeout(() => startRecording(session.config, resumedEvents), 200);
  }
  
  // Persist state before page unload
  window.addEventListener('beforeunload', () => {
    if (isRecording) {
      console.log('[Recap Page] Persisting', events.length, 'events before unload');
      setSession({ isRecording: true, config, startTime });
      persistEvents();
    }
  });
  
  // Also handle pagehide for mobile/bfcache
  window.addEventListener('pagehide', () => {
    if (isRecording) {
      setSession({ isRecording: true, config, startTime });
      persistEvents();
    }
  });
  
  console.log('[Recap Page] Ready');
  window.postMessage({ type: 'RECAP_READY' }, '*');
})();

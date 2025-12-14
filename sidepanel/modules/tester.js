/**
 * Recap - Tester Module
 * Production SDK testing with IndexedDB session storage
 * Uses shared Player module for replay
 * @version 1.0.0
 */

'use strict';

(function() {
  const { DOM, State, Toast, Modal, Log, Player } = window.Recap;

  // ============================================================================
  // TESTER - Production SDK Testing
  // ============================================================================

  const Tester = {
    DB_NAME: 'RecapTester',
    DB_VERSION: 1,
    STORE_NAME: 'sessions',
    MAX_SESSIONS: 3,
    MAX_AGE_DAYS: 2,

    db: null,
    recording: false,

    // ========================================
    // INITIALIZATION
    // ========================================

    async init() {
      await this.openDB();
      await this.loadSessions();
      await this.cleanOldSessions();
      this.updateUI();
      this.updateConfigPreview();
    },

    // ========================================
    // INDEXEDDB OPERATIONS
    // ========================================

    openDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          this.db = request.result;
          resolve();
        };

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(this.STORE_NAME)) {
            const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
            store.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };
      });
    },

    async loadSessions() {
      if (!this.db) return;

      return new Promise((resolve) => {
        const tx = this.db.transaction(this.STORE_NAME, 'readonly');
        const store = tx.objectStore(this.STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => {
          const sessions = request.result
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, this.MAX_SESSIONS);

          Log.debug('Loaded', sessions.length, 'sessions');
          State.testerSessions = sessions;
          this.renderSessions();
          resolve();
        };

        request.onerror = () => resolve();
      });
    },

    async saveSession(session) {
      if (!this.db) return;

      return new Promise((resolve) => {
        const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
        const store = tx.objectStore(this.STORE_NAME);
        store.put(session);
        tx.oncomplete = resolve;
      });
    },

    async deleteSession(id) {
      if (!this.db) return;

      return new Promise((resolve) => {
        const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
        const store = tx.objectStore(this.STORE_NAME);
        store.delete(id);
        tx.oncomplete = resolve;
      });
    },

    async cleanOldSessions() {
      const maxAge = this.MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
      const now = Date.now();

      for (const session of State.testerSessions) {
        if (now - session.timestamp > maxAge) {
          await this.deleteSession(session.id);
        }
      }

      const sorted = State.testerSessions.sort((a, b) => b.timestamp - a.timestamp);
      for (let i = this.MAX_SESSIONS; i < sorted.length; i++) {
        await this.deleteSession(sorted[i].id);
      }

      await this.loadSessions();
    },

    async clearAllSessions() {
      if (!confirm('Clear all test sessions?')) return;

      if (this.db) {
        const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
        tx.objectStore(this.STORE_NAME).clear();
      }

      State.testerSessions = [];
      this.renderSessions();
      Toast.info('All sessions cleared');
    },

    // ========================================
    // CONFIG MANAGEMENT
    // ========================================

    useCurrentConfig() {
      // Access ConfigExport dynamically to ensure it's loaded
      const ConfigExport = window.Recap.ConfigExport;
      if (!ConfigExport) {
        Toast.error('Config module not loaded');
        Log.error('ConfigExport not found in window.Recap');
        return;
      }
      
      const config = ConfigExport.build();
      
      // Log what was built
      const maskCount = config.masking?.selectors?.length || 0;
      const ignoreCount = config.ignored?.selectors?.length || 0;
      const scrubCount = config.network?.scrub_payload_keys?.length || 0;
      const stepCount = config.journey?.steps?.length || 0;
      
      Log.debug('Built config from Trainer:', {
        formName: config.form?.name,
        maskingSelectors: maskCount,
        ignoredSelectors: ignoreCount,
        scrubKeys: scrubCount,
        journeySteps: stepCount
      });
      
      // Warn if config appears empty
      if (maskCount === 0 && ignoreCount === 0 && scrubCount === 0 && stepCount === 0) {
        Toast.info('Config loaded (empty - configure in Trainer first)');
      } else {
        Toast.success(`Config loaded: ${maskCount} masks, ${ignoreCount} ignored, ${stepCount} steps`);
      }
      
      State.testerConfig = config;
      this.updateUI();
      this.updateConfigPreview();
    },

    loadConfigFile(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          State.testerConfig = JSON.parse(e.target.result);
          this.updateUI();
          this.updateConfigPreview();
          Toast.success('Config loaded from file');
        } catch (err) {
          Toast.error('Invalid config file');
        }
      };
      reader.readAsText(file);
    },

    // ========================================
    // RECORDING (Simplified - uses Trainer's rrweb)
    // ========================================

    async injectAndStart() {
      if (!State.testerConfig) {
        Toast.error('Load a configuration first');
        return;
      }

      if (!State.activeTabId) {
        Toast.error('No active tab');
        return;
      }

      try {
        // Stop any existing Trainer recording first
        if (State.isRecording) {
          await window.Recap.Recording.stop();
          await new Promise(r => setTimeout(r, 200));
        }

        // Step 1: Clean up any existing recordings
        const checkResult = await chrome.scripting.executeScript({
          target: { tabId: State.activeTabId },
          func: () => {
            // Stop existing SDK if running
            if (window.RecapSDK?.isRecording?.()) {
              window.RecapSDK.stop();
              console.log('[Recap Tester] Stopped existing SDK recording');
            }
            
            // Clear previous Tester state
            if (window.__RECAP_TEST__?.stopFn) {
              try { window.__RECAP_TEST__.stopFn(); } catch(e) {}
            }
            window.__RECAP_TEST__ = null;
            
            // Stop Trainer's recording if active
            if (window.__RECAP_STATE__?.stopRrweb) {
              try { window.__RECAP_STATE__.stopRrweb(); } catch(e) {}
            }
            
            return { 
              hasRrweb: typeof window.rrweb?.record === 'function',
              hasUtils: typeof window.RrwebUtils !== 'undefined',
              hasSDK: typeof window.RecapSDK !== 'undefined'
            };
          }
        });

        Log.debug('Environment check:', checkResult?.[0]?.result);
        
        // Step 2: Inject rrweb, utils, and SDK if needed
        const { hasRrweb, hasSDK, hasUtils } = checkResult?.[0]?.result || {};
        
        if (!hasRrweb) {
          Log.debug('Injecting rrweb...');
          await chrome.scripting.executeScript({
            target: { tabId: State.activeTabId },
            files: ['lib/rrweb.min.js']
          });
        }
        
        if (!hasUtils) {
          Log.debug('Injecting RrwebUtils...');
          await chrome.scripting.executeScript({
            target: { tabId: State.activeTabId },
            files: ['lib/rrweb-utils.js']
          });
        }
        
        if (!hasSDK) {
          Log.debug('Injecting RecapSDK...');
          await chrome.scripting.executeScript({
            target: { tabId: State.activeTabId },
            files: ['lib/recorder.js']
          });
        }
        
        // Wait for scripts to initialize
        await new Promise(r => setTimeout(r, 200));
        
        // Verify SDK is ready
        const verifyResult = await chrome.scripting.executeScript({
          target: { tabId: State.activeTabId },
          func: () => ({
            hasRrweb: typeof window.rrweb !== 'undefined',
            hasUtils: typeof window.RrwebUtils !== 'undefined',
            hasSDK: typeof window.RecapSDK !== 'undefined',
            sdkVersion: window.RecapSDK?.VERSION || 'unknown'
          })
        });
        Log.debug('SDK verification:', verifyResult?.[0]?.result);

        // Step 3: Start recording using the production SDK (testMode)
        const config = State.testerConfig;
        
        Log.debug('Starting SDK with config:', {
          formName: config.form?.name,
          maskingSelectors: config.masking?.selectors?.length,
          rrwebOptions: Object.keys(config.rrweb_options || {})
        });
        
        const result = await chrome.scripting.executeScript({
          target: { tabId: State.activeTabId },
          func: (cfg) => {
            if (!window.RecapSDK) {
              return { success: false, error: 'RecapSDK failed to load' };
            }

            try {
              // Create isolated test state to capture events
              window.__RECAP_TEST__ = {
                events: [],
                sessionId: 'test_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                recording: false
              };
              
              console.log('[Recap Tester] Initializing SDK with config:', {
                formName: cfg.form?.name,
                maskSelectors: cfg.masking?.selectors,
                rrwebOptions: cfg.rrweb_options
              });
              
              // Listen for SDK events in test mode
              window.__RECAP_TEST__.listener = (event) => {
                if (event.source !== window) return;
                if (event.data?.source !== 'recap-sdk') return;
                
                if (event.data.type === 'RRWEB_EVENT') {
                  window.__RECAP_TEST__.events.push(event.data.payload.event);
                }
              };
              window.addEventListener('message', window.__RECAP_TEST__.listener);
              
              // Initialize SDK in test mode (won't auto-send to endpoint)
              window.RecapSDK.init({
                config: cfg,
                testMode: true,  // This captures events locally instead of sending
                debug: true
              });
              
              // Start recording
              window.RecapSDK.start();
              window.__RECAP_TEST__.recording = true;
              window.__RECAP_TEST__.sessionId = window.RecapSDK.getSessionId();

              return { 
                success: true, 
                sessionId: window.__RECAP_TEST__.sessionId,
                sdkVersion: window.RecapSDK.VERSION
              };

            } catch (e) {
              console.error('[Recap Tester] SDK init failed:', e);
              return { success: false, error: e.message };
            }
          },
          args: [config]
        });

        const res = result?.[0]?.result;
        console.log('[Recap Tester] Start result:', res);
        
        if (res?.success) {
          this.recording = true;
          this.updateUI();
          Toast.success('Recording started - ' + res.sessionId);
        } else {
          console.error('[Recap Tester] Start failed:', res?.error);
          Toast.error('Failed: ' + (res?.error || 'Unknown error'));
        }

      } catch (e) {
        console.error('[Recap Tester] Inject failed:', e);
        Toast.error('Failed to inject: ' + e.message);
      }
    },

    async stopRecording() {
      console.log('[Recap Tester] Stopping recording...');
      
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId: State.activeTabId },
          func: () => {
            const test = window.__RECAP_TEST__;
            if (!test) return { error: 'No test recording found' };

            // Stop SDK recording
            if (window.RecapSDK?.isRecording?.()) {
              window.RecapSDK.stop();
              console.log('[Recap Tester] SDK stopped');
            }
            
            // Remove event listener
            if (test.listener) {
              window.removeEventListener('message', test.listener);
            }
            
            test.recording = false;

            // Get events - combine from SDK and our listener
            // In test mode, SDK stores events internally too
            const sdkEvents = window.RecapSDK?.getEvents?.() || [];
            const listenerEvents = test.events || [];
            
            // Use whichever has more events (SDK's internal or our listener)
            const events = sdkEvents.length > listenerEvents.length ? sdkEvents : listenerEvents;
            
            console.log('[Recap Tester] Events collected:', {
              sdkEvents: sdkEvents.length,
              listenerEvents: listenerEvents.length,
              using: events.length
            });

            // Analyze events
            const typeCount = {};
            events.forEach(e => { typeCount[e.type] = (typeCount[e.type] || 0) + 1; });

            // Check for required FullSnapshot (type 2)
            const hasFullSnapshot = events.some(e => e.type === 2);

            // CRITICAL: Serialize to JSON string to avoid structured clone corruption
            let eventsJson = null;
            try {
              eventsJson = JSON.stringify(events);
            } catch (e) {
              console.error('[Recap Tester] Failed to serialize events:', e);
              return { error: 'Failed to serialize events: ' + e.message };
            }

            return {
              sessionId: test.sessionId || window.RecapSDK?.getSessionId?.(),
              eventsJson: eventsJson,
              eventCount: events.length,
              typeBreakdown: typeCount,
              hasFullSnapshot: hasFullSnapshot,
              sdkVersion: window.RecapSDK?.VERSION
            };
          }
        });

        const data = result?.[0]?.result;
        Log.debug('Stop result:', data?.eventCount, 'events');

        if (data?.error) {
          Toast.error(data.error);
          this.recording = false;
          this.updateUI();
          return;
        }

        if (!data?.hasFullSnapshot) {
          Toast.error('Recording missing DOM snapshot - replay may fail');
        }

        // Parse the JSON string back to events array
        let events = [];
        if (data?.eventsJson) {
          try {
            events = JSON.parse(data.eventsJson);
            Log.debug('Parsed', events.length, 'events from JSON');
          } catch (e) {
            Log.error('Failed to parse events JSON:', e);
            Toast.error('Failed to parse recorded events');
            this.recording = false;
            this.updateUI();
            return;
          }
        }

        if (events.length) {
          // Get tab URL
          let url = '';
          try {
            const tab = await chrome.tabs.get(State.activeTabId);
            url = tab?.url || '';
          } catch (e) {}

          // Calculate duration
          let duration = 0;
          if (events.length > 1) {
            duration = events[events.length - 1].timestamp - events[0].timestamp;
          }

          // Create session
          const session = {
            id: data.sessionId || `sess_${Date.now()}`,
            timestamp: Date.now(),
            url: url,
            eventCount: events.length,
            duration: duration,
            events: events,  // Use the parsed events
            config: State.testerConfig
          };

          Log.debug('Saving session:', session.id, 'with', session.events.length, 'events');

          await this.saveSession(session);
          State.testerSessions.unshift(session);

          // Enforce max sessions
          while (State.testerSessions.length > this.MAX_SESSIONS) {
            const old = State.testerSessions.pop();
            await this.deleteSession(old.id);
          }

          this.renderSessions();
          Toast.success(`Captured ${events.length} events`);

          // Switch to sessions tab
          window.Recap.Tabs?.switch('tester-sessions');
        } else {
          Toast.error('No events captured');
        }

        this.recording = false;
        this.updateUI();

      } catch (e) {
        Log.error('Stop failed:', e);
        Toast.error('Stop failed: ' + e.message);
        this.recording = false;
        this.updateUI();
      }
    },

    // ========================================
    // SESSION OPERATIONS (Uses shared Player)
    // ========================================

    replaySession(sessionId) {
      console.log('[Recap Tester] Replay requested:', sessionId);

      const session = State.testerSessions.find(s => s.id === sessionId);
      if (!session) {
        Toast.error('Session not found');
        return;
      }

      if (!session.events?.length) {
        Toast.error('No events in session');
        return;
      }

      // Log event details
      const typeCount = {};
      session.events.forEach(e => { typeCount[e.type] = (typeCount[e.type] || 0) + 1; });
      console.log('[Recap Tester] Session events:', {
        total: session.events.length,
        types: typeCount,
        hasFullSnapshot: session.events.some(e => e.type === 2)
      });

      // Debug: Check Meta event (type 4) for viewport
      const metaEvent = session.events.find(e => e.type === 4);
      if (metaEvent) {
        console.log('[Recap Tester] Meta event (viewport):', {
          href: metaEvent.data?.href,
          width: metaEvent.data?.width,
          height: metaEvent.data?.height
        });
      }

      // Debug: Check FullSnapshot structure
      const fullSnapshot = session.events.find(e => e.type === 2);
      if (fullSnapshot) {
        // Count actual child nodes in document
        const htmlNode = fullSnapshot.data?.node?.childNodes?.find(n => n?.tagName === 'html');
        const headNode = htmlNode?.childNodes?.find(n => n?.tagName === 'head');
        const bodyNode = htmlNode?.childNodes?.find(n => n?.tagName === 'body');
        
        console.log('[Recap Tester] FullSnapshot structure:', {
          hasData: !!fullSnapshot.data,
          hasNode: !!fullSnapshot.data?.node,
          nodeType: fullSnapshot.data?.node?.type,
          nodeId: fullSnapshot.data?.node?.id,
          documentChildCount: fullSnapshot.data?.node?.childNodes?.length,
          hasHtml: !!htmlNode,
          htmlChildCount: htmlNode?.childNodes?.length,
          hasHead: !!headNode,
          headChildCount: headNode?.childNodes?.length,
          hasBody: !!bodyNode,
          bodyChildCount: bodyNode?.childNodes?.length
        });
        
        // COMPARE with Trainer if available
        if (State.rrwebEvents?.length) {
          const trainerMeta = State.rrwebEvents.find(e => e.type === 4);
          const trainerFull = State.rrwebEvents.find(e => e.type === 2);
          const trainerHtml = trainerFull?.data?.node?.childNodes?.find(n => n?.tagName === 'html');
          const trainerBody = trainerHtml?.childNodes?.find(n => n?.tagName === 'body');
          
          console.log('[Recap Tester] COMPARISON - Trainer vs Tester:', {
            trainerViewport: trainerMeta?.data ? `${trainerMeta.data.width}x${trainerMeta.data.height}` : 'N/A',
            testerViewport: metaEvent?.data ? `${metaEvent.data.width}x${metaEvent.data.height}` : 'N/A',
            trainerBodyChildren: trainerBody?.childNodes?.length,
            testerBodyChildren: bodyNode?.childNodes?.length
          });
        }
      }

      // Use shared Player module
      const container = DOM.$('session-player-container');
      if (!container) {
        console.error('[Recap Tester] Container not found');
        return;
      }

      Modal.show('session-replay-modal');

      // Create player using shared module
      // Pass container size - Player will use recorded viewport and scale down
      const player = Player.create(container, session.events, {
        width: container.clientWidth || 900,
        height: container.clientHeight || 600,
        autoPlay: true
      });

      if (!player) {
        console.error('[Recap Tester] Player creation failed');
      }
    },

    downloadSession(sessionId) {
      const session = State.testerSessions.find(s => s.id === sessionId);
      if (!session) return;

      // Use shared Player download
      Player.download(session.events, {
        session_id: session.id,
        url: session.url,
        config: session.config?.form?.name || 'Unknown'
      }, `test-session-${sessionId}.json`);
    },

    async deleteSessionById(sessionId) {
      await this.deleteSession(sessionId);
      State.testerSessions = State.testerSessions.filter(s => s.id !== sessionId);
      this.renderSessions();
      Toast.info('Session deleted');
    },

    // ========================================
    // VALIDATION
    // ========================================

    async runValidation() {
      if (!State.testerConfig) {
        Toast.error('Load a configuration first');
        return;
      }

      try {
        const config = State.testerConfig;
        const results = await chrome.scripting.executeScript({
          target: { tabId: State.activeTabId },
          func: (cfg) => {
            const results = { masking: [], ignored: [], journey: [], success: null };

            (cfg.masking?.selectors || []).forEach(sel => {
              try {
                const count = document.querySelectorAll(sel).length;
                results.masking.push({ selector: sel, found: count, pass: count > 0 });
              } catch (e) {
                results.masking.push({ selector: sel, found: 0, pass: false, error: e.message });
              }
            });

            (cfg.ignored?.selectors || []).forEach(sel => {
              try {
                const count = document.querySelectorAll(sel).length;
                results.ignored.push({ selector: sel, found: count, pass: count > 0 });
              } catch (e) {
                results.ignored.push({ selector: sel, found: 0, pass: false, error: e.message });
              }
            });

            (cfg.journey?.steps || []).forEach(step => {
              const sel = step.selector || step;
              try {
                const count = document.querySelectorAll(sel).length;
                results.journey.push({ selector: sel, name: step.name, found: count, pass: count > 0 });
              } catch (e) {
                results.journey.push({ selector: sel, found: 0, pass: false, error: e.message });
              }
            });

            if (cfg.journey?.success_selector) {
              try {
                const count = document.querySelectorAll(cfg.journey.success_selector).length;
                results.success = { selector: cfg.journey.success_selector, found: count, pass: count > 0 };
              } catch (e) {
                results.success = { selector: cfg.journey.success_selector, found: 0, pass: false };
              }
            }

            return results;
          },
          args: [config]
        });

        this.renderValidationResults(results[0].result);

      } catch (e) {
        Toast.error('Validation failed');
      }
    },

    // ========================================
    // UI UPDATES
    // ========================================

    updateUI() {
      const configStatus = DOM.$('tester-config-status');
      const injectBtn = DOM.$('btn-inject-start');
      const stopBtn = DOM.$('btn-stop-capture');
      const validateBtn = DOM.$('btn-run-validation');
      const captureStatus = DOM.$('capture-status');

      if (configStatus) {
        if (State.testerConfig) {
          configStatus.classList.add('loaded');
          configStatus.innerHTML = `<span class="status-icon">✅</span><span class="status-text">Config loaded: ${State.testerConfig.form?.name || 'Unnamed'}</span>`;
        } else {
          configStatus.classList.remove('loaded');
          configStatus.innerHTML = `<span class="status-icon">⚠️</span><span class="status-text">No config loaded</span>`;
        }
      }

      if (injectBtn) {
        injectBtn.disabled = !State.testerConfig || this.recording;
        injectBtn.style.display = this.recording ? 'none' : 'inline-flex';
      }
      if (stopBtn) {
        stopBtn.style.display = this.recording ? 'inline-flex' : 'none';
      }
      if (validateBtn) {
        validateBtn.disabled = !State.testerConfig;
      }

      if (captureStatus) {
        const indicator = captureStatus.querySelector('.status-indicator');
        const text = captureStatus.querySelector('.status-text');
        const dot = captureStatus.querySelector('.status-dot');

        indicator?.classList.remove('idle', 'ready', 'recording');

        if (this.recording) {
          indicator?.classList.add('recording');
          if (dot) dot.style.display = 'inline-block';
          if (text) text.textContent = 'Recording in progress...';
        } else if (State.testerConfig) {
          indicator?.classList.add('ready');
          if (dot) dot.style.display = 'none';  // Hide dot, emoji in text
          if (text) text.textContent = '✅ Ready to capture';
        } else {
          indicator?.classList.add('idle');
          if (dot) dot.style.display = 'inline-block';
          if (text) text.textContent = 'Load a config to begin';
        }
      }

      DOM.$('session-count')?.replaceChildren(String(State.testerSessions.length));
    },

    updateConfigPreview() {
      const preview = DOM.$('tester-config-preview');
      if (!preview) return;

      if (State.testerConfig) {
        // Show a summary of what will be applied
        const cfg = State.testerConfig;
        const summary = {
          form: cfg.form?.name || 'Unknown',
          masking: {
            selectors: cfg.masking?.selectors?.length || 0,
            maskAllInputs: cfg.masking?.mask_all_inputs || false
          },
          ignored: cfg.ignored?.selectors?.length || 0,
          scrubKeys: cfg.network?.scrub_payload_keys?.length || 0,
          journeySteps: cfg.journey?.steps?.length || 0,
          rrweb: {
            ignoreSelector: cfg.rrweb_options?.ignoreSelector ? 'set' : 'none',
            maskTextSelector: cfg.rrweb_options?.maskTextSelector ? 'set' : 'none'
          }
        };
        preview.textContent = JSON.stringify(summary, null, 2);
      } else {
        preview.textContent = 'No config loaded';
      }
    },

    renderSessions() {
      const container = DOM.$('sessions-list');
      if (!container) return;

      if (!State.testerSessions.length) {
        container.innerHTML = `
          <div class="empty-state">
            <h3>No Sessions Yet</h3>
            <p>Capture a session using the Capture tab.</p>
          </div>
        `;
        return;
      }

      container.innerHTML = State.testerSessions.map(session => `
        <div class="session-item" data-id="${DOM.escapeAttr(session.id)}">
          <div class="session-item-header">
            <span class="session-id">${DOM.escapeHtml(session.id.slice(0, 16))}...</span>
            <span class="session-time">${new Date(session.timestamp).toLocaleString()}</span>
          </div>
          <div class="session-meta">
            <span>📊 ${session.eventCount} events</span>
            <span>⏱ ${Math.round(session.duration / 1000)}s</span>
          </div>
          <div class="session-actions">
            <button class="btn-replay-session" data-id="${DOM.escapeAttr(session.id)}">▶ Replay</button>
            <button class="btn-download-session" data-id="${DOM.escapeAttr(session.id)}">⬇ Download</button>
            <button class="btn-delete-session" data-id="${DOM.escapeAttr(session.id)}">🗑</button>
          </div>
        </div>
      `).join('');

      container.querySelectorAll('.btn-replay-session').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.replaySession(btn.dataset.id);
        });
      });

      container.querySelectorAll('.btn-download-session').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.downloadSession(btn.dataset.id);
        });
      });

      container.querySelectorAll('.btn-delete-session').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteSessionById(btn.dataset.id);
        });
      });
    },

    renderValidationResults(results) {
      const container = DOM.$('validation-results');
      if (!container) return;

      let html = '';

      if (results.masking.length) {
        html += '<h4>🔒 Masking Selectors</h4>';
        results.masking.forEach(r => {
          html += `
            <div class="validation-item ${r.pass ? 'pass' : 'fail'}">
              <span class="validation-icon">${r.pass ? '✅' : '❌'}</span>
              <span class="validation-selector">${DOM.escapeHtml(r.selector)}</span>
              <span class="validation-count">${r.found} found</span>
            </div>
          `;
        });
      }

      if (results.ignored.length) {
        html += '<h4>👁️ Ignored Selectors</h4>';
        results.ignored.forEach(r => {
          html += `
            <div class="validation-item ${r.pass ? 'pass' : 'fail'}">
              <span class="validation-icon">${r.pass ? '✅' : '❌'}</span>
              <span class="validation-selector">${DOM.escapeHtml(r.selector)}</span>
              <span class="validation-count">${r.found} found</span>
            </div>
          `;
        });
      }

      if (results.journey.length) {
        html += '<h4>📍 Journey Steps</h4>';
        results.journey.forEach(r => {
          html += `
            <div class="validation-item ${r.pass ? 'pass' : 'fail'}">
              <span class="validation-icon">${r.pass ? '✅' : '❌'}</span>
              <span class="validation-selector">${DOM.escapeHtml(r.name || r.selector)}</span>
              <span class="validation-count">${r.found} found</span>
            </div>
          `;
        });
      }

      if (results.success) {
        html += '<h4>✅ Success Trigger</h4>';
        html += `
          <div class="validation-item ${results.success.pass ? 'pass' : 'fail'}">
            <span class="validation-icon">${results.success.pass ? '✅' : '❌'}</span>
            <span class="validation-selector">${DOM.escapeHtml(results.success.selector)}</span>
            <span class="validation-count">${results.success.found} found</span>
          </div>
        `;
      }

      if (!html) {
        html = '<p class="empty-hint">No selectors configured to validate.</p>';
      }

      container.innerHTML = html;
    }
  };

  // Export
  window.Recap.Tester = Tester;
})();


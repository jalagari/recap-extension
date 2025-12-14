/**
 * Recap - Side Panel (Main Entry Point)
 * Orchestrates modular components
 * @version 3.1.0
 */

'use strict';

// Ensure Recap namespace exists
window.Recap = window.Recap || {};

(function() {
  const { 
    DOM, State, Toast, Modal, Messaging, MessageTypes, EventTypes, Log,
    Recording, Stats, Timeline, IgnoredFields,
    ConfigUI, ConfigExport, EventActions,
    Player, Tester
  } = window.Recap;

  // ============================================================================
  // TRAINER REPLAY (Uses shared Player)
  // ============================================================================

  const TrainerReplay = {
    maskingEnabled: false,

    init() {
      const container = DOM.$('replay-container');
      const controls = DOM.$('replay-controls');
      Log.debug('TrainerReplay.init called, container:', !!container, 'events:', State.rrwebEvents.length);
      if (!container) return;

      // Destroy existing player
      if (State.replayPlayer) {
        try { State.replayPlayer.$destroy?.(); } catch(e) {}
        State.replayPlayer = null;
      }

      if (!State.rrwebEvents.length) {
        container.innerHTML = Player.renderEmpty('No Recording Yet', 'Record a session first');
        if (controls) controls.style.display = 'none';
        return;
      }

      // Apply masking if enabled
      let events = State.rrwebEvents;
      if (this.maskingEnabled) {
        Log.debug('Applying masking to events, selectors:', State.config?.masking?.selectors);
        events = Player.applyMasking(events, State.config);
        Log.debug('Applied masking to', events.length, 'events');
      }

      container.innerHTML = '';
      if (controls) controls.style.display = 'flex';

      // Create player using shared module
      Log.debug('Creating player with', events.length, 'events in container:', container.id);
      try {
        State.replayPlayer = Player.create(container, events, {
          width: 340,
          height: 220,
          autoPlay: false
        });
        Log.debug('Player created:', !!State.replayPlayer);
      } catch (e) {
        Log.error('Failed to create player:', e);
        container.innerHTML = Player.renderEmpty('Replay Error', e.message);
      }

      Stats.updateReplay();
      this.updateMaskingButton();
    },

    toggleMasking() {
      this.maskingEnabled = !this.maskingEnabled;
      Log.debug('Masking toggled:', this.maskingEnabled ? 'ON' : 'OFF');
      this.updateMaskingButton();
      this.init();
    },

    updateMaskingButton() {
      const btn = DOM.$('btn-apply-config');
      if (btn) {
        if (this.maskingEnabled) {
          btn.classList.add('active');
          btn.textContent = '✓ Config Applied';
        } else {
          btn.classList.remove('active');
          btn.textContent = 'Apply Config';
        }
      }
    },

    play() {
      State.replayPlayer?.play?.();
    },

    openFullscreen() {
      if (!State.rrwebEvents.length) {
        Toast.error('No recording to replay');
        return;
      }

      const events = this.maskingEnabled 
        ? Player.applyMasking(State.rrwebEvents, State.config) 
        : State.rrwebEvents;

      Player.openFullscreen(events, 'replay-modal', 'fullscreen-player-container');
    },

    download() {
      Player.download(State.rrwebEvents, {
        form_id: State.config.formId,
        form_name: State.config.formName,
        timeline_events: State.events.filter(e => e.type !== 'session').length,
        config_applied: {
          masking: State.config.masking.selectors,
          scrub_keys: State.config.network.scrubKeys
        }
      }, `recap-${State.config.formId || 'recording'}-${Date.now()}.json`);
    }
  };

  // ============================================================================
  // TABS
  // ============================================================================

  const Tabs = {
    switch(tabId) {
      const isTesterTab = tabId.startsWith('tester-');
      const tabSelector = isTesterTab ? '.tester-tabs .tab' : '#mode-trainer .tabs .tab';

      DOM.$$(tabSelector).forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));

      if (isTesterTab) {
        DOM.$$('#mode-tester .tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tabId}`));
      } else {
        DOM.$$('#mode-trainer .tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tabId}`));

        if (tabId === 'config') ConfigUI.update();
        if (tabId === 'replay') TrainerReplay.init();
        if (tabId === 'ignored') IgnoredFields.render();
      }
    }
  };

  // ============================================================================
  // MODE SWITCHING
  // ============================================================================

  const Mode = {
    switch(mode) {
      State.currentMode = mode;

      DOM.$$('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
      });

      DOM.$$('.mode-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `mode-${mode}`);
      });

      if (mode === 'tester') {
        Tester.init();
      }

      Log.debug('Switched to mode:', mode);
    }
  };

  // ============================================================================
  // MESSAGE HANDLERS
  // ============================================================================

  const MessageHandlers = {
    [MessageTypes.RRWEB_STATUS]: (payload) => {
      if (payload?.hasRrweb) Toast.success(`rrweb ${payload.version || ''} loaded`);
    },

    [MessageTypes.RECORDING_STARTED]: (payload) => {
      Log.debug('RECORDING_STARTED received:', payload);
      const wasRecording = State.isRecording;

      State.isRecording = true;
      if (!wasRecording) {
        State.recordingStartTime = payload?.timestamp || Date.now();
        Timeline.add({ type: EventTypes.SESSION, subtype: 'start', timestamp: Date.now(), data: { message: 'Recording started' } });
      } else {
        Log.debug('Recording resumed, preserving', State.events.length, 'timeline events');
      }
      Recording.updateUI(true);
    },

    [MessageTypes.RECORDING_STOPPED]: (payload) => {
      State.isRecording = false;
      Recording.updateUI(false);
      Timeline.add({ type: EventTypes.SESSION, subtype: 'end', timestamp: Date.now(), data: { rrwebEvents: payload?.eventCount } });
      Toast.info(`Recorded ${State.rrwebEvents.length} events`);
      DOM.$('btn-save').disabled = !State.events.length;
    },

    [MessageTypes.RECORDING_ERROR]: (payload) => {
      Toast.error(payload?.message || 'Recording error');
    },

    [MessageTypes.RRWEB_EVENT]: (payload) => {
      if (payload?.event) {
        State.rrwebEvents.push(payload.event);
        // Debug: Log important events
        if (payload.event.type === 2) {
          console.log('[Recap Panel] FullSnapshot received, nodes:', 
            payload.event.data?.node?.childNodes?.length || 0);
        }
      }
      Stats.update();
      Stats.updateReplay();
    },

    [MessageTypes.TIMELINE_EVENT]: (payload) => {
      Log.debug('TIMELINE_EVENT received:', payload?.type);
      if (payload) Timeline.add(payload);
    },

    RECORDING_RESUMED: (payload) => {
      Log.debug('RECORDING_RESUMED from:', payload?.fromUrl);
      State.isRecording = true;
      Recording.updateUI(true);
      Timeline.add({ type: 'navigation', subtype: 'redirect', timestamp: Date.now(), data: { fromUrl: payload?.fromUrl, eventCount: payload?.eventCount } });
      Toast.success('Recording continued after redirect');
    }
  };

  // ============================================================================
  // APP INITIALIZATION
  // ============================================================================

  const App = {
    async init() {
      Log.info(`Panel v${window.Recap.Config.VERSION}`);

      try {
        await this.getActiveTab();
        this.setupEventListeners();
        this.setupMessageListeners();
        await this.loadConfig();
        this.checkRrwebStatus();
      } catch (e) {
        Log.error('Init failed:', e);
        Toast.error('Initialization failed');
      }
    },

    async getActiveTab() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      State.activeTabId = tab?.id ?? null;

      if (State.activeTabId) {
        try {
          const response = await Messaging.sendToTab(MessageTypes.GET_FORM_INFO);
          if (response?.success && response.formInfo) {
            State.config.formName = response.formInfo.formName || '';
            State.config.formId = response.formInfo.formId || '';
            State.config.pathPattern = this.extractPathPattern(response.formInfo.pathname || '');
            DOM.$('form-name').value = State.config.formName;
          }
        } catch (e) { /* Content script not ready */ }
      }
    },

    extractPathPattern(pathname) {
      if (!pathname || pathname === '/') return '/';
      return pathname.replace(/\/$/, '')
        .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
        .replace(/\/\d+(?=\/|$)/g, '/:id')
        .replace(/\/[a-z0-9]{10,}(?=\/|$)/gi, '/:hash');
    },

    setupEventListeners() {
      // Mode toggle
      DOM.$$('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => Mode.switch(btn.dataset.mode));
      });

      // Recording
      DOM.$('btn-record')?.addEventListener('click', () => Recording.toggle());

      // Form settings
      DOM.$('form-name')?.addEventListener('change', e => State.config.formName = e.target.value);
      DOM.$('sampling-rate')?.addEventListener('input', e => {
        const val = parseInt(e.target.value, 10);
        DOM.$('sampling-value').textContent = `${val}%`;
        State.config.samplingRate = val / 100;
      });

      // Tabs
      DOM.$$('.tab').forEach(t => t.addEventListener('click', () => Tabs.switch(t.dataset.tab)));

      // Filters
      DOM.$$('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          DOM.$$('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          State.activeFilter = btn.dataset.filter || EventTypes.ALL;
          Timeline.render();
        });
      });

      // Show All Toggle
      DOM.$('toggle-show-all')?.addEventListener('change', e => {
        State.showAllEvents = e.target.checked;
        Timeline.render();
      });

      // Options
      DOM.$('mask-all-inputs')?.addEventListener('change', e => State.config.masking.maskAllInputs = e.target.checked);
      DOM.$('capture-console')?.addEventListener('change', e => State.config.options.captureConsole = e.target.checked);

      // Tester mode
      DOM.$('btn-use-current-config')?.addEventListener('click', () => Tester.useCurrentConfig());
      DOM.$('btn-load-config-file')?.addEventListener('click', () => DOM.$('config-file-input')?.click());
      DOM.$('config-file-input')?.addEventListener('change', e => {
        if (e.target.files?.[0]) Tester.loadConfigFile(e.target.files[0]);
      });
      DOM.$('btn-inject-start')?.addEventListener('click', () => Tester.injectAndStart());
      DOM.$('btn-stop-capture')?.addEventListener('click', () => Tester.stopRecording());
      DOM.$('btn-clear-sessions')?.addEventListener('click', () => Tester.clearAllSessions());
      DOM.$('btn-run-validation')?.addEventListener('click', () => Tester.runValidation());

      // Actions
      DOM.$('btn-reset')?.addEventListener('click', () => {
        if (!confirm('Reset all events and configuration?')) return;
        if (State.isRecording) Recording.stop();
        State.reset();
        DOM.$('event-count').textContent = '0';
        DOM.$('btn-save').disabled = true;
        Stats.update();
        ConfigUI.update();
        Timeline.render();
        Toast.info('Reset complete');
      });
      DOM.$('btn-save')?.addEventListener('click', () => ConfigExport.save());
      DOM.$('btn-export')?.addEventListener('click', () => ConfigExport.download());

      // Replay
      DOM.$('btn-play-replay')?.addEventListener('click', () => TrainerReplay.play());
      DOM.$('btn-fullscreen')?.addEventListener('click', () => TrainerReplay.openFullscreen());
      DOM.$('btn-download-recording')?.addEventListener('click', () => TrainerReplay.download());
      DOM.$('btn-apply-config')?.addEventListener('click', () => TrainerReplay.toggleMasking());

      // Modals
      DOM.$$('.modal-backdrop').forEach(el => el.addEventListener('click', () => Modal.hide(el.closest('.modal')?.id)));
      DOM.$$('.modal-close').forEach(el => el.addEventListener('click', () => Modal.hide(el.closest('.modal')?.id)));
      document.addEventListener('keydown', e => e.key === 'Escape' && Modal.hideAll());
    },

    setupMessageListeners() {
      Messaging.onMessage((msg, sender, respond) => {
        Log.debug('Received message:', msg?.type);
        const handler = MessageHandlers[msg?.type];
        if (handler) {
          handler(msg.payload);
          respond({ success: true });
        } else {
          Log.warn('No handler for:', msg?.type);
          respond({ success: false });
        }
      });

      chrome.tabs.onActivated.addListener(async ({ tabId }) => {
        State.activeTabId = tabId;
        if (State.isRecording) {
          await Recording.stop();
          Toast.info('Recording stopped - tab changed');
        }
        if (Tester.recording) {
          Tester.recording = false;
          Tester.updateUI();
        }
        setTimeout(() => this.checkRrwebStatus(), 500);
      });

      chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (tabId === State.activeTabId && changeInfo.status === 'complete') {
          if (Tester.recording) {
            Tester.recording = false;
            Tester.updateUI();
            Toast.info('Test recording stopped - page reloaded');
          }
        }
      });
    },

    async checkRrwebStatus() {
      if (!State.activeTabId) return;
      try {
        await Messaging.sendToTab('CHECK_RRWEB');
      } catch (e) { /* Will get status via message */ }
    },

    async loadConfig() {
      try {
        await chrome.storage.local.get(null);
      } catch (e) { /* No stored config */ }
    }
  };

  // Export
  window.Recap.TrainerReplay = TrainerReplay;
  window.Recap.Tabs = Tabs;
  window.Recap.Mode = Mode;
  window.Recap.App = App;

  // Bootstrap
  document.addEventListener('DOMContentLoaded', () => App.init());
})();


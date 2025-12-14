/**
 * Recap - Recording Module
 * Controls recording start/stop and UI updates
 * @version 1.0.0
 */

'use strict';

(function() {
  const { DOM, State, Toast, Messaging, MessageTypes, Log } = window.Recap;

  // ============================================================================
  // RECORDING CONTROL
  // ============================================================================

  const Recording = {
    async start() {
      if (!State.activeTabId) {
        Toast.error('No active tab');
        return;
      }

      State.reset();
      State.recordingStartTime = Date.now();

      try {
        Log.debug('Starting recording with config:', State.config);
        await Messaging.sendToTab(MessageTypes.START_RECORDING, {
          config: State.config
        });
        Toast.info('Starting recording...');
      } catch (e) {
        Log.error('Failed to start:', e);
        Toast.error('Failed to start - reload the page');
      }
    },

    async stop() {
      if (!State.isRecording) return;
      try {
        await Messaging.sendToTab(MessageTypes.STOP_RECORDING);
      } catch (e) {
        State.isRecording = false;
        this.updateUI(false);
      }
    },

    toggle() {
      State.isRecording ? this.stop() : this.start();
    },

    updateUI(recording) {
      const btn = DOM.$('btn-record');
      const status = DOM.$('recording-status');

      if (recording) {
        btn?.classList.add('recording');
        status?.classList.add('recording');
        btn?.querySelector('.btn-text')?.replaceChildren('Stop');
        status?.querySelector('.status-text')?.replaceChildren('Recording with rrweb');
        this.startTimer();
      } else {
        btn?.classList.remove('recording');
        status?.classList.remove('recording');
        btn?.querySelector('.btn-text')?.replaceChildren('Start Recording');
        status?.querySelector('.status-text')?.replaceChildren('Ready to record');
        DOM.$('recording-time')?.replaceChildren('00:00');
        this.stopTimer();
      }
    },

    startTimer() {
      this.stopTimer();
      State.recordingTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - State.recordingStartTime) / 1000);
        const time = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
        DOM.$('recording-time')?.replaceChildren(time);
      }, 1000);
    },

    stopTimer() {
      if (State.recordingTimer) {
        clearInterval(State.recordingTimer);
        State.recordingTimer = null;
      }
    }
  };

  // ============================================================================
  // STATS
  // ============================================================================

  const Stats = {
    update() {
      DOM.$('stat-events')?.replaceChildren(String(State.rrwebEvents.length || State.events.length));
      DOM.$('stat-masked')?.replaceChildren(String(State.config.masking.selectors.length));
      DOM.$('stat-network')?.replaceChildren(String(State.events.filter(e => e.type === 'network').length));
      DOM.$('stat-errors')?.replaceChildren(String(State.events.filter(e => e.type === 'error').length));
    },

    updateReplay() {
      const events = State.rrwebEvents;
      DOM.$('replay-event-count')?.replaceChildren(`${events.length} events`);
      DOM.$('replay-stat-events')?.replaceChildren(String(events.length));
      DOM.$('replay-stat-masked')?.replaceChildren(String(State.config.masking.selectors.length));
      DOM.$('replay-stat-network')?.replaceChildren(String(State.events.filter(e => e.type === 'network').length));

      if (events.length >= 2) {
        const dur = (events[events.length - 1].timestamp - events[0].timestamp) / 1000;
        DOM.$('replay-duration')?.replaceChildren(`${Math.floor(dur / 60)}:${Math.floor(dur % 60).toString().padStart(2, '0')}`);
        DOM.$('replay-stat-duration')?.replaceChildren(`${Math.floor(dur)}s`);
      }
    }
  };

  // Export
  window.Recap.Recording = Recording;
  window.Recap.Stats = Stats;
})();



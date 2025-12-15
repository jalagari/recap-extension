/**
 * Recap - Library Module
 * Dashboard for managing stored configurations and recordings
 * @version 1.0.0
 */

'use strict';

(function() {
  const { DOM, State, Toast, Modal, Log, Storage, Player } = window.Recap;

  // ============================================================================
  // LIBRARY - Dashboard for configs and recordings
  // ============================================================================

  const Library = {
    currentView: 'configs', // 'configs' | 'recordings'
    selectedConfig: null,
    selectedRecording: null,
    
    // ========================================
    // INITIALIZATION
    // ========================================
    
    async init() {
      await this.refresh();
      this.bindEvents();
    },
    
    bindEvents() {
      // Tab switching
      DOM.$('lib-tab-configs')?.addEventListener('click', () => this.switchView('configs'));
      DOM.$('lib-tab-recordings')?.addEventListener('click', () => this.switchView('recordings'));
      
      // Actions
      DOM.$('btn-lib-import-config')?.addEventListener('click', () => this.importConfig());
      DOM.$('btn-lib-import-recording')?.addEventListener('click', () => this.importRecording());
      DOM.$('lib-import-config-file')?.addEventListener('change', (e) => this.handleConfigImport(e));
      DOM.$('lib-import-recording-file')?.addEventListener('change', (e) => this.handleRecordingImport(e));
    },
    
    // ========================================
    // VIEW MANAGEMENT
    // ========================================
    
    switchView(view) {
      this.currentView = view;
      
      // Update tab states
      DOM.$('lib-tab-configs')?.classList.toggle('active', view === 'configs');
      DOM.$('lib-tab-recordings')?.classList.toggle('active', view === 'recordings');
      
      // Show/hide content
      DOM.$('lib-configs-panel')?.classList.toggle('hidden', view !== 'configs');
      DOM.$('lib-recordings-panel')?.classList.toggle('hidden', view !== 'recordings');
      
      this.render();
    },
    
    async refresh() {
      State.libraryConfigs = await Storage.getConfigs();
      State.libraryRecordings = await Storage.getRecordings();
      this.render();
    },
    
    // ========================================
    // RENDERING
    // ========================================
    
    render() {
      if (this.currentView === 'configs') {
        this.renderConfigs();
      } else {
        this.renderRecordings();
      }
      this.updateStats();
    },
    
    renderConfigs() {
      const container = DOM.$('lib-configs-list');
      if (!container) return;
      
      const configs = State.libraryConfigs || [];
      
      if (!configs.length) {
        container.innerHTML = `
          <div class="lib-empty">
            <div class="lib-empty-icon">📋</div>
            <h3>No Configurations</h3>
            <p>Save a configuration from the Trainer or import one</p>
          </div>
        `;
        return;
      }
      
      // Sort by updated_at descending
      const sorted = [...configs].sort((a, b) => 
        new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at)
      );
      
      container.innerHTML = sorted.map(config => this.renderConfigCard(config)).join('');
      
      // Bind card events
      container.querySelectorAll('.lib-card').forEach(card => {
        const id = card.dataset.id;
        card.querySelector('.lib-card-select')?.addEventListener('click', () => this.selectConfig(id));
        card.querySelector('.lib-card-view')?.addEventListener('click', () => this.viewConfig(id));
        card.querySelector('.lib-card-export')?.addEventListener('click', () => this.exportConfig(id));
        card.querySelector('.lib-card-delete')?.addEventListener('click', () => this.deleteConfig(id));
      });
    },
    
    renderConfigCard(config) {
      const maskCount = config.masking?.selectors?.length || 0;
      const ignoreCount = config.ignored?.selectors?.length || 0;
      const linkedRecordings = (State.libraryRecordings || []).filter(r => r.config_id === config.id).length;
      const isSelected = this.selectedConfig?.id === config.id;
      
      return `
        <div class="lib-card ${isSelected ? 'selected' : ''}" data-id="${DOM.escapeAttr(config.id)}">
          <div class="lib-card-header">
            <div class="lib-card-icon">📋</div>
            <div class="lib-card-title">
              <h4>${DOM.escapeHtml(config.form?.name || 'Unnamed Config')}</h4>
              <span class="lib-card-date">${this.formatDate(config.updated_at || config.created_at)}</span>
            </div>
          </div>
          <div class="lib-card-meta">
            <span class="lib-card-stat" title="Masked fields">🔒 ${maskCount}</span>
            <span class="lib-card-stat" title="Ignored fields">👁 ${ignoreCount}</span>
            <span class="lib-card-stat" title="Linked recordings">🎬 ${linkedRecordings}</span>
          </div>
          <div class="lib-card-actions">
            <button class="lib-card-select" title="Use this config">Use</button>
            <button class="lib-card-view" title="View details">View</button>
            <button class="lib-card-export" title="Export">↓</button>
            <button class="lib-card-delete" title="Delete">🗑</button>
          </div>
        </div>
      `;
    },
    
    renderRecordings() {
      const container = DOM.$('lib-recordings-list');
      if (!container) return;
      
      const recordings = State.libraryRecordings || [];
      
      if (!recordings.length) {
        container.innerHTML = `
          <div class="lib-empty">
            <div class="lib-empty-icon">🎬</div>
            <h3>No Recordings</h3>
            <p>Capture a recording from the Trainer or import one</p>
          </div>
        `;
        return;
      }
      
      // Sort by created_at descending
      const sorted = [...recordings].sort((a, b) => 
        new Date(b.created_at) - new Date(a.created_at)
      );
      
      container.innerHTML = sorted.map(rec => this.renderRecordingCard(rec)).join('');
      
      // Bind card events
      container.querySelectorAll('.lib-card').forEach(card => {
        const id = card.dataset.id;
        card.querySelector('.lib-card-play')?.addEventListener('click', () => this.playRecording(id));
        card.querySelector('.lib-card-link')?.addEventListener('click', () => this.showLinkModal(id));
        card.querySelector('.lib-card-export')?.addEventListener('click', () => this.exportRecording(id));
        card.querySelector('.lib-card-delete')?.addEventListener('click', () => this.deleteRecording(id));
      });
    },
    
    renderRecordingCard(recording) {
      const events = recording.events || recording.rrweb_events || [];
      const duration = recording.metadata?.duration_ms || recording.duration || 0;
      const linkedConfig = (State.libraryConfigs || []).find(c => c.id === recording.config_id);
      const isSelected = this.selectedRecording?.id === recording.id;
      
      return `
        <div class="lib-card ${isSelected ? 'selected' : ''}" data-id="${DOM.escapeAttr(recording.id)}">
          <div class="lib-card-header">
            <div class="lib-card-icon">🎬</div>
            <div class="lib-card-title">
              <h4>${DOM.escapeHtml(recording.form_name || recording.name || 'Recording')}</h4>
              <span class="lib-card-date">${this.formatDate(recording.created_at)}</span>
            </div>
          </div>
          <div class="lib-card-meta">
            <span class="lib-card-stat" title="Events">📊 ${events.length}</span>
            <span class="lib-card-stat" title="Duration">⏱ ${this.formatDuration(duration)}</span>
            ${linkedConfig ? `<span class="lib-card-stat linked" title="Linked to ${linkedConfig.form?.name}">🔗 Config</span>` : ''}
          </div>
          <div class="lib-card-actions">
            <button class="lib-card-play" title="Play recording">▶ Play</button>
            <button class="lib-card-link" title="Link to config">🔗</button>
            <button class="lib-card-export" title="Export">↓</button>
            <button class="lib-card-delete" title="Delete">🗑</button>
          </div>
        </div>
      `;
    },
    
    updateStats() {
      const configCount = DOM.$('lib-config-count');
      const recordingCount = DOM.$('lib-recording-count');
      
      if (configCount) {
        configCount.textContent = `${(State.libraryConfigs || []).length}/${Storage.MAX_CONFIGS}`;
      }
      if (recordingCount) {
        recordingCount.textContent = `${(State.libraryRecordings || []).length}/${Storage.MAX_RECORDINGS}`;
      }
    },
    
    // ========================================
    // CONFIG OPERATIONS
    // ========================================
    
    async selectConfig(id) {
      const config = await Storage.getConfig(id);
      if (!config) {
        Toast.error('Config not found');
        return;
      }
      
      this.selectedConfig = config;
      
      // Load into State.config for Trainer use
      State.config = {
        formId: config.form?.id || '',
        formName: config.form?.name || '',
        masking: {
          selectors: config.masking?.selectors || [],
          maskAllInputs: config.masking?.mask_all_inputs || false
        },
        ignored: {
          selectors: config.ignored?.selectors || []
        },
        network: {
          scrubKeys: config.network?.scrub_payload_keys || []
        },
        journey: {
          steps: config.journey?.steps || [],
          successSelector: config.journey?.success_selector || ''
        },
        rrwebOptions: config.rrweb_options || {}
      };
      
      // Update form name input
      const formInput = DOM.$('form-name');
      if (formInput) formInput.value = config.form?.name || '';
      
      this.render();
      Toast.success(`Loaded: ${config.form?.name || 'Config'}`);
      
      // Switch to Trainer mode
      window.Recap.Panel?.switchMode?.('trainer');
    },
    
    async viewConfig(id) {
      const config = await Storage.getConfig(id);
      if (!config) return;
      
      Modal.content('Configuration Details', `
        <div class="lib-detail">
          <div class="lib-detail-section">
            <h4>Form</h4>
            <p><strong>Name:</strong> ${DOM.escapeHtml(config.form?.name || 'N/A')}</p>
            <p><strong>ID:</strong> ${DOM.escapeHtml(config.form?.id || 'N/A')}</p>
          </div>
          <div class="lib-detail-section">
            <h4>Masking (${config.masking?.selectors?.length || 0})</h4>
            <ul class="lib-detail-list">
              ${(config.masking?.selectors || []).map(s => `<li>${DOM.escapeHtml(s)}</li>`).join('') || '<li>None</li>'}
            </ul>
          </div>
          <div class="lib-detail-section">
            <h4>Ignored (${config.ignored?.selectors?.length || 0})</h4>
            <ul class="lib-detail-list">
              ${(config.ignored?.selectors || []).map(s => `<li>${DOM.escapeHtml(s)}</li>`).join('') || '<li>None</li>'}
            </ul>
          </div>
          <div class="lib-detail-section">
            <h4>Network Scrub Keys</h4>
            <ul class="lib-detail-list">
              ${(config.network?.scrub_payload_keys || []).map(k => `<li>${DOM.escapeHtml(k)}</li>`).join('') || '<li>None</li>'}
            </ul>
          </div>
        </div>
      `, 'event-modal');
    },
    
    async exportConfig(id) {
      const config = await Storage.getConfig(id);
      if (!config) return;
      
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recap-config-${config.form?.name?.replace(/\s+/g, '-') || id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      
      Toast.success('Config exported');
    },
    
    async deleteConfig(id) {
      if (!confirm('Delete this configuration?')) return;
      
      await Storage.deleteConfig(id);
      if (this.selectedConfig?.id === id) {
        this.selectedConfig = null;
      }
      await this.refresh();
      Toast.info('Config deleted');
    },
    
    importConfig() {
      DOM.$('lib-import-config-file')?.click();
    },
    
    async handleConfigImport(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      
      try {
        const text = await file.text();
        const config = JSON.parse(text);
        
        // Validate basic structure
        if (!config.form && !config.masking) {
          throw new Error('Invalid config format');
        }
        
        // Generate new ID for imported config
        config.id = null;
        await Storage.saveConfig(config);
        await this.refresh();
        
        Toast.success(`Imported: ${config.form?.name || file.name}`);
      } catch (err) {
        Toast.error('Import failed: ' + err.message);
      }
      
      e.target.value = '';
    },
    
    // ========================================
    // RECORDING OPERATIONS
    // ========================================
    
    async playRecording(id) {
      const recording = await Storage.getRecording(id);
      if (!recording) {
        Toast.error('Recording not found');
        return;
      }
      
      this.selectedRecording = recording;
      
      const events = recording.events || recording.rrweb_events || [];
      if (!events.length) {
        Toast.error('No events in recording');
        return;
      }
      
      // Load into state for replay
      State.rrwebEvents = events;
      
      // Switch to Trainer Replay tab
      window.Recap.Panel?.switchMode?.('trainer');
      window.Recap.Tabs?.switch?.('tab-replay');
      
      // Init replay
      setTimeout(() => {
        window.Recap.TrainerReplay?.init?.();
      }, 100);
      
      this.render();
      Toast.success(`Loaded ${events.length} events`);
    },
    
    async showLinkModal(recordingId) {
      const recording = await Storage.getRecording(recordingId);
      if (!recording) return;
      
      const configs = State.libraryConfigs || [];
      
      Modal.content('Link to Configuration', `
        <div class="lib-link-modal">
          <p>Select a configuration to link this recording to:</p>
          <div class="lib-link-options">
            ${configs.length ? configs.map(c => `
              <button class="lib-link-option ${recording.config_id === c.id ? 'active' : ''}" 
                      data-config-id="${DOM.escapeAttr(c.id)}">
                📋 ${DOM.escapeHtml(c.form?.name || 'Unnamed')}
              </button>
            `).join('') : '<p class="empty-hint">No configurations available</p>'}
            ${recording.config_id ? `
              <button class="lib-link-option unlink" data-config-id="">
                ❌ Remove Link
              </button>
            ` : ''}
          </div>
        </div>
      `, 'event-modal');
      
      // Bind link buttons
      document.querySelectorAll('.lib-link-option').forEach(btn => {
        btn.addEventListener('click', async () => {
          const configId = btn.dataset.configId || null;
          await Storage.linkRecordingToConfig(recordingId, configId);
          Modal.hide('event-modal');
          await this.refresh();
          Toast.success(configId ? 'Recording linked to config' : 'Link removed');
        });
      });
    },
    
    async exportRecording(id) {
      const recording = await Storage.getRecording(id);
      if (!recording) return;
      
      const blob = new Blob([JSON.stringify(recording, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recap-recording-${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      
      Toast.success('Recording exported');
    },
    
    async deleteRecording(id) {
      if (!confirm('Delete this recording?')) return;
      
      await Storage.deleteRecording(id);
      if (this.selectedRecording?.id === id) {
        this.selectedRecording = null;
      }
      await this.refresh();
      Toast.info('Recording deleted');
    },
    
    importRecording() {
      DOM.$('lib-import-recording-file')?.click();
    },
    
    async handleRecordingImport(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        
        // Support various formats
        const events = data.rrweb_events || data.events || (Array.isArray(data) ? data : null);
        if (!events?.length) {
          throw new Error('No events found in file');
        }
        
        const recording = {
          id: null,
          name: file.name.replace('.json', ''),
          form_name: data.form_name || data.metadata?.form_name || file.name,
          events: events,
          metadata: data.metadata || {
            event_count: events.length,
            duration_ms: events.length > 1 ? events[events.length - 1].timestamp - events[0].timestamp : 0
          }
        };
        
        await Storage.saveRecording(recording);
        await this.refresh();
        
        Toast.success(`Imported: ${recording.form_name}`);
      } catch (err) {
        Toast.error('Import failed: ' + err.message);
      }
      
      e.target.value = '';
    },
    
    // ========================================
    // SAVE FROM TRAINER
    // ========================================
    
    async saveCurrentConfig() {
      const ConfigExport = window.Recap.ConfigExport;
      if (!ConfigExport) {
        Toast.error('Config module not loaded');
        return;
      }
      
      const config = ConfigExport.build();
      await Storage.saveConfig(config);
      await this.refresh();
      
      Toast.success('Configuration saved to library');
    },
    
    async saveCurrentRecording() {
      if (!State.rrwebEvents?.length) {
        Toast.error('No recording to save');
        return;
      }
      
      const recording = {
        id: null,
        name: State.config?.formName || 'Recording',
        form_name: State.config?.formName || 'Recording',
        config_id: this.selectedConfig?.id || null,
        events: State.rrwebEvents,
        metadata: {
          event_count: State.rrwebEvents.length,
          duration_ms: State.rrwebEvents.length > 1 
            ? State.rrwebEvents[State.rrwebEvents.length - 1].timestamp - State.rrwebEvents[0].timestamp 
            : 0
        }
      };
      
      await Storage.saveRecording(recording);
      await this.refresh();
      
      Toast.success('Recording saved to library');
    },
    
    // ========================================
    // UTILITIES
    // ========================================
    
    formatDate(dateStr) {
      if (!dateStr) return 'Unknown';
      const date = new Date(dateStr);
      const now = new Date();
      const diff = now - date;
      
      if (diff < 60000) return 'Just now';
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
      
      return date.toLocaleDateString();
    },
    
    formatDuration(ms) {
      if (!ms) return '0:00';
      const secs = Math.floor(ms / 1000);
      const mins = Math.floor(secs / 60);
      const remainSecs = secs % 60;
      return `${mins}:${remainSecs.toString().padStart(2, '0')}`;
    }
  };

  // Export
  window.Recap.Library = Library;
})();


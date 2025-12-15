/**
 * Recap - Dashboard Module
 * UI for managing stored configurations and recordings
 * @version 1.0.0
 */

'use strict';

(function() {
  const { DOM, State, Toast, Modal, Log, Storage, Player } = window.Recap;

  // ============================================================================
  // DASHBOARD - Config & Recording Management UI
  // ============================================================================

  const Dashboard = {
    currentConfig: null,
    currentRecording: null,
    
    /**
     * Initialize dashboard
     */
    async init() {
      try {
        await Storage.init();
        await this.refresh();
        this.setupEventListeners();
        Log?.debug('Dashboard initialized');
      } catch (e) {
        Log?.error('Dashboard init failed:', e);
      }
    },
    
    /**
     * Refresh dashboard data
     */
    async refresh() {
      await this.renderConfigs();
      await this.renderRecordings();
      await this.updateStats();
    },
    
    /**
     * Setup event listeners
     */
    setupEventListeners() {
      // Config actions
      DOM.$('btn-save-to-storage')?.addEventListener('click', () => this.saveCurrentConfig());
      DOM.$('btn-new-config')?.addEventListener('click', () => this.createNewConfig());
      
      // Recording actions
      DOM.$('btn-save-recording-to-storage')?.addEventListener('click', () => this.saveCurrentRecording());
      
      // Import/Export
      DOM.$('btn-import-config')?.addEventListener('click', () => DOM.$('import-config-file')?.click());
      DOM.$('import-config-file')?.addEventListener('change', (e) => this.importConfig(e.target.files[0]));
      DOM.$('btn-import-recording')?.addEventListener('click', () => DOM.$('import-recording-file')?.click());
      DOM.$('import-recording-file')?.addEventListener('change', (e) => this.importRecording(e.target.files[0]));
    },
    
    // ========================================
    // CONFIG MANAGEMENT
    // ========================================
    
    async renderConfigs() {
      const container = DOM.$('stored-configs-list');
      if (!container) return;
      
      const configs = await Storage.getConfigs();
      
      if (!configs.length) {
        container.innerHTML = `
          <div class="empty-state-small">
            <p>No saved configurations</p>
            <button class="btn btn-sm" id="btn-save-first-config">💾 Save Current</button>
          </div>
        `;
        DOM.$('btn-save-first-config')?.addEventListener('click', () => this.saveCurrentConfig());
        return;
      }
      
      container.innerHTML = configs.map(config => `
        <div class="storage-item config-item ${this.currentConfig?.id === config.id ? 'active' : ''}" data-id="${DOM.escapeAttr(config.id)}">
          <div class="storage-item-icon">📋</div>
          <div class="storage-item-body">
            <div class="storage-item-title">${DOM.escapeHtml(config.form?.name || 'Unnamed Config')}</div>
            <div class="storage-item-meta">
              <span>${config.masking?.selectors?.length || 0} masks</span>
              <span>•</span>
              <span>${this._formatDate(config.updated_at || config.created_at)}</span>
            </div>
          </div>
          <div class="storage-item-actions">
            <button class="btn-icon" data-action="load" title="Load"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7-7 7 7"/></svg></button>
            <button class="btn-icon" data-action="export" title="Export"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg></button>
            <button class="btn-icon btn-danger" data-action="delete" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
          </div>
        </div>
      `).join('');
      
      // Attach handlers
      container.querySelectorAll('.config-item').forEach(item => {
        const id = item.dataset.id;
        item.querySelector('[data-action="load"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.loadConfig(id);
        });
        item.querySelector('[data-action="export"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.exportConfig(id);
        });
        item.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteConfig(id);
        });
        item.addEventListener('click', () => this.loadConfig(id));
      });
    },
    
    async loadConfig(id) {
      try {
        const config = await Storage.getConfig(id);
        if (!config) {
          Toast.error('Config not found');
          return;
        }
        
        this.currentConfig = config;
        
        // Load into State
        if (State) {
          State.config = {
            formId: config.form?.id || '',
            formName: config.form?.name || '',
            masking: {
              selectors: config.masking?.selectors || [],
              maskAllInputs: config.masking?.mask_all_inputs || false
            },
            journey: {
              steps: config.journey?.steps || [],
              successSelector: config.journey?.success_selector || ''
            },
            network: {
              scrubKeys: config.network?.scrub_payload_keys || []
            },
            ignored: {
              selectors: config.ignored?.selectors || []
            }
          };
          
          // Update form name input
          const formNameInput = DOM.$('form-name');
          if (formNameInput) formNameInput.value = config.form?.name || '';
        }
        
        // Update UI
        await this.renderConfigs();
        await this.renderAssociatedRecordings(id);
        
        Toast.success(`Loaded: ${config.form?.name || 'Config'}`);
        
        // Refresh any dependent UI
        window.Recap.ConfigUI?.refresh?.();
        window.Recap.Timeline?.render?.();
        
      } catch (e) {
        Log?.error('Failed to load config:', e);
        Toast.error('Failed to load config');
      }
    },
    
    async saveCurrentConfig() {
      try {
        // Build config from current State
        const ConfigExport = window.Recap.ConfigExport;
        if (!ConfigExport) {
          Toast.error('ConfigExport not available');
          return;
        }
        
        const config = ConfigExport.build();
        
        // Preserve ID if updating existing
        if (this.currentConfig?.id) {
          config.id = this.currentConfig.id;
          config.created_at = this.currentConfig.created_at;
        }
        
        const saved = await Storage.saveConfig(config);
        this.currentConfig = saved;
        
        await this.renderConfigs();
        Toast.success('Configuration saved');
        
      } catch (e) {
        Log?.error('Failed to save config:', e);
        Toast.error('Failed to save config');
      }
    },
    
    async createNewConfig() {
      this.currentConfig = null;
      
      // Reset State
      if (State) {
        State.config = {
          formId: '',
          formName: '',
          masking: { selectors: [], maskAllInputs: false },
          journey: { steps: [], successSelector: '' },
          network: { scrubKeys: [] },
          ignored: { selectors: [] }
        };
        State.events = [];
        State.rrwebEvents = [];
      }
      
      // Clear form name
      const formNameInput = DOM.$('form-name');
      if (formNameInput) formNameInput.value = '';
      
      await this.renderConfigs();
      window.Recap.ConfigUI?.refresh?.();
      window.Recap.Timeline?.render?.();
      
      Toast.info('New configuration started');
    },
    
    async deleteConfig(id) {
      if (!confirm('Delete this configuration and its recordings?')) return;
      
      try {
        await Storage.deleteConfig(id);
        
        if (this.currentConfig?.id === id) {
          this.currentConfig = null;
        }
        
        await this.refresh();
        Toast.success('Configuration deleted');
        
      } catch (e) {
        Log?.error('Failed to delete config:', e);
        Toast.error('Failed to delete config');
      }
    },
    
    async exportConfig(id) {
      try {
        const config = await Storage.getConfig(id);
        if (!config) return;
        
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `recap-config-${config.form?.name || 'export'}.json`.replace(/\s+/g, '-');
        a.click();
        URL.revokeObjectURL(url);
        
        Toast.success('Config exported');
      } catch (e) {
        Toast.error('Export failed');
      }
    },
    
    async importConfig(file) {
      if (!file) return;
      
      try {
        const text = await file.text();
        const config = JSON.parse(text);
        
        // Remove ID to create new
        delete config.id;
        delete config.created_at;
        delete config.updated_at;
        
        const saved = await Storage.saveConfig(config);
        await this.loadConfig(saved.id);
        
        Toast.success('Config imported');
      } catch (e) {
        Log?.error('Import failed:', e);
        Toast.error('Invalid config file');
      }
    },
    
    // ========================================
    // RECORDING MANAGEMENT
    // ========================================
    
    async renderRecordings() {
      const container = DOM.$('stored-recordings-list');
      if (!container) return;
      
      const recordings = await Storage.getRecordings();
      
      if (!recordings.length) {
        container.innerHTML = `
          <div class="empty-state-small">
            <p>No saved recordings (max ${Storage.MAX_RECORDINGS})</p>
          </div>
        `;
        return;
      }
      
      container.innerHTML = recordings.map(rec => `
        <div class="storage-item recording-item ${this.currentRecording?.id === rec.id ? 'active' : ''}" data-id="${DOM.escapeAttr(rec.id)}">
          <div class="storage-item-icon">🎬</div>
          <div class="storage-item-body">
            <div class="storage-item-title">${DOM.escapeHtml(rec.form_name || 'Recording')}</div>
            <div class="storage-item-meta">
              <span>${rec.event_count || rec.events?.length || 0} events</span>
              <span>•</span>
              <span>${this._formatDuration(rec.duration_ms || rec.duration || 0)}</span>
              <span>•</span>
              <span>${this._formatDate(rec.created_at)}</span>
            </div>
            ${rec.config_id ? `<div class="storage-item-link">📋 Linked to config</div>` : ''}
          </div>
          <div class="storage-item-actions">
            <button class="btn-icon" data-action="play" title="Play"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
            <button class="btn-icon" data-action="load" title="Load to Editor"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7-7 7 7"/></svg></button>
            <button class="btn-icon" data-action="export" title="Export"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg></button>
            <button class="btn-icon btn-danger" data-action="delete" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
          </div>
        </div>
      `).join('');
      
      // Attach handlers
      container.querySelectorAll('.recording-item').forEach(item => {
        const id = item.dataset.id;
        item.querySelector('[data-action="play"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.playRecording(id);
        });
        item.querySelector('[data-action="load"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.loadRecording(id);
        });
        item.querySelector('[data-action="export"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.exportRecording(id);
        });
        item.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteRecording(id);
        });
        item.addEventListener('click', () => this.loadRecording(id));
      });
    },
    
    async renderAssociatedRecordings(configId) {
      const container = DOM.$('config-recordings-list');
      if (!container) return;
      
      const recordings = await Storage.getRecordingsByConfig(configId);
      
      if (!recordings.length) {
        container.innerHTML = `<p class="text-muted">No recordings for this config</p>`;
        return;
      }
      
      container.innerHTML = `
        <p class="text-muted">Recordings (${recordings.length})</p>
        ${recordings.map(rec => `
          <button class="btn btn-sm btn-outline" data-rec-id="${DOM.escapeAttr(rec.id)}">
            ▶ ${this._formatDuration(rec.duration_ms)} · ${rec.event_count} events
          </button>
        `).join('')}
      `;
      
      container.querySelectorAll('[data-rec-id]').forEach(btn => {
        btn.addEventListener('click', () => this.playRecording(btn.dataset.recId));
      });
    },
    
    async loadRecording(id) {
      try {
        const recording = await Storage.getRecording(id);
        if (!recording) {
          Toast.error('Recording not found');
          return;
        }
        
        this.currentRecording = recording;
        
        // Load events into State
        const events = recording.events || recording.rrweb_events || [];
        if (State) {
          State.rrwebEvents = events;
        }
        
        // Load associated config if exists
        if (recording.config_id) {
          await this.loadConfig(recording.config_id);
        }
        
        // Update replay UI
        await this.renderRecordings();
        window.Recap.TrainerReplay?.init?.();
        
        // Switch to replay tab
        window.Recap.Tabs?.switch?.('tab-replay');
        
        Toast.success(`Loaded recording: ${events.length} events`);
        
      } catch (e) {
        Log?.error('Failed to load recording:', e);
        Toast.error('Failed to load recording');
      }
    },
    
    async playRecording(id) {
      try {
        const recording = await Storage.getRecording(id);
        if (!recording) {
          Toast.error('Recording not found');
          return;
        }
        
        const events = recording.events || recording.rrweb_events || [];
        if (!events.length) {
          Toast.error('No events in recording');
          return;
        }
        
        // Open in fullscreen player
        Player.openFullscreen(events, 'replay-modal', 'fullscreen-player-container');
        
      } catch (e) {
        Log?.error('Failed to play recording:', e);
        Toast.error('Failed to play recording');
      }
    },
    
    async saveCurrentRecording() {
      try {
        if (!State.rrwebEvents?.length) {
          Toast.error('No recording to save');
          return;
        }
        
        const stats = Player.getStats(State.rrwebEvents);
        
        const recording = {
          form_name: State.config?.formName || DOM.$('form-name')?.value || 'Recording',
          events: State.rrwebEvents,
          event_count: stats.eventCount,
          duration_ms: stats.duration,
          config_id: this.currentConfig?.id || null
        };
        
        const saved = await Storage.saveRecording(recording);
        this.currentRecording = saved;
        
        await this.renderRecordings();
        Toast.success('Recording saved');
        
      } catch (e) {
        Log?.error('Failed to save recording:', e);
        Toast.error('Failed to save recording');
      }
    },
    
    async deleteRecording(id) {
      if (!confirm('Delete this recording?')) return;
      
      try {
        await Storage.deleteRecording(id);
        
        if (this.currentRecording?.id === id) {
          this.currentRecording = null;
        }
        
        await this.renderRecordings();
        Toast.success('Recording deleted');
        
      } catch (e) {
        Log?.error('Failed to delete recording:', e);
        Toast.error('Failed to delete recording');
      }
    },
    
    async exportRecording(id) {
      try {
        const recording = await Storage.getRecording(id);
        if (!recording) return;
        
        Player.download(recording.events || recording.rrweb_events, {
          form_name: recording.form_name,
          config_id: recording.config_id,
          created_at: recording.created_at
        }, `recap-recording-${recording.form_name || 'export'}.json`.replace(/\s+/g, '-'));
        
      } catch (e) {
        Toast.error('Export failed');
      }
    },
    
    async importRecording(file) {
      if (!file) return;
      
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        
        // Extract events from various formats
        const events = data.rrweb_events || data.events || (Array.isArray(data) ? data : null);
        if (!events?.length) {
          Toast.error('Invalid recording format');
          return;
        }
        
        const stats = Player.getStats(events);
        
        const recording = {
          form_name: data.form_name || data.metadata?.form_name || file.name.replace('.json', ''),
          events: events,
          event_count: stats.eventCount,
          duration_ms: stats.duration,
          config_id: this.currentConfig?.id || null
        };
        
        const saved = await Storage.saveRecording(recording);
        await this.loadRecording(saved.id);
        
        Toast.success('Recording imported');
      } catch (e) {
        Log?.error('Import failed:', e);
        Toast.error('Invalid recording file');
      }
    },
    
    // ========================================
    // STATS
    // ========================================
    
    async updateStats() {
      const stats = await Storage.getStats();
      
      const configCount = DOM.$('dashboard-config-count');
      const recordingCount = DOM.$('dashboard-recording-count');
      
      if (configCount) configCount.textContent = `${stats.configCount}/${stats.maxConfigs}`;
      if (recordingCount) recordingCount.textContent = `${stats.recordingCount}/${stats.maxRecordings}`;
    },
    
    // ========================================
    // UTILITIES
    // ========================================
    
    _formatDate(dateStr) {
      if (!dateStr) return '';
      try {
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
        
        return date.toLocaleDateString();
      } catch {
        return '';
      }
    },
    
    _formatDuration(ms) {
      if (!ms) return '0:00';
      const secs = Math.floor(ms / 1000);
      const mins = Math.floor(secs / 60);
      const remainSecs = secs % 60;
      return `${mins}:${remainSecs.toString().padStart(2, '0')}`;
    }
  };

  // Export
  window.Recap.Dashboard = Dashboard;
})();


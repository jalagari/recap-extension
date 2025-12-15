/**
 * Recap - Storage Module
 * Modular storage abstraction for configurations and recordings
 * Currently uses IndexedDB, but can be swapped with API backend
 * @version 1.0.0
 */

'use strict';

(function() {
  // ============================================================================
  // STORAGE SERVICE - Abstract interface for data persistence
  // ============================================================================

  const StorageService = {
    // Storage limits
    MAX_CONFIGS: 20,
    MAX_RECORDINGS: 3,
    
    // Current backend (can be swapped)
    backend: null,
    
    /**
     * Initialize storage with specified backend
     * @param {string} type - 'indexeddb' | 'api' | 'localstorage'
     * @param {Object} options - Backend-specific options
     */
    async init(type = 'indexeddb', options = {}) {
      switch (type) {
        case 'indexeddb':
          this.backend = new IndexedDBBackend(options);
          break;
        case 'api':
          this.backend = new APIBackend(options);
          break;
        case 'localstorage':
          this.backend = new LocalStorageBackend(options);
          break;
        default:
          this.backend = new IndexedDBBackend(options);
      }
      
      await this.backend.init();
      console.log('[Storage] Initialized with', type, 'backend');
      return this;
    },
    
    // ========================================
    // CONFIG OPERATIONS
    // ========================================
    
    async saveConfig(config) {
      if (!config.id) {
        config.id = this._generateId('cfg');
      }
      config.updated_at = new Date().toISOString();
      if (!config.created_at) {
        config.created_at = config.updated_at;
      }
      
      // Enforce limit
      const configs = await this.getConfigs();
      if (configs.length >= this.MAX_CONFIGS && !configs.find(c => c.id === config.id)) {
        throw new Error(`Maximum ${this.MAX_CONFIGS} configurations allowed`);
      }
      
      await this.backend.save('configs', config);
      return config;
    },
    
    async getConfig(id) {
      return this.backend.get('configs', id);
    },
    
    async getConfigs() {
      return this.backend.getAll('configs');
    },
    
    async deleteConfig(id) {
      // Also unlink any recordings
      const recordings = await this.getRecordings();
      for (const rec of recordings) {
        if (rec.config_id === id) {
          rec.config_id = null;
          await this.backend.save('recordings', rec);
        }
      }
      return this.backend.delete('configs', id);
    },
    
    // ========================================
    // RECORDING OPERATIONS
    // ========================================
    
    async saveRecording(recording) {
      if (!recording.id) {
        recording.id = this._generateId('rec');
      }
      recording.updated_at = new Date().toISOString();
      if (!recording.created_at) {
        recording.created_at = recording.updated_at;
      }
      
      // Enforce limit - delete oldest if at max
      const recordings = await this.getRecordings();
      if (recordings.length >= this.MAX_RECORDINGS && !recordings.find(r => r.id === recording.id)) {
        // Sort by created_at and delete oldest
        const sorted = recordings.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        await this.backend.delete('recordings', sorted[0].id);
        console.log('[Storage] Deleted oldest recording:', sorted[0].id);
      }
      
      await this.backend.save('recordings', recording);
      return recording;
    },
    
    async getRecording(id) {
      return this.backend.get('recordings', id);
    },
    
    async getRecordings() {
      return this.backend.getAll('recordings');
    },
    
    async deleteRecording(id) {
      return this.backend.delete('recordings', id);
    },
    
    // ========================================
    // LINKING CONFIGS & RECORDINGS
    // ========================================
    
    async linkRecordingToConfig(recordingId, configId) {
      const recording = await this.getRecording(recordingId);
      if (recording) {
        recording.config_id = configId;
        await this.backend.save('recordings', recording);
      }
      return recording;
    },
    
    async getRecordingsForConfig(configId) {
      const all = await this.getRecordings();
      return all.filter(r => r.config_id === configId);
    },
    
    // ========================================
    // UTILITY
    // ========================================
    
    _generateId(prefix) {
      return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    },
    
    async clearAll() {
      await this.backend.clear('configs');
      await this.backend.clear('recordings');
    },
    
    async getStats() {
      const configs = await this.getConfigs();
      const recordings = await this.getRecordings();
      return {
        configCount: configs.length,
        maxConfigs: this.MAX_CONFIGS,
        recordingCount: recordings.length,
        maxRecordings: this.MAX_RECORDINGS,
        totalSize: this._estimateSize(configs) + this._estimateSize(recordings)
      };
    },
    
    _estimateSize(data) {
      try {
        return new Blob([JSON.stringify(data)]).size;
      } catch {
        return 0;
      }
    }
  };

  // ============================================================================
  // INDEXEDDB BACKEND
  // ============================================================================

  class IndexedDBBackend {
    constructor(options = {}) {
      this.dbName = options.dbName || 'RecapStorage';
      this.dbVersion = options.dbVersion || 1;
      this.db = null;
    }
    
    async init() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, this.dbVersion);
        
        request.onerror = () => reject(request.error);
        
        request.onsuccess = () => {
          this.db = request.result;
          resolve();
        };
        
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          
          // Configs store
          if (!db.objectStoreNames.contains('configs')) {
            const configStore = db.createObjectStore('configs', { keyPath: 'id' });
            configStore.createIndex('name', 'form.name', { unique: false });
            configStore.createIndex('created_at', 'created_at', { unique: false });
          }
          
          // Recordings store
          if (!db.objectStoreNames.contains('recordings')) {
            const recordingStore = db.createObjectStore('recordings', { keyPath: 'id' });
            recordingStore.createIndex('config_id', 'config_id', { unique: false });
            recordingStore.createIndex('created_at', 'created_at', { unique: false });
          }
        };
      });
    }
    
    async save(store, data) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(store, 'readwrite');
        tx.objectStore(store).put(data);
        tx.oncomplete = () => resolve(data);
        tx.onerror = () => reject(tx.error);
      });
    }
    
    async get(store, id) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(store, 'readonly');
        const request = tx.objectStore(store).get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    
    async getAll(store) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(store, 'readonly');
        const request = tx.objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    }
    
    async delete(store, id) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    
    async clear(store) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  }

  // ============================================================================
  // API BACKEND (Placeholder for future server integration)
  // ============================================================================

  class APIBackend {
    constructor(options = {}) {
      this.baseUrl = options.baseUrl || '/api/recap';
      this.headers = options.headers || {};
    }
    
    async init() {
      // Verify API is accessible
      console.log('[APIBackend] Ready to connect to:', this.baseUrl);
    }
    
    async save(store, data) {
      const response = await fetch(`${this.baseUrl}/${store}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify(data)
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      return response.json();
    }
    
    async get(store, id) {
      const response = await fetch(`${this.baseUrl}/${store}/${id}`, {
        headers: this.headers
      });
      if (!response.ok) return null;
      return response.json();
    }
    
    async getAll(store) {
      const response = await fetch(`${this.baseUrl}/${store}`, {
        headers: this.headers
      });
      if (!response.ok) return [];
      return response.json();
    }
    
    async delete(store, id) {
      const response = await fetch(`${this.baseUrl}/${store}/${id}`, {
        method: 'DELETE',
        headers: this.headers
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
    }
    
    async clear(store) {
      const response = await fetch(`${this.baseUrl}/${store}`, {
        method: 'DELETE',
        headers: this.headers
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
    }
  }

  // ============================================================================
  // LOCALSTORAGE BACKEND (Fallback, limited size)
  // ============================================================================

  class LocalStorageBackend {
    constructor(options = {}) {
      this.prefix = options.prefix || 'recap_';
    }
    
    async init() {
      // localStorage is always available
    }
    
    _key(store, id = '') {
      return `${this.prefix}${store}${id ? '_' + id : ''}`;
    }
    
    async save(store, data) {
      const all = await this.getAll(store);
      const idx = all.findIndex(item => item.id === data.id);
      if (idx >= 0) {
        all[idx] = data;
      } else {
        all.push(data);
      }
      localStorage.setItem(this._key(store), JSON.stringify(all));
      return data;
    }
    
    async get(store, id) {
      const all = await this.getAll(store);
      return all.find(item => item.id === id);
    }
    
    async getAll(store) {
      try {
        const data = localStorage.getItem(this._key(store));
        return data ? JSON.parse(data) : [];
      } catch {
        return [];
      }
    }
    
    async delete(store, id) {
      const all = await this.getAll(store);
      const filtered = all.filter(item => item.id !== id);
      localStorage.setItem(this._key(store), JSON.stringify(filtered));
    }
    
    async clear(store) {
      localStorage.removeItem(this._key(store));
    }
  }

  // Export
  window.Recap = window.Recap || {};
  window.Recap.Storage = StorageService;
})();

/**
 * Recap - Storage Module (ESM)
 * IndexedDB-based storage with simple API
 * @version 3.0.0
 */

import { Log, generateId, UrlUtils } from './core.js';

// ============================================================================
// INDEXEDDB WRAPPER
// ============================================================================

class RecapDB {
  constructor() {
    this.dbName = 'RecapDB';
    this.version = 1;
    this.db = null;
  }

  async init() {
    if (this.db) return this;
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        Log.info('Storage initialized');
        resolve(this);
      };
      
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        
        if (!db.objectStoreNames.contains('configs')) {
          const configs = db.createObjectStore('configs', { keyPath: 'id' });
          configs.createIndex('url_pattern', 'url_pattern');
        }
        
        if (!db.objectStoreNames.contains('sessions')) {
          const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
          sessions.createIndex('config_id', 'config_id');
          sessions.createIndex('started_at', 'started_at');
        }
      };
    });
  }

  async _tx(store, mode, fn) {
    const tx = this.db.transaction(store, mode);
    return new Promise((resolve, reject) => {
      const result = fn(tx.objectStore(store));
      if (result instanceof IDBRequest) {
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error);
      } else {
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
      }
    });
  }

  // Generic CRUD
  async save(store, data) {
    return this._tx(store, 'readwrite', s => { s.put(data); return data; });
  }

  async get(store, id) {
    return this._tx(store, 'readonly', s => s.get(id));
  }

  async getAll(store) {
    return this._tx(store, 'readonly', s => s.getAll());
  }

  async delete(store, id) {
    return this._tx(store, 'readwrite', s => s.delete(id));
  }

  async clear(store) {
    return this._tx(store, 'readwrite', s => s.clear());
  }
}

// ============================================================================
// STORAGE SERVICE
// ============================================================================

const db = new RecapDB();

export const Storage = {
  async init() {
    await db.init();
    return this;
  },

  // === CONFIGS ===
  
  async saveConfig(config) {
    if (!config.id) config.id = generateId('cfg');
    config.updated_at = new Date().toISOString();
    if (!config.created_at) config.created_at = config.updated_at;
    
    await db.save('configs', config);
    Log.debug('Config saved:', config.id);
    return config;
  },

  async getConfig(id) {
    return db.get('configs', id);
  },

  async getConfigByUrl(url) {
    const configs = await this.getConfigs();
    Log.debug('Looking for config matching:', url);
    Log.debug('Available configs:', configs.map(c => ({ name: c.name, pattern: c.url_pattern })));
    
    const match = configs.find(c => {
      const matches = c.url_pattern && UrlUtils.matchPattern(url, c.url_pattern);
      Log.debug(`  Pattern "${c.url_pattern}" matches:`, matches);
      return matches;
    });
    
    return match || null;
  },

  async getConfigs() {
    const configs = await db.getAll('configs');
    return configs.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  },

  async deleteConfig(id) {
    await db.delete('configs', id);
    Log.debug('Config deleted:', id);
  },

  // === SESSIONS ===
  
  async saveSession(session) {
    if (!session.id) session.id = generateId('sess');
    session.saved_at = new Date().toISOString();
    
    await db.save('sessions', session);
    Log.debug('Session saved:', session.id);
    return session;
  },

  async getSession(id) {
    return db.get('sessions', id);
  },

  async getSessions(filters = {}) {
    let sessions = await db.getAll('sessions');
    
    if (filters.config_id) {
      sessions = sessions.filter(s => s.config_id === filters.config_id);
    }
    if (filters.status) {
      sessions = sessions.filter(s => s.status === filters.status);
    }
    
    return sessions.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  },

  async deleteSession(id) {
    await db.delete('sessions', id);
  },

  // === ANALYTICS ===
  
  async getStats(configId) {
    const sessions = await this.getSessions({ config_id: configId });
    const total = sessions.length;
    const complete = sessions.filter(s => s.status === 'complete').length;
    const errors = sessions.filter(s => s.status === 'error').length;
    
    return {
      total,
      complete,
      errors,
      completeRate: total ? Math.round((complete / total) * 100) : 0,
      errorRate: total ? Math.round((errors / total) * 100) : 0
    };
  },

  // === UTILITY ===
  
  async clearAll() {
    await db.clear('configs');
    await db.clear('sessions');
    Log.info('All data cleared');
  },

  async exportAll() {
    return {
      version: '3.0.0',
      exported_at: new Date().toISOString(),
      configs: await this.getConfigs(),
      sessions: await this.getSessions()
    };
  }
};


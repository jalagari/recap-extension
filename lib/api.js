/**
 * Recap API Client
 * Connects extension to Cloudflare Worker
 */

const DEFAULT_API_URL = 'http://localhost:8787';

class RecapAPI {
  constructor(baseUrl = DEFAULT_API_URL) {
    this.baseUrl = baseUrl;
  }
  
  setBaseUrl(url) {
    this.baseUrl = url;
  }
  
  async request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        }
      });
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      return await res.json();
    } catch (e) {
      console.error('[Recap API]', e.message);
      throw e;
    }
  }
  
  // Health
  async health() {
    return this.request('/api/health');
  }
  
  // Configs
  async getConfig(id) {
    return this.request(`/api/configs/${id}`);
  }
  
  async getConfigs() {
    return this.request('/api/configs');
  }
  
  async saveConfig(config) {
    return this.request('/api/configs', {
      method: 'POST',
      body: JSON.stringify(config)
    });
  }
  
  async findConfigByUrl(url) {
    try {
      const { configs } = await this.getConfigs();
      
      // Normalize URL - remove query params and hash
      const normalizedUrl = this.normalizeUrl(url);
      
      // Find config matching URL pattern
      for (const config of configs) {
        if (this.urlMatchesPattern(normalizedUrl, config.url_pattern)) {
          return await this.getConfig(config.id);
        }
      }
      
      return null;
    } catch (e) {
      return null;
    }
  }
  
  /**
   * Normalize URL by removing query params and hash
   */
  normalizeUrl(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      // Fallback: strip after ? or #
      return url.split('?')[0].split('#')[0];
    }
  }
  
  urlMatchesPattern(url, pattern) {
    if (!pattern) return false;
    
    // Normalize both URL and pattern for comparison
    const normalizedUrl = this.normalizeUrl(url);
    const normalizedPattern = this.normalizeUrl(pattern);
    
    try {
      // Convert pattern to regex
      // https://example.com/* -> matches https://example.com/anything
      const regexPattern = normalizedPattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
        .replace(/\*/g, '.*'); // * becomes .*
      
      const regex = new RegExp(`^${regexPattern}$`, 'i');
      return regex.test(normalizedUrl);
    } catch {
      return normalizedUrl.startsWith(normalizedPattern.replace('*', ''));
    }
  }
  
  // Recordings
  async saveRecording(recording) {
    return this.request('/api/recordings', {
      method: 'POST',
      body: JSON.stringify(recording)
    });
  }
  
  async getRecording(id) {
    return this.request(`/api/recordings/${encodeURIComponent(id)}`);
  }
}

export const api = new RecapAPI();
export default api;


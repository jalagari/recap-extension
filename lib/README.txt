Recap Extension - Library Files
================================

This folder contains locally bundled libraries for CSP compliance.

Files:
- rrweb.min.js - rrweb recording library (v2.0.0-alpha.11)
- rrweb-player.min.js - rrweb replay player
- rrweb-player.min.css - Player styles

These files are loaded directly from the extension bundle to avoid
Content Security Policy (CSP) issues with external CDN scripts.

The extension ALWAYS loads from these local files - no CDN fallback needed.

To update these files:
1. Download from: https://cdn.jsdelivr.net/npm/rrweb@latest/dist/
2. Replace the files in this folder
3. Update manifest version and reload extension

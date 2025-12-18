# Icon Generation Instructions

The extension needs PNG icons at 16x16, 48x48, and 128x128 pixels.

## Quick Method (Using generate-icons.html)

1. Open `generate-icons.html` in a browser
2. Right-click each canvas and "Save image as..." 
3. Save as `icon16.png`, `icon48.png`, and `icon128.png` in this directory

## Alternative Methods

### Using Online Tools
1. Go to https://cloudconvert.com/svg-to-png or https://convertio.co/svg-png/
2. Upload `icon.svg`
3. Convert to PNG at sizes: 16x16, 48x48, 128x128
4. Save as `icon16.png`, `icon48.png`, `icon128.png`

### Using ImageMagick (if installed)
```bash
cd extension/icons
convert -background none icon.svg -resize 16x16 icon16.png
convert -background none icon.svg -resize 48x48 icon48.png
convert -background none icon.svg -resize 128x128 icon128.png
```

### Using Node.js (sharp)
```bash
npm install -g sharp-cli
sharp -i icon.svg -o icon16.png --resize 16 16
sharp -i icon.svg -o icon48.png --resize 48 48
sharp -i icon.svg -o icon128.png --resize 128 128
```

The icon design is a blue gradient circle with a white center circle and blue dot (◉ symbol) matching the Recap branding.


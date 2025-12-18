# Extension Icons

## Icon Files

The extension uses SVG icons that should be converted to PNG at different sizes:

- `icon16.png` - 16x16 pixels (toolbar)
- `icon48.png` - 48x48 pixels (extension management)
- `icon128.png` - 128x128 pixels (Chrome Web Store)

## Generating PNG Icons

You can use online tools like:
- https://cloudconvert.com/svg-to-png
- https://convertio.co/svg-png/

Or use ImageMagick:
```bash
convert -background none icon.svg -resize 16x16 icon16.png
convert -background none icon.svg -resize 48x48 icon48.png
convert -background none icon.svg -resize 128x128 icon128.png
```

The SVG icon (`icon.svg`) represents a recording/playback symbol with:
- Blue gradient background circle
- White center circle with play arrow
- Waveform lines on sides representing recording


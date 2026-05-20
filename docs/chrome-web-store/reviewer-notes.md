# Reviewer Notes

Canvas Transcript Companion has a narrow purpose: it adds searchable, synced transcripts to captioned Canvas Studio videos.

## How to test

1. Load the extension.
2. Open a Canvas LMS page containing a captioned Canvas Studio / Arc video.
3. Wait for the transcript panel to appear beside or below the video.
4. Click a transcript sentence; the video should seek to that timestamp.
5. Use the search field to filter transcript text.
6. Click the theater icon to open theater mode.
7. In theater mode, test transcript docking left, bottom, right, and floating.
8. Press Esc or the close button to exit theater mode.

## Permissions

The extension only requests Canvas-related host permissions:

- `https://*.instructure.com/*`
- `https://*.instructuremedia.com/*`
- `https://*.canvaslms.com/*`

These are required because Canvas course pages and Canvas Studio players run in separate frames and domains.

## Privacy

The extension does not collect, transmit, or store user data. Transcript/caption processing happens locally in the browser.

## Remote code

The extension does not load remote scripts. All JavaScript and CSS are packaged in the extension.

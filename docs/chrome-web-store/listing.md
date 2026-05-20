# Chrome Web Store Listing

## Name

Canvas Transcript Companion

## Short Description

Synced, clickable transcripts for captioned Canvas Studio videos.

## Detailed Description

Canvas Transcript Companion adds a searchable, synced transcript to captioned Canvas Studio videos.

It is built for Canvas course pages that embed Canvas Studio / Arc videos. When captions are available, the extension adds a transcript panel next to or below each video. Click any sentence to jump the video to that moment, search inside the transcript, copy the transcript, or open theater mode for a larger viewing experience.

Features:

- Synced transcript panel for captioned Canvas Studio videos
- Click any transcript sentence to seek the video
- Active sentence highlighting during playback
- Search and match highlighting
- Copy transcript
- Side-by-side or below-video layout
- Theater mode with dockable, floating, collapsible transcript overlay
- Adjustable transcript overlay opacity in theater mode
- Multiple videos on the same Canvas page get separate transcript panels

Privacy:

Canvas Transcript Companion does not collect, transmit, sell, or share user data. Transcript extraction and video controls run locally in your browser on supported Canvas pages.

Current scope:

This version focuses on Canvas Studio / Arc embeds on Canvas LMS domains. Other embedded video providers may need future provider-specific support.

## Category

Productivity

## Language

English

## Single Purpose Statement

Canvas Transcript Companion improves captioned Canvas Studio video viewing by showing searchable, synced transcripts with click-to-seek controls.

## Permission Justification

### `https://*.instructure.com/*`

Needed to detect Canvas course pages and inject the transcript panel beside Canvas video embeds.

### `https://*.instructuremedia.com/*`

Needed to run inside Canvas Studio / Arc video frames, read available captions, and send seek commands to the embedded video.

### `https://*.canvaslms.com/*`

Needed for Canvas-hosted LMS domains that use the `canvaslms.com` domain instead of an institution-specific `instructure.com` domain.

## Data Use Disclosure Draft

The extension does not collect or transmit personal information, authentication information, browsing history, or page content to any external server. Caption and transcript data is read locally from the active Canvas video page only to display the transcript and control playback in the browser.

## Suggested Screenshots

Recommended upload order:

- `store-assets/screenshots/01-panel-mode-1280x800.png`
- `store-assets/screenshots/02-theater-right-1280x800.png`
- `store-assets/screenshots/03-theater-floating-opacity-1280x800.png`

These are the clearest store screenshots because they show the real extension UI directly.

Optional designed variants:

- `store-assets/screenshots/01-panel-mode-polished-1280x800.png`
- `store-assets/screenshots/02-theater-right-polished-1280x800.png`
- `store-assets/screenshots/03-theater-floating-opacity-polished-1280x800.png`

## Promotional Images

- Small promo tile: `store-assets/promotional/small-promo-440x280.png`
- Large promo tile: `store-assets/promotional/large-promo-920x680.png`
- Marquee promo tile: `store-assets/promotional/marquee-promo-1400x560.png`

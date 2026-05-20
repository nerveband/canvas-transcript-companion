# Chrome Web Store Upload Checklist

## Package

- Run `./scripts/package-extension.sh`.
- Upload `canvas-transcript-companion-v0.1.0.zip`.
- Confirm the zip has `manifest.json` at the root.

## Listing

- Use `docs/chrome-web-store/listing.md` for the summary, detailed description, single purpose, permission justifications, and privacy answers.
- Category: Productivity or Education.
- Language: English.

## Images

Use these screenshots first because they show the real extension UI without turning the listing into a branded graphic:

- `store-assets/screenshots/01-panel-mode-1280x800.png`
- `store-assets/screenshots/02-theater-right-1280x800.png`
- `store-assets/screenshots/03-theater-floating-opacity-1280x800.png`

Optional designed variants, if you want a more polished visual treatment:

- `store-assets/screenshots/01-panel-mode-polished-1280x800.png`
- `store-assets/screenshots/02-theater-right-polished-1280x800.png`
- `store-assets/screenshots/03-theater-floating-opacity-polished-1280x800.png`

Promotional assets:

- Small promo tile: `store-assets/promotional/small-promo-440x280.png`
- Large promo tile: `store-assets/promotional/large-promo-920x680.png`
- Marquee promo tile: `store-assets/promotional/marquee-promo-1400x560.png`

## Privacy

- Publish or host `docs/chrome-web-store/privacy-policy.md`, then paste that URL into the Developer Dashboard.
- Data collection: none.
- Remote code: none.
- Analytics: none.

## Review Notes

- Paste the relevant sections from `docs/chrome-web-store/reviewer-notes.md`.
- If the reviewer needs a test page, use a Canvas course page with a captioned Canvas Studio video.

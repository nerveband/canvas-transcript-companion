# Provider Adapter Plan

How we go from "works only when the HTML5 `<video>` exposes textTracks" to "works on Canvas Studio (incl. transcript-only), YouTube, Kaltura, Panopto, and (eventually) Mediasite", without rewriting the panel/theater UI.

Backed by five parallel research passes — see the [Research appendix](#research-appendix) at the bottom for sources.

---

## 1. North-star architecture

Replace the current "find a `<video>`, read its textTracks, call it a day" code path with a **provider-adapter layer**. Each video host gets one adapter file. The transcript panel, theater UI, search, opacity, dock — none of that changes.

```
extension/
  manifest.json
  src/
    page-monitor.js                 # MAIN-world network observer (unchanged role)
    content.js                      # panel/theater UI (unchanged role)
    bg.js                           # NEW: MV3 service worker — webNavigation + frameId routing
    adapters/
      registry.js                   # NEW: provider selection
      base.js                       # NEW: AdapterBase + common helpers (cue parsing, UUID heartbeat)
      html5.js                      # current behaviour — generic <video> + textTracks
      studio.js                     # NEW: media_management/media/{id}/caption_files
      youtube.js                    # NEW: IFrame postMessage + InnerTube captionTracks
      kaltura.js                    # NEW: Playkit v7 / kWidget v2 + captionAsset.serveWebVTT
      panopto.js                    # NEW: EmbedApi postMessage + GenerateSRT.ashx
      mediasite.js                  # FUTURE
    parsers/
      vtt.js                        # native (use TextTrack API where possible)
      srt.js                        # minimal SRT parser (no library)
      ytJson3.js                    # YouTube srv3/json3 cue parser
```

The adapter layer maps **N providers × 2 problems** (cue extraction, time control) onto **one interface** the panel can consume.

---

## 2. The common adapter interface

Single TypeScript-style signature, plain JS at runtime. Modeled on Plyr's HTMLMediaElement-shaped provider plugins, with `canHandle` borrowed from video.js.

```js
// extension/src/adapters/base.js

/**
 * @typedef {Object} Cue
 * @property {number} start   seconds
 * @property {number} end     seconds
 * @property {string} text
 * @property {string} [language]
 */

/**
 * @typedef {Object} AdapterContext
 * @property {HTMLIFrameElement=} iframe   // when invoked from top frame
 * @property {HTMLVideoElement=}  video    // when invoked inside the video frame
 * @property {string}            url       // window.location or iframe.src
 */

/**
 * @typedef {Object} AdapterHandle
 * @property {string} frameId                          // UUID minted in the video frame
 * @property {() => Promise<number>} getCurrentTime
 * @property {(s: number) => Promise<void>} seek
 * @property {() => Promise<number>} getDuration
 * @property {() => Promise<void>} play
 * @property {() => Promise<void>} pause
 * @property {() => Promise<Cue[]>} loadCues
 * @property {(cb: (t: number) => void) => () => void} onTimeUpdate   // returns unsubscribe
 * @property {() => void} destroy
 */

/**
 * @typedef {Object} VideoAdapter
 * @property {string} key
 * @property {(ctx: AdapterContext) => 'probably' | 'maybe' | ''} canHandle
 * @property {(ctx: AdapterContext) => Promise<AdapterHandle>} attach
 */
```

`canHandle`'s three-state return lets two adapters claim the same iframe and we pick the strongest. Example: an institution-CNAMEd Kaltura player may also look like a generic HTML5 page; Kaltura returns `'probably'`, html5 returns `'maybe'`, Kaltura wins.

---

## 3. The wire protocol between frames

Lifted verbatim from asbplayer (`extension/src/services/frame-info.ts`), which has shipped at scale across 20+ video sites.

**Child → Top (heartbeat, every 10s and on attach):**
```js
window.parent.postMessage({
  sender: 'ctc-video',
  message: { type: 'hello', frameId: UUID, adapterKey: 'youtube' }
}, '*');
```

**Top → Child (commands):**
```js
iframe.contentWindow.postMessage({
  sender: 'ctc-panel',
  message: { type: 'seek', frameId: 'abc-123', payload: { seconds: 42.5 } }
}, '*');
```

Children only act when `frameId` matches their own. Top frame builds an `iframesById` map by walking `document.getElementsByTagName('iframe')` and matching each iframe's `contentWindow` against `event.source`.

**SW-side fallback for late-mounted frames (SPAs, Canvas modules):**
- `chrome.webNavigation.onCommitted` → record `{tabId, frameId, documentId, url}` in `chrome.storage.session`.
- `chrome.tabs.sendMessage(tabId, msg, { frameId })` to deliver to a specific frame even before its content script has heartbeated.

---

## 4. Phased roadmap

### Phase 1 — Adapter refactor (no new providers)

Goal: same external behaviour, but the current Studio/HTML5 code path runs through the new adapter layer.

Concrete tasks:
1. Extract the current cue-discovery code from `content.js` into `adapters/html5.js`. It implements `canHandle` (`'probably'` if `document.querySelector('video[src]')` matches and has live textTracks, else `'maybe'` if there's any `<video>`), and `attach` returns a handle backed by the `<video>` element.
2. Build `adapters/registry.js` and `adapters/base.js`. Empty registry at first; register `html5`.
3. Refactor the seek/highlight messaging in `content.js` to use `AdapterHandle.seek` / `onTimeUpdate` instead of direct `postMessage` to the iframe.
4. Replace the current ad-hoc UUID in `content.js` with the asbplayer-style heartbeat.
5. Behaviour parity test: open the same Canvas page that worked before; verify panel renders, seek works, theater works.

**Sized: ~1 day of focused work. Pure refactor — zero new user-facing features.**

### Phase 2 — Studio fallback via `media_management` API

Goal: when the Studio `<video>` doesn't expose cues to textTracks (the "Studio holds a transcript but never feeds it to the browser" case), fetch the transcript directly from Studio.

Why first: smallest unknown, highest near-term value, same origin we already have permissions for.

Concrete tasks:
1. New `adapters/studio.js`. `canHandle` returns `'probably'` when `location.host` matches `*.instructuremedia.com` AND we found a `<video>` (regardless of whether it has cues).
2. Inside `attach`:
   - Try DOM/`window.__ARC_INIT__`/inline `<script>` scrape for the integer `media_id` (look for `"media":{"id":<int>` near `"title":`).
   - Fallback for `/embed/{uuid}` URLs: `GET /api/media_management/embed/{uuid}` resolves to media id.
   - Fallback for `/lti-app/bare-embed/perspective/{token}`: fetch the bare-embed page HTML, regex `"id":\s*(\d+)` near `"title"`.
3. `GET /api/media_management/media/{media_id}/caption_files` with `credentials: 'include'`. Pick `status === 'published'`, prefer `srclang` matching `navigator.language`, fall back to first.
4. `GET caption.url` (relative to Studio origin) → SRT body → `parsers/srt.js` → `Cue[]`.
5. On 401/403: read `sessionStorage.userId` and `sessionStorage.token`, retry with `Authorization: Bearer user_id="<id>", token="<token>"`.
6. Keep HTML5 as a fallback — if Studio's `<video>` *does* have cues, we still prefer them (free word-level resolution if the source ever exposes it). The three-state probe handles the ordering.

**Sized: 1–2 days. The fragile bit is `media_id` discovery; build a tiny parser layer so a UI change in Studio only breaks one function.**

### Phase 3 — YouTube

Goal: support YouTube embeds inside Canvas pages.

Why next: largest user audience, well-trodden ground (multiple open-source references), no auth.

Concrete tasks:
1. Manifest changes (see §6).
2. New `adapters/youtube.js`. `canHandle` matches `iframe.src` against `(youtube\.com|youtube-nocookie\.com)/embed/`.
3. `attach`:
   - Rewrite `iframe.src` to add `enablejsapi=1&origin=${encodeURIComponent(location.origin)}` if missing. The reload is a one-time cost.
   - Handshake: `postMessage({event:'listening', id, channel:'widget'}, iframeOrigin)`.
   - Listen on `window` for `message`; filter by `event.source === iframe.contentWindow`. Use `info.currentTime` from `infoDelivery` (no polling).
   - Command surface: `{event:'command', func:'seekTo', args:[t, true]}`, `playVideo`, `pauseVideo`, `getDuration`.
4. Captions (in service worker, since we need to fetch off-page):
   - `POST https://www.youtube.com/youtubei/v1/player?prettyPrint=false` with body `{context:{client:{clientName:'ANDROID', clientVersion:'20.10.38'}}, videoId}`. Send from the SW so we don't add Android UA spoofing to the page.
   - Read `data.captions.playerCaptionsTracklistRenderer.captionTracks[]`.
   - Pick locale-matching, prefer non-ASR; fetch `baseUrl + '&fmt=json3'`.
   - Parse json3 (`events[].tStartMs, dDurationMs, segs[].utf8`) → `Cue[]`.
   - Fallback: scrape `ytInitialPlayerResponse` from `https://www.youtube.com/watch?v={id}` if InnerTube returns `playabilityStatus != OK`.
5. Lazy-load: `MutationObserver` on `document.body` to catch iframes that mount after page load (Canvas modules, "Pages" view).

**Sized: 2–3 days. Largest risk is YouTube changing the InnerTube client/PoToken requirements; pin to the same client version `youtube-transcript-api` uses and re-test on releases.**

### Phase 4 — Kaltura

Goal: support Kaltura embeds (KAF + cdnapisec.kaltura.com player iframes).

Why next: many universities use Kaltura; user-scoped `ks` is already present inside the player iframe, so no auth work needed.

Concrete tasks:
1. Manifest: add `*://*.kaltura.com/*` + the institution KAF host pattern; `all_frames: true`; `match_origin_as_fallback: true` (for `about:blank` / `blob:` player iframes).
2. New `adapters/kaltura.js`, runs *inside* the player iframe (Canvas top frame can only message it through postMessage). `canHandle` returns `'probably'` if `window.KalturaPlayer?.getPlayers` exists OR `window.kWidget` exists OR `window.kalturaIframePackageData` is present.
3. Dual-path runtime:
   - **v7 (Playkit)**: `player.currentTime`, `player.currentTime = t`, `player.addEventListener('timeupdate', …)`, `player.addEventListener('textcuechanged', e => e.payload.cues)`. Use `TEXT_CUE_CHANGED` for live highlight (no need to pre-parse if we don't want to).
   - **v2 (kWidget)**: `kdp.sendNotification('doSeek', t)`, `kdp.addJsListener('playerUpdatePlayhead', …)`, `kdp.evaluate('{mediaProxy.entry.id}')`, `kdp.addJsListener('newClosedCaptionsData', …)`.
4. Captions (preferred — REST):
   - Read `entryId`, `partnerId`, `ks` from `window.kalturaIframePackageData.flashVars` (works for both v2 and v7).
   - `GET https://{host}/api_v3/service/caption_captionAsset/action/list?ks={ks}&filter[entryIdEqual]={entry}&format=1` → caption list.
   - Pick `isDefault` or first English; `GET …/action/serveWebVTT/captionAssetId/{id}/ks/{ks}` → WebVTT → parse.
5. Backup channel: in `bg.js`, listen on `chrome.webRequest.onBeforeRequest` for `*://cfvod.kaltura.com/*.{srt,vtt}` and `*://cdnbakmi.kaltura.com/*.{srt,vtt}`. When the player itself fetches captions, mirror the URL to the matching adapter (cheap fallback for HLS-only entries or when REST returns empty).
6. Bridge to top Canvas frame via the asbplayer heartbeat (Kaltura iframe → top page).

**Sized: 3 days. Biggest risk is the v2/v7 fragmentation — must test against at least one v2 institution and one v7 institution.**

### Phase 5 — Panopto

Goal: support `*.hosted.panopto.com` / `*.cloud.panopto.eu` embeds.

Concrete tasks:
1. Manifest: add `*://*.hosted.panopto.com/*`, `*://*.cloud.panopto.eu/*`, `*://*.panopto.com/*`, `*://*.panopto.eu/*`.
2. New `adapters/panopto.js`. `canHandle` matches `iframe.src` against `/Panopto/Pages/(Embed|Viewer)\.aspx`. Parse `id` / `pid` from query string.
3. Player control via EmbedApi postMessage protocol (no need to load `EmbedApi.js`):
   - Listen for `type: 'embedIframeReady'` from the iframe.
   - Send envelope `{type, id: iframeId, data}` for commands: `playVideo`, `pauseVideo`, `seekTo` (arg: seconds).
   - Listen for `iframeStateUpdate` (delivers `currentTime`). Poll `getCurrentTime` at 4 Hz if updates go silent (known issue, community thread 920).
4. Captions:
   - Primary: `GET /Panopto/Pages/Transcription/GenerateSRT.ashx?id={sessionId}&language=0` with `credentials: 'include'`. Returns SRT. Retry without `language` if empty.
   - Fallback: `POST /Panopto/Pages/Viewer/DeliveryInfo.aspx` with `deliveryId={id}&isEmbed=true&responseType=json` — JSON often contains a `Captions` array with start/end seconds (cheaper than SRT parsing).
   - Public REST as a "best effort" check: `GET /Panopto/api/v1/sessions/{id}` may expose a `Captions` download URL.
5. Run the adapter inside the Panopto iframe (need same-origin cookie access), bridge to top.

**Sized: 2 days. Risks: EmbedApi `iframeState` filter bug (community 1211) — sniff *all* `iframe*` messages, not just ones with matching `id`. Auth-cookie scope inside Canvas LTI launches sometimes requires user to play once before captions become fetchable.**

### Phase 6 — Mediasite (deferred)

Locked-down, proprietary, no public captions endpoint. Defer until at least one user requests it. If we ever tackle it: scrape the Mediasite player's transcript pane DOM, similar to what `evccedtech/panopto-transcript-downloader` does for Panopto.

---

## 5. Caption parsing

Three formats to handle: VTT, SRT, YouTube json3/srv3.

Recommendation: **vendor minimal parsers in `parsers/`**, don't add `subsrt-ts` as a dep. Reasons:
- VTT: use the platform `TextTrack`/`VTTCue` API when possible — the browser already parses it. For raw fetched VTT we can either feed it to a hidden `<track>` element (parses for free) or write a ~30-line parser.
- SRT: a 25-line regex-based parser handles every Studio and Panopto file I've seen. SRT is dead-simple.
- json3/srv3: YouTube's format, ~15 lines.

Total: <100 lines of parser code, zero deps. Easier to maintain than tracking `subsrt-ts` releases. Revisit if we ever need DFXP/TTML or SSA/ASS.

---

## 6. Manifest changes

```json
{
  "manifest_version": 3,
  "permissions": ["storage", "scripting", "webNavigation", "webRequest"],
  "host_permissions": [
    "https://*.instructure.com/*",
    "https://*.instructuremedia.com/*",
    "https://*.canvaslms.com/*",
    "https://*.youtube.com/*",
    "https://*.youtube-nocookie.com/*",
    "https://*.kaltura.com/*",
    "https://*.hosted.panopto.com/*",
    "https://*.cloud.panopto.eu/*",
    "https://*.panopto.com/*",
    "https://*.panopto.eu/*"
  ],
  "background": { "service_worker": "src/bg.js" },
  "content_scripts": [
    {
      "matches": ["https://*.instructure.com/*", "https://*.canvaslms.com/*"],
      "js": ["src/content.js"], "css": ["src/content.css"],
      "all_frames": true, "match_origin_as_fallback": true
    },
    {
      "matches": [
        "https://*.instructuremedia.com/*",
        "https://*.kaltura.com/*",
        "https://*.hosted.panopto.com/*",
        "https://*.cloud.panopto.eu/*",
        "https://*.panopto.com/*",
        "https://*.panopto.eu/*",
        "https://www.youtube.com/embed/*",
        "https://www.youtube-nocookie.com/embed/*"
      ],
      "js": ["src/content-frame.js"],
      "all_frames": true, "match_origin_as_fallback": true,
      "run_at": "document_idle"
    },
    {
      "matches": [
        "https://*.instructure.com/*",
        "https://*.instructuremedia.com/*",
        "https://*.canvaslms.com/*"
      ],
      "all_frames": true, "run_at": "document_start", "world": "MAIN",
      "js": ["src/page-monitor.js"]
    }
  ]
}
```

`content-frame.js` is a thin shim: it imports the registry, selects an adapter via `canHandle`, instantiates it, and starts the heartbeat. `content.js` continues to own the panel UI in the top Canvas frame.

**Permission review notes for Chrome Web Store** (this is the awkward bit): each new host triggers reviewer scrutiny. Justifications to prepare:
- youtube.com — "Display synced transcripts for YouTube videos embedded in Canvas course pages."
- kaltura.com — "Display synced transcripts for Kaltura videos embedded in Canvas course pages."
- panopto.com — "Display synced transcripts for Panopto videos embedded in Canvas course pages."

The justifications already exist in `docs/chrome-web-store/listing.md` — update them per provider as phases ship.

---

## 7. Frame-routing edge cases

From the research:

1. **Iframe reattachment reloads the iframe.** We already hit this with theater mode (fixed by mutating state in place). Watch for it when an adapter is initially bound from the top frame and then the iframe moves — re-issue `attach` on `MutationObserver`-detected reattachment.
2. **SPA mount order.** Canvas's modules view renders content asynchronously. Run the iframe scan on `MutationObserver` for the lifetime of the page, not just on `DOMContentLoaded`.
3. **Lazy-loaded YouTube wrappers** (`lite-youtube-embed`). The real iframe doesn't exist until first click. Watch for new iframes whose `src` matches `youtube.com/embed/`.
4. **`about:blank` / `blob:` Kaltura iframes** — covered by `match_origin_as_fallback: true`.
5. **EmbedApi `iframeState` filter bug** (Panopto) — listen for ANY `type` starting with `"iframe"`, don't filter by the bogus `id` field.

---

## 8. Testing strategy

No automated test infra today. Add a small browser-driven smoke test:

- `tests/fixtures/` — minimal HTML pages that simulate each provider (a YouTube embed, a Kaltura test entry, a Panopto public session, a Studio bare-embed clone). Easier than maintaining a full Canvas dev tenant.
- `tests/manual.md` — checklist per provider: "click sentence at t=0", "click sentence at t=mid", "switch dock", "search filters", "opacity slider", "theater closes with red X".
- For shipping: each phase = one PR, must include manual-test screenshot + a fresh `chrome.runtime.lastError`-free console log.

Defer real e2e (Playwright) until we have more than three providers.

---

## 9. Risks & open questions

| Risk | Mitigation |
| --- | --- |
| YouTube `pot`/`potc` enforcement starts blocking `baseUrl` requests | Keep watch-page-scrape fallback wired. Pin `clientVersion` to the latest jdepoix releases. |
| Studio's internal `media_management` API changes shape | Isolate the JSON-shape assumptions in one function per endpoint. Version-sniff. |
| Kaltura v2 vs v7 fragmentation | Dual-path adapter from day one. Add a feature-flag to force one path for debugging. |
| Panopto `iframeState` filter bug under varying tenant builds | Sniff all `iframe*` messages, ignore `id`. |
| Chrome Web Store reviewer rejection over expanded host permissions | Each phase ships with a fresh listing update + reviewer notes describing the user-facing reason for that host. |
| Iframe reload during theater mode (already seen) | Existing fix (mutate state in place) is the template — apply same pattern wherever we re-attach. |
| Manifest V3 service worker shutdown losing per-frame state | All routing state in `chrome.storage.session`, never in SW memory. |

Open questions before Phase 1 starts:
- Do we want to break panel UI for non-Canvas pages while adapters are being built? **Recommendation: no.** Keep `content.js` gated on Canvas hosts; only `content-frame.js` runs on provider hosts.
- Do we want per-provider settings (e.g., disable YouTube but keep Studio)? **Recommendation: ship without it, add later if requested.**
- Word-level highlighting — should we run a forced-alignment Whisper model in a worker? **Recommendation: out of scope for v1; add a "request word-level alignment" command later.**

---

## 10. Sequencing summary

| Phase | Effort | Net new code (LoC est) | User-visible win |
| --- | --- | --- | --- |
| 1 — Adapter refactor | 1 day | ~400 (mostly moved) | None (refactor only) |
| 2 — Studio API fallback | 1–2 days | ~250 | Studio transcripts that today show "no captions" start working |
| 3 — YouTube | 2–3 days | ~600 | Largest user-audience win |
| 4 — Kaltura | 3 days | ~700 | Major institutional reach |
| 5 — Panopto | 2 days | ~500 | High-value academic users |
| 6 — Mediasite | TBD | TBD | Smallest market; defer |

Phases 2–5 are independent once Phase 1 lands; we can ship them as separate `v0.2`, `v0.3`, etc. releases.

---

## Research appendix

Each section here is a brief pointer to the full research; full reports live in the conversation history.

### Canvas Studio
- Use the **internal `media_management` API**, not the public OAuth API. Same-origin session cookies just work from a content script inside the Studio iframe.
- Cue endpoint: `GET /api/media_management/media/{media_id}/caption_files` → list; then GET each item's `url` for SRT.
- Media-ID discovery is fragile — scrape DOM/inline JSON, fall back to `/api/media_management/embed/{uuid}`.
- Open-source references: `hypothesis/lms`, `simonrob/canvas-helpers`, `OneByteToRuleThemAll/canvas-api-download-material`, `AdamTovatt/video-summarizer`, `thedannywahl/inst-api`.

### YouTube
- Skip loading `iframe_api.js`; talk `postMessage` directly. Handshake = `{event:'listening', id, channel:'widget'}`. Commands = `{event:'command', func, args}`. Use `infoDelivery.info.currentTime` (push, no polling).
- Captions via InnerTube: `POST youtubei/v1/player` with the Android client context; read `captionTracks[].baseUrl` and GET with `&fmt=json3`.
- Open-source references: `jdepoix/youtube-transcript-api` (canonical), `Kakulukian/youtube-transcript` (TS port), `zerodytrash/YouTube-Internal-Clients`.

### Kaltura
- Two player versions: v7 Playkit (`KalturaPlayer.getPlayers()[0]`) and v2 kWidget. Dual-path required.
- Captions: `GET /api_v3/service/caption_captionAsset/action/list` then `/action/serveWebVTT/captionAssetId/{id}/ks/{ks}`.
- Auth: scrape user-scoped `ks` from `window.kalturaIframePackageData.flashVars.ks` inside the player iframe.
- Open-source references: `kaltura/playkit-js` event types, `kaltura/mwEmbed`, `yordok/edstem-transcript-creator` (passive `webRequest` capture).

### Panopto
- Player control via EmbedApi postMessage protocol — no need to load `EmbedApi.js`.
- Captions: `GET /Panopto/Pages/Transcription/GenerateSRT.ashx?id={id}&language=0` returns SRT. Fallback to `POST /Panopto/Pages/Viewer/DeliveryInfo.aspx`.
- No seek event from EmbedApi — poll `iframeStateUpdate` or `getCurrentTime`.
- Open-source references: `evccedtech/panopto-transcript-downloader`, Panopto Caption Downloader (GreasyFork 487743).

### Adapter pattern + prior art
- **asbplayer** is the gold standard for multi-site video extensions. Copy its declarative `pages.json` registry, UUID-heartbeat frame routing, and `chrome.storage.session` state model.
- Use **video.js**'s three-state `canHandle` probe (`'probably' | 'maybe' | ''`).
- Use **Plyr**'s HTMLMediaElement-shaped provider interface (`currentTime`, `seek`, `getDuration`, event emitter).
- No existing extension supports Panopto + Kaltura + YouTube in one codebase — this fills a real gap.
- Caption parsing: skip libraries; vendor minimal SRT/json3 parsers inline (<100 LoC total).

---

## What's NOT in this plan

- A new UI for picking providers, switching languages, etc. — the panel already has search and dock; that's enough for v1.
- An AI/Whisper fallback when no captions exist — separate feature.
- Server-side anything — extension stays 100% local.
- Public Chrome Web Store listing changes beyond per-provider permission justifications.
- Mediasite. Deferred until requested.

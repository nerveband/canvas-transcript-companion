(() => {
  const SOURCE = "canvas-transcript-companion";
  const PAGE_MONITOR_SOURCE = "canvas-transcript-companion-page-monitor";
  const TOP_FRAME = window.top === window;
  const FRAME_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const DEBUG_ENABLED = new URLSearchParams(location.search).has("ctcDebug")
    || localStorage.getItem("ctcDebug") === "1";
  const diagnostics = {
    events: [],
    frames: new Map(),
    network: [],
    top: TOP_FRAME,
    frameId: FRAME_ID,
    host: location.hostname
  };

  const panelStates = new Map();
  let videoState = null;
  let transcriptSent = false;
  const pendingCaptionUrls = new Set();

  trace("boot", {
    top: TOP_FRAME,
    url: location.href,
    title: document.title,
    debug: DEBUG_ENABLED
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== PAGE_MONITOR_SOURCE) return;

    if (TOP_FRAME) {
      recordNetworkEvent(data.payload);
    } else {
      queueObservedCaptionUrl(data.payload);
      postToTop("network-observed", data.payload);
    }
  });

  if (TOP_FRAME) {
    bootTopFrame();
  }

  bootVideoFrame();

  function bootTopFrame() {
    if (!isCanvasLikePage()) return;

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data) return;

      if (data.source !== SOURCE) return;

      trace("message", {
        type: data.type,
        frameId: data.payload?.frameId,
        cueCount: data.payload?.cues?.length
      });

      if (data.type === "transcript-ready") {
        renderPanel(event.source, data.payload);
      }

      if (data.type === "time-update") {
        updateActiveCue(data.payload.currentTime, data.payload.frameId);
      }

      if (data.type === "frame-status") {
        recordFrameStatus(data.payload);
      }

      if (data.type === "network-observed") {
        recordNetworkEvent(data.payload);
      }
    });

    setTimeout(() => {
      renderWaitingPanels();
    }, 2000);
  }

  function bootVideoFrame() {
    const start = () => {
      if (videoState) return;
      const video = document.querySelector("video");
      if (video) {
        postFrameStatus("video-found", inspectVideo(video));
        initializeVideoBridge(video);
        return;
      }
      const yt = findYouTubeIframe();
      if (yt) {
        postFrameStatus("youtube-found", { src: yt.src });
        initializeYouTubeBridge(yt);
      }
    };

    start();
    const observer = new MutationObserver(start);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function findYouTubeIframe() {
    const sel = 'iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]';
    return document.querySelector(sel);
  }

  async function initializeVideoBridge(video) {
    if (video.dataset.ctcReady === "true") return;
    video.dataset.ctcReady = "true";

    videoState = { video, cues: [], lastSentSecond: -1 };
    trace("video-initialize", inspectVideo(video));
    wireSeekReceiver(video);

    const cues = await collectCues(video);
    if (!cues.length) {
      trace("cues-empty", inspectVideo(video));
      postFrameStatus("no-cues", inspectVideo(video));
      return;
    }

    sendTranscriptReady(cues, "initial-collection");

    video.addEventListener("timeupdate", () => {
      const currentTime = video.currentTime || 0;
      const second = Math.floor(currentTime * 2) / 2;
      if (second === videoState.lastSentSecond) return;
      videoState.lastSentSecond = second;
      postToTop("time-update", { frameId: FRAME_ID, currentTime });
    });
  }

  function wireSeekReceiver(video) {
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.source !== SOURCE || data.type !== "seek") return;
      if (data.frameId && data.frameId !== FRAME_ID) return;

      const seconds = Number(data.seconds);
      if (!Number.isFinite(seconds)) return;

      trace("seek", { seconds });
      const target = Math.max(0, seconds);
      const apply = () => {
        if (Math.abs(video.currentTime - target) > 0.5) {
          video.currentTime = target;
        }
      };
      apply();
      video.play().catch(() => {});
      setTimeout(apply, 120);
      setTimeout(apply, 400);
    });
  }

  async function initializeYouTubeBridge(iframe) {
    if (iframe.dataset.ctcReady === "true") return;
    iframe.dataset.ctcReady = "true";

    videoState = { iframe, cues: [], lastSentSecond: -1, duration: null };
    trace("youtube-initialize", { src: iframe.src });

    const post = (msg) => {
      try { iframe.contentWindow?.postMessage(JSON.stringify(msg), "*"); } catch {}
    };
    const subscribe = () => {
      post({ event: "listening", id: FRAME_ID, channel: "widget" });
      post({ event: "command", func: "addEventListener", args: ["onReady"] });
      post({ event: "command", func: "addEventListener", args: ["onStateChange"] });
    };
    iframe.addEventListener("load", subscribe);
    subscribe();
    const subInterval = setInterval(subscribe, 800);
    setTimeout(() => clearInterval(subInterval), 8000);

    window.addEventListener("message", (event) => {
      if (event.source !== iframe.contentWindow) return;
      let data = event.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { return; }
      }
      if (!data || data.event !== "infoDelivery" || !data.info) return;
      if (typeof data.info.currentTime === "number") {
        const ct = data.info.currentTime;
        const second = Math.floor(ct * 2) / 2;
        if (second !== videoState.lastSentSecond) {
          videoState.lastSentSecond = second;
          postToTop("time-update", { frameId: FRAME_ID, currentTime: ct });
        }
      }
      if (typeof data.info.duration === "number" && data.info.duration > 0) {
        videoState.duration = data.info.duration;
      }
    });

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.source !== SOURCE || data.type !== "seek") return;
      if (data.frameId && data.frameId !== FRAME_ID) return;
      const seconds = Number(data.seconds);
      if (!Number.isFinite(seconds)) return;
      trace("seek", { seconds, target: "youtube" });
      post({ event: "command", func: "seekTo", args: [Math.max(0, seconds), true] });
      post({ event: "command", func: "playVideo", args: [] });
    });

    const tryDeliver = async () => {
      for (const url of pendingCaptionUrls) {
        const cues = await fetchCaptionApiCues(url);
        if (cues.length) {
          sendTranscriptReady(cues, "youtube-observed");
          return true;
        }
      }
      return false;
    };

    if (await tryDeliver()) return;
    const deadline = Date.now() + 12000;
    while (!transcriptSent && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (await tryDeliver()) return;
    }
    if (!transcriptSent) postFrameStatus("no-cues", { src: iframe.src, kind: "youtube" });
  }

  async function collectCues(video) {
    const tracks = Array.from(video.textTracks || []);
    trace("collect-cues-start", {
      textTrackCount: tracks.length,
      trackElementCount: document.querySelectorAll("track").length
    });

    for (const track of tracks) {
      if (track.kind && !["subtitles", "captions"].includes(track.kind)) continue;
      track.mode = "hidden";
    }

    const directTrackCues = cuesFromTextTracks(video);
    if (directTrackCues.length) {
      trace("collect-cues-direct", { count: directTrackCues.length });
      return directTrackCues;
    }

    const trackElements = Array.from(document.querySelectorAll("track"));
    for (const trackElement of trackElements) {
      const src = trackElement.getAttribute("src");
      trace("track-element", {
        kind: trackElement.getAttribute("kind"),
        label: trackElement.getAttribute("label"),
        srclang: trackElement.getAttribute("srclang"),
        src
      });
      if (!src) continue;

      const cues = await fetchTrackCues(src);
      if (cues.length) {
        trace("collect-cues-track-src", { src, count: cues.length });
        return cues;
      }
    }

    const observedApiCues = await collectObservedCaptionApiCues();
    if (observedApiCues.length) return observedApiCues;

    const waitedCues = await waitForCues(video, 10000);
    if (waitedCues.length) return waitedCues;

    return collectObservedCaptionApiCues();
  }

  function waitForCues(video, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const cues = cuesFromTextTracks(video);
        if (cues.length || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          trace("collect-cues-wait-finished", {
            count: cues.length,
            elapsedMs: Date.now() - started
          });
          resolve(cues);
        }
      }, 250);
    });
  }

  function cuesFromTextTracks(video) {
    const out = [];
    const tracks = Array.from(video.textTracks || []);

    for (const track of tracks) {
      const cues = Array.from(track.cues || []);
      for (const cue of cues) {
        const text = cleanCueText(cue.text || "");
        if (!text) continue;
        out.push({
          start: cue.startTime,
          end: cue.endTime,
          text
        });
      }
    }

    return dedupeAndSort(out);
  }

  async function fetchTrackCues(src) {
    try {
      const url = new URL(src, location.href).href;
      trace("fetch-track", { url });
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        trace("fetch-track-failed", { url, status: response.status });
        return [];
      }
      const text = await response.text();
      return parseTimedText(text);
    } catch (error) {
      trace("fetch-track-error", { src, error: error.message });
      return [];
    }
  }

  async function collectObservedCaptionApiCues() {
    for (const url of pendingCaptionUrls) {
      const cues = await fetchCaptionApiCues(url);
      if (cues.length) {
        trace("collect-cues-caption-api", { url, count: cues.length });
        return cues;
      }
    }
    return [];
  }

  async function fetchCaptionApiCues(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href).href;
      trace("fetch-caption-api", { url });
      const response = await fetch(url, {
        credentials: "include",
        headers: {
          "Accept": "text/vtt,text/plain,application/json,*/*"
        }
      });

      if (!response.ok) {
        trace("fetch-caption-api-failed", { url, status: response.status });
        return [];
      }

      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();
      const cues = parseCaptionResponse(text, contentType, url);
      trace("fetch-caption-api-parsed", {
        url,
        contentType,
        textStart: text.slice(0, 80),
        count: cues.length
      });
      return cues;
    } catch (error) {
      trace("fetch-caption-api-error", { rawUrl, error: error.message });
      return [];
    }
  }

  function parseCaptionResponse(text, contentType, baseUrl) {
    const trimmed = text.trim();
    if (!trimmed) return [];

    const timedTextCues = parseTimedText(trimmed);
    if (timedTextCues.length) return timedTextCues;

    if (contentType.includes("json") || /^[{[]/.test(trimmed)) {
      try {
        return parseCaptionJson(JSON.parse(trimmed), baseUrl);
      } catch (error) {
        trace("caption-json-parse-error", { error: error.message });
      }
    }

    return [];
  }

  function parseCaptionJson(value, baseUrl) {
    const directText = findFirstString(value, [
      "webvtt_content",
      "webvttContent",
      "vtt",
      "content",
      "body",
      "transcript"
    ]);

    if (directText) {
      const cues = parseTimedText(directText);
      if (cues.length) return cues;
    }

    const cueArray = findCueArray(value);
    if (cueArray.length) return dedupeAndSort(cueArray);

    const url = findFirstString(value, ["url", "href", "download_url", "downloadUrl", "file"]);
    if (url && /\.(vtt|srt)(\?|$)/i.test(url)) {
      pendingCaptionUrls.add(new URL(url, baseUrl).href);
    }

    return [];
  }

  function findFirstString(value, keys) {
    if (!value || typeof value !== "object") return "";

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findFirstString(item, keys);
        if (found) return found;
      }
      return "";
    }

    for (const key of keys) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key];
    }

    for (const item of Object.values(value)) {
      const found = findFirstString(item, keys);
      if (found) return found;
    }

    return "";
  }

  function findCueArray(value) {
    const candidates = [];

    walkJson(value, (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const text = node.text || node.caption || node.body || node.value;
      const start = node.start ?? node.startTime ?? node.start_time ?? node.begin;
      const end = node.end ?? node.endTime ?? node.end_time ?? node.stop;

      const startSeconds = normalizeCueSeconds(start);
      const endSeconds = normalizeCueSeconds(end);
      if (typeof text === "string" && Number.isFinite(startSeconds)) {
        candidates.push({
          start: startSeconds,
          end: Number.isFinite(endSeconds) ? endSeconds : startSeconds + 3,
          text: cleanCueText(text)
        });
      }
    });

    return candidates.filter((cue) => cue.text);
  }

  function walkJson(value, visitor) {
    visitor(value);
    if (!value || typeof value !== "object") return;
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) walkJson(child, visitor);
  }

  function normalizeCueSeconds(value) {
    if (typeof value === "number") return value > 10000 ? value / 1000 : value;
    if (typeof value !== "string") return NaN;
    if (value.includes(":")) return parseTimestamp(value);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return NaN;
    return parsed > 10000 ? parsed / 1000 : parsed;
  }

  function parseTimedText(input) {
    const normalized = input.replace(/\r/g, "");
    const blocks = normalized.split(/\n\n+/);
    const cues = [];

    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const timeLineIndex = lines.findIndex((line) => line.includes("-->"));
      if (timeLineIndex === -1) continue;

      const [rawStart, rawEnd] = lines[timeLineIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
      const start = parseTimestamp(rawStart);
      const end = parseTimestamp(rawEnd);
      const text = cleanCueText(lines.slice(timeLineIndex + 1).join(" "));

      if (Number.isFinite(start) && Number.isFinite(end) && text) {
        cues.push({ start, end, text });
      }
    }

    return dedupeAndSort(cues);
  }

  function parseTimestamp(value) {
    const parts = value.replace(",", ".").split(":").map(Number);
    if (parts.some((part) => Number.isNaN(part))) return NaN;

    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return NaN;
  }

  function cleanCueText(text) {
    return text
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function dedupeAndSort(cues) {
    const seen = new Set();
    return cues
      .filter((cue) => {
        const key = `${cue.start.toFixed(2)}:${cue.end.toFixed(2)}:${cue.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.start - b.start);
  }

  function postToTop(type, payload) {
    window.top.postMessage({ source: SOURCE, type, payload }, "*");
  }

  function postFrameStatus(status, detail = {}) {
    postToTop("frame-status", {
      frameId: FRAME_ID,
      status,
      url: location.href,
      title: document.title,
      detail
    });
  }

  function sendTranscriptReady(cues, reason) {
    if (!videoState || (!videoState.video && !videoState.iframe) || transcriptSent || !cues.length) return;

    transcriptSent = true;
    videoState.cues = cues;
    const rawDuration = videoState.video?.duration ?? videoState.duration;
    const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;
    trace("cues-ready", { reason, count: cues.length, first: cues[0], last: cues[cues.length - 1] });
    postFrameStatus("cues-ready", { reason, count: cues.length, duration });
    postToTop("transcript-ready", {
      frameId: FRAME_ID,
      title: document.title || ariaVideoTitle() || "Video transcript",
      cues,
      duration
    });
  }

  async function queueObservedCaptionUrl(payload) {
    if (!payload?.url || !isCaptionUrl(payload.url)) return;

    const url = new URL(payload.url, location.href).href;
    pendingCaptionUrls.add(url);
    trace("caption-url-observed", { url });
    postFrameStatus("caption-url-observed", { url });

    if ((videoState?.video || videoState?.iframe) && !transcriptSent) {
      const cues = await fetchCaptionApiCues(url);
      sendTranscriptReady(cues, "observed-caption-api");
    }
  }

  function isCaptionUrl(url) {
    return /(caption_files|caption|transcript|subtitle|webvtt|\.vtt|\.srt|media_tracks|caption_tracks)/i.test(String(url));
  }

  function renderWaitingPanels() {
    const targets = findCanvasVideoTargets();
    if (!targets.length) return;

    targets.forEach((target, index) => {
      const frameId = waitingFrameIdForTarget(target, index);
      if (panelStates.has(frameId)) return;
      if (target.closest(".ctc-player-transcript-wrap")?.querySelector(".ctc-shell")) return;

      const shell = createShell();
      shell.querySelector(".ctc-status").textContent = "Looking for captions in this video...";
      insertPanel(shell, target);
      const state = { shell, frameWindow: null, frameId, cues: [], segments: [], activeIndex: -1, autoScroll: true };
      panelStates.set(frameId, state);
      shell.ctcState = state;
      wirePanelControls(shell, state);
      refreshDiagnostics(shell, state);
    });
  }

  function renderPanel(frameWindow, payload) {
    if (!payload || !Array.isArray(payload.cues) || !payload.cues.length) return;

    const target = findCanvasVideoTarget(frameWindow, payload);
    if (!target) return;

    const existingShell = target.closest(".ctc-player-transcript-wrap")?.querySelector(".ctc-shell");
    const shell = existingShell || createShell();
    const title = shell.querySelector(".ctc-title");
    const status = shell.querySelector(".ctc-status");
    const list = shell.querySelector(".ctc-list");

    const videoTitle = extractVideoTitle(target);
    title.textContent = videoTitle || "Transcript";
    status.hidden = true;
    list.hidden = false;
    list.textContent = "";

    const segments = buildReadableSegments(payload.cues);
    if (!shell.isConnected) insertPanel(shell, target);
    const existingState = shell.ctcState;
    const state = existingState && existingState.shell === shell ? existingState : { shell, activeIndex: -1, autoScroll: true };
    state.frameWindow = frameWindow;
    state.frameId = payload.frameId;
    state.cues = payload.cues;
    state.segments = segments;
    state.videoTitle = videoTitle;
    panelStates.set(payload.frameId, state);
    const waitingId = waitingFrameIdForTarget(target, findCanvasVideoTargets().indexOf(target));
    if (panelStates.get(waitingId)?.shell === shell) panelStates.delete(waitingId);
    shell.ctcState = state;
    list.append(buildTranscriptFragment(state));

    wirePanelControls(shell, state);
    refreshDiagnostics(shell, state);
  }

  function createShell() {
    const shell = document.createElement("section");
    shell.className = "ctc-shell";
    shell.setAttribute("aria-label", "Video transcript");
    shell.innerHTML = `
      <div class="ctc-header">
        <div class="ctc-title">Transcript</div>
        <div class="ctc-actions">
          <input class="ctc-search" type="search" placeholder="Search transcript" aria-label="Search transcript">
          <button class="ctc-icon-button ctc-tip" type="button" data-ctc-collapse aria-label="Collapse transcript" data-tip="Collapse" data-tip-pos="below">${phosphorIcon("caretUp")}</button>
          <button class="ctc-icon-button ctc-tip" type="button" data-ctc-theater aria-label="Open theater transcript" data-tip="Theater mode" data-tip-pos="below">${phosphorIcon("cornersOut")}</button>
          <button class="ctc-icon-button ctc-tip" type="button" data-ctc-copy aria-label="Copy transcript" data-tip="Copy transcript" data-tip-pos="below">${phosphorIcon("copy")}</button>
          <button class="ctc-icon-button ctc-tip" type="button" data-ctc-layout aria-label="Move transcript to side" data-tip="Move to side" data-tip-pos="below">${phosphorIcon("sidebar")}</button>
        </div>
      </div>
      <div class="ctc-status">Waiting for a captioned Canvas video...</div>
      <div class="ctc-list" hidden></div>
      <div class="ctc-debug-panel" hidden>
        <div class="ctc-debug-title">Diagnostics</div>
        <div class="ctc-debug-grid" data-ctc-debug-summary></div>
        <pre class="ctc-debug-log" data-ctc-debug-log></pre>
      </div>
    `;
    return shell;
  }

  function insertPanel(shell, target) {
    const wrapper = ensurePlayerTranscriptWrapper(target);
    if (!wrapper) return;

    if (window.innerWidth >= 1100) {
      wrapper.classList.add("ctc-canvas-side-layout");
      shell.dataset.layout = "side";
    } else {
      shell.dataset.layout = "below";
    }

    if (!shell.isConnected) {
      wrapper.append(shell);
    }
  }

  function ensurePlayerTranscriptWrapper(target) {
    const existing = target.closest(".ctc-player-transcript-wrap");
    if (existing) return existing;

    const wrapper = document.createElement("div");
    wrapper.className = "ctc-player-transcript-wrap";

    const playerSlot = document.createElement("div");
    playerSlot.className = "ctc-player-slot";

    target.parentNode?.insertBefore(wrapper, target);
    wrapper.append(playerSlot);
    playerSlot.append(target);

    return wrapper;
  }

  function wirePanelControls(shell, state = shell.ctcState) {
    const search = shell.querySelector(".ctc-search");
    const copy = shell.querySelector("[data-ctc-copy]");
    const layout = shell.querySelector("[data-ctc-layout]");
    const collapse = shell.querySelector("[data-ctc-collapse]");
    const theater = shell.querySelector("[data-ctc-theater]");

    layout.textContent = shell.dataset.layout === "side" ? "Below" : "Side";
    setLayoutButton(layout, shell.dataset.layout !== "side");

    if (!search.dataset.ctcWired) {
      search.dataset.ctcWired = "true";
      search.addEventListener("input", () => filterTranscript(search.value, shell.ctcState));
    }

    if (!copy.dataset.ctcWired) {
      copy.dataset.ctcWired = "true";
      copy.addEventListener("click", async () => {
        const currentState = shell.ctcState;
        const source = currentState?.segments?.length ? currentState.segments : currentState?.cues || [];
        const text = source.map((item) => `${formatTime(item.start)} ${item.text}`).join("\n");
        await navigator.clipboard.writeText(text).catch(() => {});
        copy.classList.add("is-copied");
        copy.innerHTML = phosphorIcon("check");
        copy.setAttribute("aria-label", "Copied transcript");
        copy.dataset.tip = "Copied!";
        setTimeout(() => {
          copy.classList.remove("is-copied");
          copy.innerHTML = phosphorIcon("copy");
          copy.setAttribute("aria-label", "Copy transcript");
          copy.dataset.tip = "Copy transcript";
        }, 1200);
      });
    }

    if (!theater.dataset.ctcWired) {
      theater.dataset.ctcWired = "true";
      theater.addEventListener("click", () => openTheater(shell.ctcState));
    }

    if (!layout.dataset.ctcWired) {
      layout.dataset.ctcWired = "true";
      layout.addEventListener("click", () => {
        const container = shell.closest(".ctc-player-transcript-wrap");
        const side = shell.dataset.layout !== "side";
        shell.dataset.layout = side ? "side" : "below";
        setLayoutButton(layout, !side);
        container?.classList.toggle("ctc-canvas-side-layout", side);
      });
    }

    if (!collapse.dataset.ctcWired) {
      collapse.dataset.ctcWired = "true";
      collapse.addEventListener("click", () => {
        const collapsed = !shell.classList.contains("is-collapsed");
        shell.classList.toggle("is-collapsed", collapsed);
        collapse.innerHTML = phosphorIcon(collapsed ? "caretDown" : "caretUp");
        collapse.setAttribute("aria-label", collapsed ? "Expand transcript" : "Collapse transcript");
        collapse.dataset.tip = collapsed ? "Expand" : "Collapse";
        collapse.setAttribute("aria-expanded", String(!collapsed));
      });
      collapse.setAttribute("aria-expanded", "true");
    }

    if (DEBUG_ENABLED) {
      shell.querySelector(".ctc-debug-panel").hidden = false;
      shell.classList.add("is-debug-open");
      refreshDiagnostics(shell, shell.ctcState);
    }
  }

  function setLayoutButton(button, moveToSide) {
    button.innerHTML = phosphorIcon(moveToSide ? "sidebar" : "rows");
    button.setAttribute("aria-label", moveToSide ? "Move transcript to side" : "Move transcript below video");
    button.dataset.tip = moveToSide ? "Move to side" : "Move below";
  }

  function phosphorIcon(name) {
    const common = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false"';
    const icons = {
      copy: `<svg ${common}><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>`,
      check: `<svg ${common}><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>`,
      caretUp: `<svg ${common}><path d="M213.66,165.66a8,8,0,0,1-11.32,0L128,91.31,53.66,165.66a8,8,0,0,1-11.32-11.32l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,213.66,165.66Z"/></svg>`,
      caretDown: `<svg ${common}><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg>`,
      sidebar: `<svg ${common}><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM40,152H56a8,8,0,0,0,0-16H40V120H56a8,8,0,0,0,0-16H40V88H56a8,8,0,0,0,0-16H40V56H80V200H40Zm176,48H96V56H216V200Z"/></svg>`,
      rows: `<svg ${common}><path d="M208,136H48a16,16,0,0,0-16,16v40a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V152A16,16,0,0,0,208,136Zm0,56H48V152H208v40Zm0-144H48A16,16,0,0,0,32,64v40a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V64A16,16,0,0,0,208,48Zm0,56H48V64H208v40Z"/></svg>`,
      cornersOut: `<svg ${common}><path d="M216,48V96a8,8,0,0,1-16,0V67.31l-42.34,42.35a8,8,0,0,1-11.32-11.32L188.69,56H160a8,8,0,0,1,0-16h48A8,8,0,0,1,216,48ZM98.34,146.34,56,188.69V160a8,8,0,0,0-16,0v48a8,8,0,0,0,8,8H96a8,8,0,0,0,0-16H67.31l42.35-42.34a8,8,0,0,0-11.32-11.32ZM208,152a8,8,0,0,0-8,8v28.69l-42.34-42.35a8,8,0,0,0-11.32,11.32L188.69,200H160a8,8,0,0,0,0,16h48a8,8,0,0,0,8-8V160A8,8,0,0,0,208,152ZM67.31,56H96a8,8,0,0,0,0-16H48a8,8,0,0,0-8,8V96a8,8,0,0,0,16,0V67.31l42.34,42.35a8,8,0,0,0,11.32-11.32Z"/></svg>`,
      x: `<svg ${common}><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg>`,
      dockLeft: `<svg ${common}><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM40,56H96V200H40ZM216,200H112V56H216V200Z"/></svg>`,
      dockRight: `<svg ${common}><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM40,56H160V200H40Zm120,144V56h56V200Z"/></svg>`,
      dockBottom: `<svg ${common}><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM40,56H216v88H40Zm0,144V160H216v40Z"/></svg>`,
      float: `<svg ${common}><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,160H40V56H216V200ZM184,96v64a8,8,0,0,1-8,8H112a8,8,0,0,1,0-16h44.69L72,67.31V112a8,8,0,0,1-16,0V96a32,32,0,0,1,32-32h16a8,8,0,0,1,0,16H88a16,16,0,0,0-16,16v.69L156.69,184H112a8,8,0,0,0,0,16h64a8,8,0,0,0,8-8V96Z"/></svg>`,
      circleHalf: `<svg ${common}><path d="M128,24A104,104,0,1,0,232,128,104.12,104.12,0,0,0,128,24Zm0,192V40a88,88,0,0,1,0,176Z"/></svg>`
    };
    return icons[name] || "";
  }

  function filterTranscript(query, state) {
    if (!state) return;

    const needle = query.trim().toLowerCase();
    const roots = [state.shell, state.theater?.transcript].filter(Boolean);
    roots.forEach((root) => {
      root.querySelectorAll(".ctc-sentence").forEach((sentence) => {
        sentence.classList.toggle("is-hidden", Boolean(needle) && !sentence.dataset.text.includes(needle));
        const text = sentence.querySelector(".ctc-sentence-text");
        const original = state.segments[Number(sentence.dataset.index)].text;
        if (!needle) {
          text.textContent = original;
          return;
        }
        text.replaceChildren(...highlightMatches(original, needle));
      });

      root.querySelectorAll(".ctc-paragraph").forEach((paragraph) => {
        paragraph.classList.toggle("is-hidden", Boolean(needle) && !paragraph.querySelector(".ctc-sentence:not(.is-hidden)"));
      });
    });

    if (state.theater) {
      const theaterSearch = state.theater.transcript.querySelector(".ctc-theater-search");
      if (theaterSearch && theaterSearch.value !== query) theaterSearch.value = query;
    }
    const shellSearch = state.shell.querySelector(".ctc-search");
    if (shellSearch && shellSearch.value !== query) shellSearch.value = query;
  }

  function openTheater(state) {
    if (!state?.shell || state.theater) return;

    const wrapper = state.shell.closest(".ctc-player-transcript-wrap");
    const playerSlot = wrapper?.querySelector(".ctc-player-slot");
    if (!wrapper || !playerSlot || !state.segments?.length) return;

    const placeholder = document.createComment("ctc-theater-placeholder");
    wrapper.parentNode.insertBefore(placeholder, wrapper);

    const titleText = state.videoTitle || "Transcript";

    const overlay = document.createElement("div");
    overlay.className = "ctc-theater-overlay";
    overlay.innerHTML = `
      <div class="ctc-theater-bar">
        <div class="ctc-theater-title" title="${escapeAttr(titleText)}">${escapeHtml(titleText)}</div>
        <div class="ctc-theater-tools">
          <button class="ctc-icon-button ctc-tip" type="button" data-ctc-theater-close aria-label="Close theater" data-tip="Close theater" data-tip-pos="below">${phosphorIcon("x")}</button>
        </div>
      </div>
      <div class="ctc-theater-stage" data-dock="right"></div>
    `;

    const stage = overlay.querySelector(".ctc-theater-stage");

    const transcript = document.createElement("div");
    transcript.className = "ctc-theater-transcript";
    transcript.dataset.dock = "right";
    transcript.style.setProperty("--ctc-theater-opacity", "0.85");
    transcript.innerHTML = `
      <div class="ctc-theater-transcript-bar" data-ctc-drag-handle>
        <span class="ctc-theater-transcript-label">Transcript</span>
        <div class="ctc-theater-transcript-controls">
          <button class="ctc-icon-button ctc-tip" type="button" data-ctc-dock="left" aria-label="Dock left" data-tip="Dock left" data-tip-pos="below">${phosphorIcon("dockLeft")}</button>
          <button class="ctc-icon-button ctc-tip" type="button" data-ctc-dock="bottom" aria-label="Dock bottom" data-tip="Dock bottom" data-tip-pos="below">${phosphorIcon("dockBottom")}</button>
          <button class="ctc-icon-button ctc-tip" type="button" data-ctc-dock="right" aria-label="Dock right" data-tip="Dock right" data-tip-pos="below">${phosphorIcon("dockRight")}</button>
          <button class="ctc-icon-button ctc-tip" type="button" data-ctc-dock="floating" aria-label="Float" data-tip="Float" data-tip-pos="below">${phosphorIcon("float")}</button>
          <div class="ctc-theater-opacity-wrap">
            <button class="ctc-icon-button ctc-tip" type="button" data-ctc-opacity-toggle aria-label="Opacity" data-tip="Opacity" data-tip-pos="below" aria-expanded="false">${phosphorIcon("circleHalf")}</button>
            <div class="ctc-theater-opacity-pop" data-ctc-opacity-pop hidden>
              <input type="range" min="20" max="100" value="85" data-ctc-theater-opacity aria-label="Transcript opacity">
            </div>
          </div>
          <button class="ctc-icon-button ctc-tip" type="button" data-ctc-transcript-collapse aria-label="Collapse transcript" data-tip="Collapse" data-tip-pos="below">${phosphorIcon("caretDown")}</button>
        </div>
      </div>
      <div class="ctc-theater-transcript-tools">
        <input class="ctc-theater-search" type="search" placeholder="Search transcript" aria-label="Search transcript">
      </div>
      <div class="ctc-theater-transcript-body"></div>
      <div class="ctc-theater-resize" data-ctc-resize aria-hidden="true"></div>
    `;
    transcript.querySelector(".ctc-theater-transcript-body").append(buildTranscriptFragment(state, true));

    state.shell.classList.add("ctc-theater-hidden-panel");
    stage.append(wrapper, transcript);
    document.documentElement.classList.add("ctc-theater-active");
    document.body.append(overlay);

    state.theater = {
      overlay,
      placeholder,
      transcript,
      wrapper,
      dock: "right",
      collapsed: false
    };

    overlay.querySelector("[data-ctc-theater-close]").addEventListener("click", () => closeTheater(state));
    transcript.querySelector("[data-ctc-theater-opacity]").addEventListener("input", (event) => {
      transcript.style.setProperty("--ctc-theater-opacity", String(Number(event.target.value) / 100));
    });

    const opacityToggle = transcript.querySelector("[data-ctc-opacity-toggle]");
    const opacityPop = transcript.querySelector("[data-ctc-opacity-pop]");
    opacityToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = opacityPop.hasAttribute("hidden");
      if (open) {
        opacityPop.removeAttribute("hidden");
        opacityToggle.setAttribute("aria-expanded", "true");
      } else {
        opacityPop.setAttribute("hidden", "");
        opacityToggle.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("click", (event) => {
      if (!state.theater) return;
      if (opacityPop.hasAttribute("hidden")) return;
      if (opacityPop.contains(event.target) || opacityToggle.contains(event.target)) return;
      opacityPop.setAttribute("hidden", "");
      opacityToggle.setAttribute("aria-expanded", "false");
    });

    const theaterSearch = transcript.querySelector(".ctc-theater-search");
    theaterSearch.addEventListener("input", () => filterTranscript(theaterSearch.value, state));
    const shellSearch = state.shell.querySelector(".ctc-search");
    if (shellSearch?.value) {
      theaterSearch.value = shellSearch.value;
      filterTranscript(shellSearch.value, state);
    }

    transcript.querySelectorAll("[data-ctc-dock]").forEach((button) => {
      button.addEventListener("click", () => setTranscriptDock(state, button.dataset.ctcDock));
    });

    const collapseBtn = transcript.querySelector("[data-ctc-transcript-collapse]");
    collapseBtn.addEventListener("click", () => toggleTranscriptCollapse(state, collapseBtn));

    setupTranscriptDrag(state);
    setupTranscriptResize(state);
    setTranscriptDock(state, "right");

    const onKeyDown = (event) => {
      if (event.key === "Escape") closeTheater(state);
    };
    state.theater.onKeyDown = onKeyDown;
    document.addEventListener("keydown", onKeyDown);
  }

  function setTranscriptDock(state, dock) {
    if (!state?.theater) return;
    const { transcript, overlay } = state.theater;
    const stage = overlay.querySelector(".ctc-theater-stage");
    const nextDock = ["left", "right", "bottom", "floating"].includes(dock) ? dock : "floating";

    if (state.theater.dock === "floating" && nextDock !== "floating") {
      const rect = transcript.getBoundingClientRect();
      state.theater.floatingRect = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      };
    }

    transcript.classList.remove("is-dragging");
    transcript.dataset.dock = nextDock;
    stage.dataset.dock = nextDock;
    state.theater.dock = nextDock;

    resetTheaterBoxStyles(transcript, stage);

    if (nextDock === "left") {
      stage.style.padding = "16px 16px 16px calc(12px + min(36vw, 460px) + 12px)";
      Object.assign(transcript.style, {
        left: "12px",
        top: "12px",
        bottom: "12px",
        width: "min(36vw, 460px)",
        minWidth: "240px",
        height: "auto"
      });
    } else if (nextDock === "right") {
      stage.style.padding = "16px calc(12px + min(36vw, 460px) + 12px) 16px 16px";
      Object.assign(transcript.style, {
        right: "12px",
        top: "12px",
        bottom: "12px",
        width: "min(36vw, 460px)",
        minWidth: "240px",
        height: "auto"
      });
    } else if (nextDock === "bottom") {
      stage.style.padding = "16px 16px calc(12px + clamp(140px, 30vh, 300px) + 12px)";
      Object.assign(transcript.style, {
        left: "12px",
        right: "12px",
        bottom: "12px",
        width: "auto",
        height: "clamp(140px, 30vh, 300px)"
      });
    } else {
      stage.style.padding = "16px";
      const rect = state.theater.floatingRect;
      if (rect) {
        Object.assign(transcript.style, {
          left: `${clamp(rect.left, 8, window.innerWidth - 120)}px`,
          top: `${clamp(rect.top, 8, window.innerHeight - 100)}px`,
          width: `${clamp(rect.width, 260, Math.max(300, window.innerWidth - 24))}px`,
          height: `${clamp(rect.height, 140, Math.max(180, window.innerHeight - 80))}px`
        });
      }
    }

    transcript.querySelectorAll("[data-ctc-dock]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.ctcDock === nextDock);
      button.setAttribute("aria-pressed", String(button.dataset.ctcDock === nextDock));
    });
  }

  function resetTheaterBoxStyles(transcript, stage) {
    stage.style.removeProperty("padding");
    [
      "left",
      "right",
      "top",
      "bottom",
      "width",
      "height",
      "min-width",
      "max-width",
      "min-height",
      "max-height",
      "transform"
    ].forEach((property) => transcript.style.removeProperty(property));
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function toggleTranscriptCollapse(state, button) {
    if (!state?.theater) return;
    const collapsed = !state.theater.collapsed;
    state.theater.collapsed = collapsed;
    state.theater.transcript.classList.toggle("is-collapsed", collapsed);
    button.innerHTML = phosphorIcon(collapsed ? "caretUp" : "caretDown");
    button.setAttribute("aria-label", collapsed ? "Expand transcript" : "Collapse transcript");
    button.dataset.tip = collapsed ? "Expand" : "Collapse";
  }

  function setupTranscriptDrag(state) {
    const { transcript } = state.theater;
    const handle = transcript.querySelector("[data-ctc-drag-handle]");
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    handle.addEventListener("pointerdown", (event) => {
      if (state.theater.dock !== "floating") return;
      if (event.target.closest("button")) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      const rect = transcript.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      transcript.style.left = `${originLeft}px`;
      transcript.style.top = `${originTop}px`;
      transcript.style.bottom = "auto";
      transcript.style.right = "auto";
      transcript.style.width = `${rect.width}px`;
      transcript.style.height = `${rect.height}px`;
      handle.setPointerCapture(event.pointerId);
      transcript.classList.add("is-dragging");
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const maxLeft = window.innerWidth - 80;
      const maxTop = window.innerHeight - 60;
      const left = Math.max(8, Math.min(maxLeft, originLeft + dx));
      const top = Math.max(8, Math.min(maxTop, originTop + dy));
      transcript.style.left = `${left}px`;
      transcript.style.top = `${top}px`;
    });

    const stopDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      transcript.classList.remove("is-dragging");
      try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
    };
    handle.addEventListener("pointerup", stopDrag);
    handle.addEventListener("pointercancel", stopDrag);
  }

  function setupTranscriptResize(state) {
    const { transcript } = state.theater;
    const grip = transcript.querySelector("[data-ctc-resize]");
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;

    grip.addEventListener("pointerdown", (event) => {
      if (state.theater.dock !== "floating") return;
      resizing = true;
      startX = event.clientX;
      startY = event.clientY;
      const rect = transcript.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      transcript.style.left = `${rect.left}px`;
      transcript.style.top = `${rect.top}px`;
      transcript.style.bottom = "auto";
      transcript.style.right = "auto";
      grip.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    grip.addEventListener("pointermove", (event) => {
      if (!resizing) return;
      const w = Math.max(260, startW + (event.clientX - startX));
      const h = Math.max(120, startH + (event.clientY - startY));
      transcript.style.width = `${w}px`;
      transcript.style.height = `${h}px`;
    });

    const stop = (event) => {
      if (!resizing) return;
      resizing = false;
      try { grip.releasePointerCapture(event.pointerId); } catch (_) {}
    };
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function closeTheater(state) {
    if (!state?.theater) return;

    const { overlay, placeholder, wrapper, onKeyDown } = state.theater;
    document.removeEventListener("keydown", onKeyDown);
    state.shell.classList.remove("ctc-theater-hidden-panel");
    placeholder.parentNode?.insertBefore(wrapper, placeholder);
    placeholder.remove();
    overlay.remove();
    document.documentElement.classList.remove("ctc-theater-active");
    state.theater = null;
  }

  function buildTranscriptFragment(state, forTheater = false) {
    const fragment = document.createDocumentFragment();
    const paragraphs = groupSegmentsIntoParagraphs(state.segments);

    paragraphs.forEach((paragraph) => {
      const paragraphEl = document.createElement("p");
      paragraphEl.className = "ctc-paragraph";

      paragraph.forEach((segment) => {
        const sentence = document.createElement("span");
        sentence.className = "ctc-sentence";
        sentence.role = "button";
        sentence.tabIndex = 0;
        sentence.dataset.index = String(segment.index);
        sentence.dataset.cueStart = String(segment.cueStart);
        sentence.dataset.cueEnd = String(segment.cueEnd);
        sentence.dataset.text = segment.text.toLowerCase();
        sentence.title = `Jump to ${formatTime(segment.start)}`;
        sentence.setAttribute("aria-label", `Jump to ${formatTime(segment.start)}: ${segment.text}`);

        const time = document.createElement("span");
        time.className = "ctc-sentence-time";
        time.textContent = formatTime(segment.start);

        const text = document.createElement("span");
        text.className = "ctc-sentence-text";
        text.textContent = segment.text;

        const seek = (event) => {
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) return;
          if (event?.detail > 1) return;
          seekToSegment(state, segment.start);
        };

        sentence.append(time, text);
        sentence.addEventListener("click", seek);
        sentence.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          seekToSegment(state, segment.start);
        });
        time.addEventListener("click", (event) => {
          event.stopPropagation();
          seekToSegment(state, segment.start);
        });

        paragraphEl.append(sentence, document.createTextNode(" "));
      });

      fragment.append(paragraphEl);
    });

    if (forTheater) fragment.firstElementChild?.classList.add("ctc-theater-first-paragraph");
    return fragment;
  }

  function seekToSegment(state, seconds) {
    if (!state) return;
    state.autoScroll = true;
    state.frameWindow?.postMessage({
      source: SOURCE,
      type: "seek",
      frameId: state.frameId,
      seconds
    }, "*");
  }

  function highlightMatches(text, needle) {
    const nodes = [];
    const lower = text.toLowerCase();
    let cursor = 0;
    let match = lower.indexOf(needle);

    while (match !== -1) {
      if (match > cursor) nodes.push(document.createTextNode(text.slice(cursor, match)));
      const mark = document.createElement("mark");
      mark.className = "ctc-mark";
      mark.textContent = text.slice(match, match + needle.length);
      nodes.push(mark);
      cursor = match + needle.length;
      match = lower.indexOf(needle, cursor);
    }

    if (cursor < text.length) nodes.push(document.createTextNode(text.slice(cursor)));
    return nodes;
  }

  function updateActiveCue(currentTime, frameId) {
    const state = panelStates.get(frameId);
    if (!state?.cues?.length) return;

    const index = state.cues.findIndex((cue) => currentTime >= cue.start && currentTime < cue.end);
    if (index === -1 || index === state.activeIndex) return;

    const containers = [state.shell, state.theater?.transcript].filter(Boolean);
    containers.forEach((container) => {
      container.querySelectorAll(".ctc-sentence.is-active").forEach((node) => node.classList.remove("is-active"));
      const sentence = Array.from(container.querySelectorAll(".ctc-sentence")).find((item) => {
        const start = Number(item.dataset.cueStart);
        const end = Number(item.dataset.cueEnd);
        return index >= start && index <= end;
      });
      sentence?.classList.add("is-active");
      if (sentence && state.autoScroll) {
        sentence.scrollIntoView({ block: "nearest" });
      }
    });

    state.activeIndex = index;
  }

  function buildReadableSegments(cues) {
    const segments = [];
    let current = null;

    cues.forEach((cue, cueIndex) => {
      const cueText = cleanSentenceText(cue.text);
      if (!cueText) return;

      if (!current) {
        current = {
          start: cue.start,
          end: cue.end,
          cueStart: cueIndex,
          cueEnd: cueIndex,
          parts: [cueText]
        };
      } else {
        current.end = cue.end;
        current.cueEnd = cueIndex;
        current.parts.push(cueText);
      }

      const text = current.parts.join(" ");
      const duration = current.end - current.start;
      const shouldClose = /[.!?]["')\]]?$/.test(cueText)
        || text.length >= 150
        || duration >= 12;

      if (shouldClose) {
        pushSegment();
      }
    });

    pushSegment();

    return mergeShortFragments(segments).map((segment, index) => ({ ...segment, index }));

    function pushSegment() {
      if (!current) return;
      const text = cleanSentenceText(current.parts.join(" "));
      if (text) {
        segments.push({
          start: current.start,
          end: current.end,
          cueStart: current.cueStart,
          cueEnd: current.cueEnd,
          text
        });
      }
      current = null;
    }
  }

  function mergeShortFragments(segments) {
    const merged = [];

    for (const segment of segments) {
      const previous = merged[merged.length - 1];
      const wordCount = segment.text.split(/\s+/).filter(Boolean).length;
      const shortFragment = wordCount <= 3 && segment.text.length <= 32;
      const closeToPrevious = previous && segment.start - previous.end <= 2.5;

      if (shortFragment && closeToPrevious) {
        previous.text = cleanSentenceText(`${previous.text} ${segment.text}`);
        previous.end = segment.end;
        previous.cueEnd = segment.cueEnd;
      } else {
        merged.push({ ...segment });
      }
    }

    return merged;
  }

  function groupSegmentsIntoParagraphs(segments) {
    const paragraphs = [];
    let current = [];

    segments.forEach((segment, index) => {
      const previous = segments[index - 1];
      const pause = previous ? segment.start - previous.end : 0;

      if (current.length && (current.length >= 4 || pause >= 3.5)) {
        paragraphs.push(current);
        current = [];
      }

      current.push(segment);
    });

    if (current.length) paragraphs.push(current);
    return paragraphs;
  }

  function cleanSentenceText(text) {
    return cleanCueText(text)
      .replace(/\s+([,.!?;:])/g, "$1")
      .replace(/([([{])\s+/g, "$1")
      .trim();
  }

  function extractVideoTitle(target) {
    if (!target) return "";
    const candidates = [];
    if (target.tagName === "IFRAME") {
      candidates.push(target.title);
      candidates.push(target.getAttribute("aria-label"));
    } else {
      candidates.push(target.title);
      candidates.push(target.getAttribute("aria-label"));
    }
    let node = target.parentElement;
    let depth = 0;
    while (node && depth < 5) {
      const labelled = node.getAttribute?.("aria-label");
      if (labelled) candidates.push(labelled);
      const heading = node.querySelector?.("h1, h2, h3, .ic-Action-header__Heading, .video-title, [data-testid='video-title']");
      if (heading?.textContent) candidates.push(heading.textContent);
      node = node.parentElement;
      depth += 1;
    }
    candidates.push(document.title);
    const found = candidates
      .map((value) => (value || "").replace(/\s+/g, " ").trim())
      .find((value) => value && !/^canvas$/i.test(value) && !/^video player$/i.test(value));
    return found || "";
  }

  function findCanvasVideoTargets() {
    return Array.from(document.querySelectorAll([
      'iframe[src*="instructuremedia.com"]',
      'iframe[src*="external_tools/retrieve"][src*="custom_arc_media_id"]',
      "video"
    ].join(","))).filter((target) => !target.closest(".ctc-shell"));
  }

  function findCanvasVideoTarget(frameWindow, payload) {
    const targets = findCanvasVideoTargets();
    const byWindow = targets.find((target) => target.tagName === "IFRAME" && target.contentWindow === frameWindow);
    if (byWindow) return byWindow;

    const byUrl = targets.find((target) => {
      const src = target.getAttribute("src") || "";
      return payload?.url && (src.includes(payload.url) || payload.url.includes(src));
    });
    if (byUrl) return byUrl;

    return targets.find((target) => !target.closest(".ctc-player-transcript-wrap")?.querySelector(".ctc-shell:not([data-ctc-waiting])"))
      || targets[0]
      || null;
  }

  function waitingFrameIdForTarget(target, index) {
    const src = target?.getAttribute?.("src") || target?.currentSrc || target?.src || "";
    return `waiting:${index}:${src}`;
  }

  function recordFrameStatus(payload) {
    if (!payload?.frameId) return;
    diagnostics.frames.set(payload.frameId, {
      ...payload,
      lastSeen: Date.now()
    });
    trace("frame-status", payload);
    for (const state of panelStates.values()) refreshDiagnostics(state.shell, state);
  }

  function recordNetworkEvent(payload) {
    diagnostics.network.unshift(payload);
    diagnostics.network = diagnostics.network.slice(0, 20);
    trace("network", payload);
    for (const state of panelStates.values()) refreshDiagnostics(state.shell, state);
  }

  function inspectVideo(video) {
    return {
      duration: Number.isFinite(video.duration) ? video.duration : null,
      currentTime: video.currentTime || 0,
      readyState: video.readyState,
      textTrackCount: video.textTracks?.length || 0,
      trackElementCount: document.querySelectorAll("track").length,
      tracks: Array.from(video.textTracks || []).map((track) => ({
        kind: track.kind,
        label: track.label,
        language: track.language,
        mode: track.mode,
        cueCount: track.cues?.length || 0
      })),
      trackElements: Array.from(document.querySelectorAll("track")).map((track) => ({
        kind: track.getAttribute("kind"),
        label: track.getAttribute("label"),
        srclang: track.getAttribute("srclang"),
        src: track.getAttribute("src")
      }))
    };
  }

  function trace(event, detail = {}) {
    const entry = {
      t: new Date().toISOString(),
      frameId: FRAME_ID,
      event,
      detail
    };
    diagnostics.events.unshift(entry);
    diagnostics.events = diagnostics.events.slice(0, 80);

    if (DEBUG_ENABLED) {
      console.debug("[Canvas Transcript Companion]", event, detail);
    }
  }

  function refreshDiagnostics(shell, state = shell.ctcState) {
    const summary = shell.querySelector("[data-ctc-debug-summary]");
    const log = shell.querySelector("[data-ctc-debug-log]");
    if (!summary || !log) return;

    const frameRows = Array.from(diagnostics.frames.values()).map((frame) => ({
      status: frame.status,
      title: frame.title || "Untitled frame",
      url: frame.url,
      detail: frame.detail
    }));

    const cueCount = state?.cues?.length || 0;
    summary.innerHTML = `
      <div><strong>Top frame</strong><span>${diagnostics.host}</span></div>
      <div><strong>Transcript cues</strong><span>${cueCount}</span></div>
      <div><strong>Video frames</strong><span>${frameRows.length}</span></div>
      <div><strong>Network hints</strong><span>${diagnostics.network.length}</span></div>
    `;

    const lines = [
      "Frames:",
      ...frameRows.map((frame) => `- ${frame.status}: ${frame.title} | ${frame.url} | ${safeJson(frame.detail)}`),
      "",
      "Network hints:",
      ...diagnostics.network.slice(0, 10).map((item) => `- ${item.kind}: ${item.url}`),
      "",
      "Recent events:",
      ...diagnostics.events.slice(0, 25).map((item) => `- ${item.t} ${item.event} ${safeJson(item.detail)}`)
    ];
    log.textContent = lines.join("\n");
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable]";
    }
  }

  function isCanvasLikePage() {
    return /(^|\.)instructure\.com$/.test(location.hostname)
      || /(^|\.)canvaslms\.com$/.test(location.hostname)
      || document.querySelector('iframe[src*="instructuremedia.com"], iframe[src*="custom_arc_media_id"]');
  }

  function ariaVideoTitle() {
    return document.querySelector("[aria-label*='Video Player']")?.getAttribute("aria-label") || "";
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;

    if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
})();

(() => {
  const SOURCE = "canvas-transcript-companion-page-monitor";
  const SHOULD_WATCH = /(^|\.)instructure(media)?\.com$/.test(location.hostname)
    || /(^|\.)canvaslms\.com$/.test(location.hostname);

  if (!SHOULD_WATCH || window.__ctcPageMonitorInstalled) return;
  window.__ctcPageMonitorInstalled = true;

  const interesting = /(caption|transcript|subtitle|webvtt|\.vtt|\.srt|media_tracks|caption_tracks|timedtext|deliveryinfo|playeroptions)/i;

  const notify = (kind, url, detail = {}) => {
    if (!url || !interesting.test(String(url))) return;
    window.postMessage({
      source: SOURCE,
      type: "network-observed",
      payload: {
        kind,
        url: String(url),
        detail,
        pageUrl: location.href,
        ts: Date.now()
      }
    }, "*");
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function monitoredFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url;
      notify("fetch", url, { method: init?.method || input?.method || "GET" });
      return originalFetch.apply(this, arguments);
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function monitoredOpen(method, url) {
    this.__ctcObservedUrl = url;
    this.__ctcObservedMethod = method;
    notify("xhr-open", url, { method });
    return originalOpen.apply(this, arguments);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function monitoredSend() {
    notify("xhr-send", this.__ctcObservedUrl, { method: this.__ctcObservedMethod || "GET" });
    return originalSend.apply(this, arguments);
  };
})();

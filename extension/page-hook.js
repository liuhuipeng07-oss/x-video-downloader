(() => {
  "use strict";
  const core = globalThis.XVideoCore;
  const cache = new Map();
  const publish = post => window.postMessage({source: "x-video-helper", type: "MEDIA", post}, location.origin);
  function collect(data) {
    for (const post of core.extractPosts(data)) {
      cache.delete(post.postId);
      cache.set(post.postId, post);
      if (cache.size > 400) cache.delete(cache.keys().next().value);
      publish(post);
    }
  }
  function relevant(value) {
    try {
      const url = new URL(value, location.href);
      return ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "api.x.com", "api.twitter.com"].includes(url.hostname) && /\/(?:i\/api\/graphql|graphql|1\.1|2)\//.test(url.pathname);
    } catch { return false; }
  }
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const result = Reflect.apply(originalFetch, this, args);
    if (relevant(typeof args[0] === "string" || args[0] instanceof URL ? String(args[0]) : args[0]?.url)) {
      result.then(response => {
        if (response.ok && /json/i.test(response.headers.get("content-type") || "") && Number(response.headers.get("content-length") || 0) < 8e6) {
          response.clone().text().then(body => { if (body.length < 8e6) collect(JSON.parse(body)); }).catch(() => {});
        }
      }).catch(() => {});
    }
    return result;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    if (relevant(String(args[1]))) {
      this.addEventListener("load", () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          if (this.responseType === "json") collect(this.response);
          else if ((!this.responseType || this.responseType === "text") && this.responseText.length < 8e6) collect(JSON.parse(this.responseText));
        } catch { /* Non-JSON responses are deliberately ignored. */ }
      }, {once: true});
    }
    return Reflect.apply(open, this, args);
  };
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== "x-video-helper-content" || event.data.type !== "READY") return;
    try { if (window.__INITIAL_STATE__) collect(window.__INITIAL_STATE__); } catch {}
    for (const post of cache.values()) publish(post);
  });
})();

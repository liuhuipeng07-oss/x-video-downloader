/* Shared, dependency-free parsing. No account credentials or full responses leave the page. */
(() => {
  "use strict";
  const validId = value => typeof value === "string" && /^\d{5,25}$/.test(value);
  function postId(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname) || url.username || url.password || url.port) return null;
      return url.pathname.match(/^\/(?:[^/]+\/status|i\/web\/status)\/(\d{5,25})(?:\/|$)/)?.[1] || null;
    } catch { return null; }
  }
  function mp4Url(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "video.twimg.com" && !url.username && !url.password && !url.port && !url.hash && /\.mp4$/i.test(url.pathname) ? url.href : null;
    } catch { return null; }
  }
  function posterUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "pbs.twimg.com" && !url.username && !url.password && !url.port ? url.href : "";
    } catch { return ""; }
  }
  function variants(list) {
    const found = new Map();
    for (const item of Array.isArray(list) ? list.slice(0, 30) : []) {
      const url = mp4Url(item?.url || item?.src);
      if (!url) continue;
      const match = new URL(url).pathname.match(/\/(\d{2,5})x(\d{2,5})\//);
      const width = Number(match?.[1] || 0), height = Number(match?.[2] || 0);
      found.set(url, {url, width, height, bitrate: Math.max(0, Number(item.bitrate || item.bit_rate) || 0), label: width && height ? `${width} × ${height}` : "MP4"});
    }
    return [...found.values()].sort((a, b) => b.width * b.height - a.width * a.height || b.bitrate - a.bitrate);
  }
  function mediaList(items) {
    return (Array.isArray(items) ? items : []).slice(0, 16).filter(m => m && (m.type === "video" || m.type === "animated_gif" || m.video_info)).map((m, index) => ({
      id: String(m.id_str || m.media_key || index),
      poster: posterUrl(m.media_url_https || m.media_url || m.poster),
      variants: variants(m.video_info?.variants || m.variants),
      durationMs: Math.max(0, Number(m.video_info?.duration_millis || m.durationMs) || 0)
    }));
  }
  function extractPosts(root) {
    const results = new Map(), seen = new WeakSet(), stack = [root];
    let remaining = 60000;
    while (stack.length && remaining-- > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      const legacy = node.legacy || node;
      const id = node.rest_id || legacy.id_str;
      if (validId(id)) {
        const source = legacy.extended_entities?.media || node.mediaDetails;
        let media = mediaList(source);
        // Older embed responses expose a single `video` instead of mediaDetails.
        if (!media.length && node.video?.variants) media = mediaList([{...node.video, type: "video"}]);
        if (media.length) results.set(id, {postId: id, media});
      }
      for (const value of Object.values(node)) if (value && typeof value === "object") stack.push(value);
    }
    return [...results.values()];
  }
  function cleanPost(post) {
    if (!post || !validId(post.postId) || !Array.isArray(post.media)) return null;
    const media = post.media.slice(0, 16).map((m, index) => ({
      id: String(m?.id || index).slice(0, 100), poster: posterUrl(m?.poster),
      durationMs: Math.max(0, Number(m?.durationMs) || 0), variants: variants(m?.variants)
    }));
    return media.length ? {postId: post.postId, media} : null;
  }
  function filename(id, index, variant) {
    if (!validId(id) || !Number.isInteger(index) || index < 0 || index > 15) throw new Error("视频编号无效");
    const [safe] = variants([variant]);
    if (!safe) throw new Error("视频地址无效");
    return `X_Videos/X_${id}_${index + 1}${safe.width ? `_${safe.width}x${safe.height}` : ""}.mp4`;
  }
  function sizeText(bytes) {
    return Number.isFinite(bytes) && bytes > 0 ? `${(bytes / 1048576).toFixed(2)} MB` : "大小未知";
  }
  function audioSize(durationMs) {
    return durationMs > 0 && Number.isFinite(durationMs) ? `约 ${sizeText(durationMs / 1000 * 128000 / 8)}` : "大小未知";
  }
  globalThis.XVideoCore = Object.freeze({validId, postId, mp4Url, variants, extractPosts, cleanPost, filename, sizeText, audioSize});
})();

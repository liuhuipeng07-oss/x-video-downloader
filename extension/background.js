importScripts("media-core.js");
const core = XVideoCore;
const inflight = new Map();
const sizeCache = new Map();
const recentClicks = new Map();
let creatingOffscreen, startingAudio = false;
const isX = value => { try { return ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(new URL(value).hostname) && new URL(value).protocol === "https:"; } catch { return false; } };

async function getSize(value) {
  const url = core.mp4Url(value);
  if (!url) throw new Error("视频地址无效");
  const cached = sizeCache.get(url);
  if (cached && Date.now() - cached.at < 300000) return cached.bytes;
  let bytes = null;
  try {
    const response = await fetch(url, {method: "HEAD", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10000), redirect: "error"});
    const length = Number(response.headers.get("content-length"));
    if (response.ok && Number.isSafeInteger(length) && length > 0) bytes = length;
  } catch {}
  sizeCache.set(url, {bytes, at: Date.now()});
  if (sizeCache.size > 100) sizeCache.delete(sizeCache.keys().next().value);
  return bytes;
}

async function resolvePost(id) {
  if (!core.validId(id)) throw new Error("请输入有效的 X 帖子链接");
  if (inflight.has(id)) return inflight.get(id);
  const task = (async () => {
    const key = `post:${id}`;
    const saved = (await chrome.storage.session.get(key))[key];
    if (saved?.post && Date.now() - saved.at < 5 * 60e3) return saved.post;
    if (saved?.retryAfter > Date.now()) throw new Error("X 暂时无法提供此视频，请稍后重试，或刷新 X 帖子后点击帖内下载按钮");
    const limited = (await chrome.storage.session.get("rateLimitUntil")).rateLimitUntil;
    if (limited > Date.now()) throw new Error("X 请求过于频繁，请稍后再试");
    const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
    try {
      const response = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${token}`, {
        credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15000)
      });
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        const until = Date.now() + Math.max(60, Number.isFinite(seconds) ? Math.min(seconds, 3600) : 60) * 1000;
        await chrome.storage.session.set({rateLimitUntil: until});
        throw new Error("X 请求过于频繁，请稍后再试");
      }
      if (!response.ok) throw new Error(`X 视频接口暂不可用（${response.status}），请在 X 页面播放后再用帖内按钮`);
      const body = await response.text();
      if (body.length > 2e6) throw new Error("帖子数据过大，请使用帖内下载按钮");
      const post = core.extractPosts(JSON.parse(body)).find(p => p.postId === id);
      if (!post?.media.length) throw new Error("公开接口未提供视频；请在 X 中打开并播放帖子，再点击帖内下载按钮");
      await chrome.storage.session.set({[key]: {post, at: Date.now()}});
      const entries = await chrome.storage.session.get(null);
      const expired = Object.keys(entries).filter(k => k.startsWith("post:") && k !== key && Date.now() - (entries[k].at || 0) > 5 * 60e3);
      if (expired.length) await chrome.storage.session.remove(expired);
      return post;
    } catch (error) {
      await chrome.storage.session.set({[key]: {at: Date.now(), retryAfter: Date.now() + 30000}});
      if (error.name === "TimeoutError" || error.name === "AbortError" || error instanceof TypeError) throw new Error("网络连接失败，请确认浏览器可以访问 X 后重试");
      throw error;
    }
  })();
  inflight.set(id, task);
  try { return await task; } finally { inflight.delete(id); }
}

async function sendStatus(job) {
  if (job.tabId != null) {
    try { await chrome.tabs.sendMessage(job.tabId, {type: "DOWNLOAD_STATUS", job}); } catch {}
  }
}
async function updateJob(id, patch) {
  const key = `download:${id}`;
  const job = (await chrome.storage.session.get(key))[key];
  if (!job) return;
  const next = {...job, ...patch};
  await chrome.storage.session.set({[key]: next});
  await sendStatus(next);
  if (next.blobJobId && ["complete", "interrupted"].includes(next.state)) {
    try { await chrome.runtime.sendMessage({target: "offscreen", type: "RELEASE_AUDIO", jobId: next.blobJobId}); } catch {}
  }
}
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state || delta.error) updateJob(delta.id, {
    ...(delta.state ? {state: delta.state.current} : {}),
    ...(delta.error ? {error: delta.error.current} : {})
  }).catch(() => {});
});

async function download(message, sender) {
  const id = message.postId, index = message.index;
  const [variant] = core.variants([message.variant]);
  if (!variant || !core.validId(id) || !Number.isInteger(index) || index < 0 || index > 15) throw new Error("视频信息无效，请刷新帖子后再试");
  const clickKey = `${sender.tab?.id ?? "popup"}:${id}:${index}`;
  const lastClick = recentClicks.get(clickKey) || 0;
  if (Date.now() - lastClick < 1500) throw new Error("下载已提交，请勿重复点击");
  recentClicks.set(clickKey, Date.now());
  if (recentClicks.size > 100) recentClicks.delete(recentClicks.keys().next().value);
  const downloadId = await chrome.downloads.download({url: variant.url, filename: core.filename(id, index, variant), conflictAction: "uniquify", saveAs: false});
  const job = {id: downloadId, postId: id, tabId: sender.tab?.id, index, format: "mp4", state: "in_progress", at: Date.now()};
  await chrome.storage.session.set({[`download:${downloadId}`]: job});
  // Catch downloads that completed or failed before the change listener saw the job.
  const [current] = await chrome.downloads.search({id: downloadId});
  if (current) await updateJob(downloadId, {state: current.state, error: current.error || ""});
  const all = await chrome.storage.session.get(null);
  const oldJobs = Object.keys(all).filter(k => k.startsWith("download:")).sort((a, b) => all[b].at - all[a].at).slice(30);
  if (oldJobs.length) await chrome.storage.session.remove(oldJobs);
  return {downloadId};
}

async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")]});
    if (!contexts.length) await chrome.offscreen.createDocument({url: "offscreen.html", reasons: ["WORKERS", "BLOBS"], justification: "在本机提取 X 视频音轨并编码为 MP3，关闭弹窗后继续转换"});
  })();
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}
async function publishAudio(job) {
  await chrome.storage.session.set({"audio:active": job});
  if (job.tabId != null) try { await chrome.tabs.sendMessage(job.tabId, {type: "AUDIO_STATUS", job}); } catch {}
}
async function startAudio(message, sender) {
  if (startingAudio) throw new Error("正在启动音轨转换，请稍候");
  const url = core.mp4Url(message.variant?.url);
  if (!url || !core.validId(message.postId) || !Number.isInteger(message.index) || message.index < 0 || message.index > 15) throw new Error("音轨来源无效，请刷新帖子后重试");
  startingAudio = true;
  try {
    const current = (await chrome.storage.session.get("audio:active"))["audio:active"];
    const contexts = await chrome.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")]});
    if (current?.state === "converting" && contexts.length) throw new Error("已有音轨正在转换，请等待完成，或在插件弹窗中取消");
    await ensureOffscreen();
    const job = {jobId: crypto.randomUUID(), postId: message.postId, index: message.index, tabId: sender.tab?.id, format: "mp3", state: "converting", progress: 0, at: Date.now()};
    await publishAudio(job);
    try {
      const result = await chrome.runtime.sendMessage({target: "offscreen", type: "CONVERT_AUDIO", jobId: job.jobId, url});
      if (!result?.ok) throw new Error(result?.error || "无法启动 MP3 转换");
    } catch (error) { await publishAudio({...job, state: "interrupted", error: error.message}); throw error; }
    return job;
  } finally { startingAudio = false; }
}
async function audioEvent(message) {
  const job = (await chrome.storage.session.get("audio:active"))["audio:active"];
  if (!job || job.jobId !== message.jobId || job.state !== "converting") throw new Error("音轨任务已结束");
  if (message.type === "AUDIO_PROGRESS") { await publishAudio({...job, progress: Math.min(100, Math.max(0, Number(message.progress) || 0))}); return {}; }
  if (message.type === "AUDIO_ERROR") { await publishAudio({...job, state: "interrupted", error: String(message.error || "音轨转换失败").slice(0, 250)}); return {}; }
  const prefix = `blob:chrome-extension://${chrome.runtime.id}/`;
  if (typeof message.blobUrl !== "string" || !message.blobUrl.startsWith(prefix)) throw new Error("MP3 文件地址无效");
  try {
    const downloadId = await chrome.downloads.download({url: message.blobUrl, filename: `X_Videos/X_${job.postId}_${job.index + 1}_audio.mp3`, conflictAction: "uniquify", saveAs: false});
    const downloadJob = {...job, id: downloadId, blobJobId: job.jobId, state: "in_progress"};
    await chrome.storage.session.set({[`download:${downloadId}`]: downloadJob});
    await chrome.storage.session.remove(["audio:active"]);
    await sendStatus(downloadJob);
    const [item] = await chrome.downloads.search({id: downloadId});
    if (item) await updateJob(downloadId, {state: item.state, error: item.error || ""});
    return {downloadId};
  } catch (error) { await publishAudio({...job, state: "interrupted", error: error.message}); throw error; }
}
async function cancelAudio() {
  const job = (await chrome.storage.session.get("audio:active"))["audio:active"];
  if (job?.state === "converting") return chrome.runtime.sendMessage({target: "offscreen", type: "CANCEL_AUDIO", jobId: job.jobId});
  return {};
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Offscreen messages may supply a local blob URL; page/content messages never can.
  if (sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("offscreen.html") && ["AUDIO_PROGRESS", "AUDIO_READY", "AUDIO_ERROR"].includes(message?.type)) {
    audioEvent(message).then(data => respond({ok: true, data})).catch(error => respond({ok: false, error: error.message}));
    return true;
  }
  if (sender.id !== chrome.runtime.id || !(sender.tab ? isX(sender.url) : sender.url === chrome.runtime.getURL("popup.html"))) return;
  const task = message?.type === "RESOLVE" ? resolvePost(message.postId)
    : message?.type === "SIZE" ? getSize(message.url)
    : message?.type === "DOWNLOAD" ? download(message, sender)
    : message?.type === "AUDIO_START" ? startAudio(message, sender)
    : message?.type === "AUDIO_CANCEL" ? cancelAudio()
    : message?.type === "RECENT" ? chrome.storage.session.get(null).then(all => Object.entries(all).filter(([k, v]) => k.startsWith("download:") || (k === "audio:active" && v)).map(([, v]) => v).sort((a, b) => b.at - a.at).slice(0, 3)) : null;
  if (!task) return;
  task.then(data => respond({ok: true, data})).catch(error => respond({ok: false, error: error.message || "操作失败，请重试"}));
  return true;
});

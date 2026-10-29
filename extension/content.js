(() => {
  "use strict";
  const core = XVideoCore, posts = new Map(), hosts = new Set();
  let scheduled = false;
  async function request(message) {
    try {
      const result = await chrome.runtime.sendMessage(message);
      if (!result?.ok) throw new Error(result?.error || "插件连接中断，请刷新 X 页面后再试");
      return result.data;
    } catch (error) {
      if (/Extension context invalidated|Receiving end does not exist/i.test(error.message)) throw new Error("插件已更新，请刷新 X 页面后再试");
      throw error;
    }
  }
  function remember(value) {
    const post = core.cleanPost(value);
    if (!post) return;
    posts.delete(post.postId);
    posts.set(post.postId, post);
    if (posts.size > 400) posts.delete(posts.keys().next().value);
    schedule();
  }
  window.addEventListener("message", event => {
    if (event.source === window && event.origin === location.origin && event.data?.source === "x-video-helper" && event.data.type === "MEDIA") remember(event.data.post);
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "DOWNLOAD_STATUS") {
      const job = message.job;
      for (const host of hosts) if (host.dataset.postId === job.postId) {
        const main = host.shadowRoot.querySelector(job.format === "mp3" ? ".audio" : ".main"), note = host.shadowRoot.querySelector(".note");
        if (job.format === "mp3") { host.audioBusy = false; main.disabled = false; }
        if (job.state === "complete") { main.textContent = job.format === "mp3" ? "✓ MP3 完成" : "✓ 下载完成"; note.textContent = ""; }
        else if (job.format === "mp3" && job.state === "in_progress") main.textContent = "♫ MP3 已提交";
        else if (job.state === "interrupted") { main.textContent = "↻ 重试下载"; note.textContent = `下载中断（${job.error || "未知原因"}），可重试或查看 Chrome 下载记录`; }
      }
    }
    if (message?.type === "AUDIO_STATUS") {
      for (const host of hosts) if (host.dataset.postId === message.job.postId) {
        const job = message.job, button = host.shadowRoot.querySelector(".audio"), note = host.shadowRoot.querySelector(".note");
        host.audioBusy = job.state === "converting"; button.disabled = host.audioBusy;
        button.textContent = host.audioBusy ? `♫ MP3 ${job.progress || 0}%` : "♫ 下载 MP3";
        note.textContent = host.audioBusy ? "正在本机提取音轨，关闭弹窗仍会继续；可在插件弹窗中取消" : job.error || "";
      }
    }
    // Only the extension popup can request cached page information; never page scripts.
    if (message?.type === "GET_POST") reply(posts.get(message.postId) || null);
  });
  function articleId(article) {
    const links = [...article.querySelectorAll('a[href*="/status/"]')];
    const timestamp = links.find(a => a.querySelector("time"));
    const primary = core.postId(timestamp?.href || "");
    // Match the displayed poster so a quoted video's ID does not get confused with its parent.
    const poster = article.querySelector("video[poster]")?.poster;
    if (poster) {
      const path = value => { try { return new URL(value).pathname; } catch { return ""; } };
      const candidates = [...posts.values()].filter(post => post.media.some(media => path(media.poster) === path(poster)));
      if (candidates.length) return candidates.find(p => p.postId === primary)?.postId || candidates[0].postId;
    }
    return primary;
  }
  function mount(article, id) {
    const host = document.createElement("span");
    host.className = "x-video-helper-host";
    host.dataset.postId = id;
    host.style.cssText = "display:block;position:relative;margin:8px 0 4px;max-width:100%;";
    const shadow = host.attachShadow({mode: "open"});
    shadow.innerHTML = `<style>
      :host{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#e7e9ea;font-size:13px;line-height:1.4}
      *{box-sizing:border-box} .bar{display:flex;justify-content:flex-end;align-items:center;gap:2px}
      button,select{font:inherit} button{cursor:pointer;border:1px solid #536471;background:#0f1419;color:#e7e9ea;border-radius:18px;padding:7px 13px;font-weight:650;white-space:nowrap}
      button:hover{background:#18364a;border-color:#1d9bf0} button:focus-visible,select:focus-visible{outline:2px solid #1d9bf0;outline-offset:2px} button:disabled{opacity:.55;cursor:wait}
      .main{color:#8bd1ff}.audio{color:#bfb1ff}.more{padding:7px 11px}.note{display:block;color:#d6a96b;text-align:right;font-size:12px;white-space:normal;margin-top:4px}
      .note:empty{display:none}.menu{position:absolute;right:0;top:40px;z-index:10000;width:min(320px,85vw);padding:14px;border:1px solid #536471;background:#15202b;box-shadow:0 8px 28px #0005;border-radius:14px}
      .menu[hidden]{display:none}.title{font-weight:700;margin-bottom:10px}.row{padding:8px 0;display:flex;align-items:center;gap:8px;border-top:1px solid #38444d}.row label{flex:1;min-width:0}.row select{display:block;max-width:100%;margin-top:4px;background:#0f1419;color:#e7e9ea;border:1px solid #536471;border-radius:6px;padding:5px}.row button{font-size:12px;padding:6px 10px}.hint,.size{color:#aebdca;font-size:12px;margin:8px 0 0}.size{display:block;line-height:1.5}
    </style><div class="bar"><button class="main" type="button" title="保存最高可用清晰度的 MP4">↓ 下载视频</button><button class="audio" type="button" title="提取音轨并保存为 128 kbps MP3">♫ 下载 MP3</button><button class="more" type="button" aria-label="选择视频和清晰度" aria-expanded="false">⌄</button></div><span class="note" role="status" aria-live="polite"></span><div class="menu" hidden></div>`;
    const main = shadow.querySelector(".main"), audio = shadow.querySelector(".audio"), more = shadow.querySelector(".more"), menu = shadow.querySelector(".menu"), note = shadow.querySelector(".note");
    host.closeMenu = () => { menu.hidden = true; more.setAttribute("aria-expanded", "false"); };
    host.addEventListener("click", event => event.stopPropagation());
    shadow.addEventListener("keydown", event => { if (event.key === "Escape") { host.closeMenu(); more.focus(); } });
    async function resolve() {
      if (posts.has(id)) return posts.get(id);
      const post = await request({type: "RESOLVE", postId: id});
      remember(post);
      return post;
    }
    async function save(index, variant, button) {
      note.textContent = "";
      button.disabled = true;
      main.textContent = "↓ 已提交下载";
      try {
        await request({type: "DOWNLOAD", postId: id, index, variant});
        host.closeMenu();
      } catch (error) { main.textContent = "↻ 重试下载"; note.textContent = error.message; }
      finally { button.disabled = false; }
    }
    async function saveAudio(index, variant, button) {
      if (host.audioBusy) return;
      button.disabled = true;
      try {
        await request({type: "AUDIO_START", postId: id, index, variant});
        host.audioBusy = true; audio.disabled = true; audio.textContent = "♫ MP3 转换中";
        note.textContent = "正在本机提取音轨，关闭弹窗仍会继续；可在插件弹窗中取消";
        host.closeMenu();
      } catch (error) { note.textContent = error.message; }
      finally { button.disabled = button === audio && !!host.audioBusy; }
    }
    function showMenu(post) {
      menu.replaceChildren();
      const title = document.createElement("div"); title.className = "title"; title.textContent = "选择视频与清晰度"; menu.append(title);
      post.media.forEach((media, index) => {
        const row = document.createElement("div"); row.className = "row";
        const label = document.createElement("label"); label.textContent = `视频 ${index + 1}`;
        const select = document.createElement("select"); select.setAttribute("aria-label", `视频 ${index + 1} 清晰度`);
        media.variants.forEach((v, n) => { const option = document.createElement("option"); option.value = String(n); option.textContent = `${v.label}${n === 0 ? " · 最高" : ""}`; select.append(option); });
        const button = document.createElement("button"); button.type = "button"; button.textContent = media.variants.length ? "MP4" : "暂无 MP4"; button.disabled = !media.variants.length;
        const mp3 = document.createElement("button"); mp3.type = "button"; mp3.textContent = "MP3"; mp3.title = "下载此视频的 MP3 音轨"; mp3.disabled = !media.variants.length || !!host.audioBusy;
        const size = document.createElement("span"); size.className = "size"; size.setAttribute("aria-live", "polite");
        let sizeRequest = 0;
        async function updateSize() {
          const variant = media.variants[Number(select.value)], sequence = ++sizeRequest;
          size.textContent = `MP4：查询中 · MP3：${core.audioSize(media.durationMs)}（估算）`;
          if (!variant) { size.textContent = "文件大小未知"; return; }
          try { const bytes = await request({type: "SIZE", url: variant.url}); if (sequence === sizeRequest) size.textContent = `MP4：${core.sizeText(bytes)} · MP3：${core.audioSize(media.durationMs)}（估算）`; }
          catch { if (sequence === sizeRequest) size.textContent = `MP4：大小未知 · MP3：${core.audioSize(media.durationMs)}（估算）`; }
        }
        select.addEventListener("change", updateSize);
        if (!media.variants.length) { const option = document.createElement("option"); option.textContent = "此视频暂无 MP4"; select.append(option); select.disabled = true; }
        button.addEventListener("click", () => save(index, media.variants[Number(select.value)], button));
        mp3.addEventListener("click", () => saveAudio(index, media.variants[0], mp3));
        label.append(select, size); row.append(label, button, mp3); menu.append(row); updateSize();
      });
      const hint = document.createElement("p"); hint.className = "hint"; hint.textContent = "保存到 Chrome 下载目录的 X_Videos 文件夹"; menu.append(hint);
      menu.hidden = false; more.setAttribute("aria-expanded", "true");
    }
    async function handle(choose, audioOnly = false) {
      if (choose && !menu.hidden) { host.closeMenu(); return; }
      main.disabled = more.disabled = true; note.textContent = "";
      try {
        const post = await resolve();
        if (!post?.media?.length) throw new Error("未识别到视频，请刷新帖子或先播放视频");
        showMenu(post);
      } catch (error) { note.textContent = error.message; }
      finally { main.disabled = more.disabled = false; }
    }
    main.addEventListener("click", () => handle(false)); audio.addEventListener("click", () => handle(false, true)); more.addEventListener("click", () => handle(true));
    const actions = [...article.querySelectorAll('[role="group"]')].at(-1);
    if (actions) actions.after(host); else article.append(host);
    hosts.add(host);
  }
  function scan() {
    scheduled = false;
    for (const host of hosts) if (!host.isConnected) hosts.delete(host);
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const id = articleId(article), existing = article.querySelector(".x-video-helper-host");
      const hasVideo = !!article.querySelector('video,[data-testid="videoPlayer"],[data-testid="videoComponent"]') || posts.has(id);
      if (existing && (existing.dataset.postId !== id || !hasVideo)) { hosts.delete(existing); existing.remove(); }
      if (id && hasVideo && !article.querySelector(".x-video-helper-host")) mount(article, id);
    }
  }
  function schedule() { if (!scheduled) { scheduled = true; setTimeout(scan, 180); } }
  document.addEventListener("click", event => { for (const host of hosts) if (!event.composedPath().includes(host)) host.closeMenu(); });
  new MutationObserver(schedule).observe(document, {childList: true, subtree: true, attributes: true, attributeFilter: ["href", "poster"]});
  schedule();
  window.postMessage({source: "x-video-helper-content", type: "READY"}, location.origin);
})();

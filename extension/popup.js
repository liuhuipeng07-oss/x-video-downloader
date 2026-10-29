"use strict";
const core = XVideoCore, form = document.querySelector("#form"), input = document.querySelector("#url"), status = document.querySelector("#status"), videos = document.querySelector("#videos"), submit = document.querySelector("#resolve");
let activeTab, resolveSequence = 0;
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "插件连接失败，请关闭弹窗后重试");
  return result.data;
}
function showStatus(text, error = false) { status.textContent = text; status.classList.toggle("error", error); }
document.querySelector("#paste").addEventListener("click", async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) { showStatus("剪贴板是空的，请先复制 X 帖子链接。", true); return; }
    if (!core.postId(text)) { showStatus("剪贴板中不是有效的 X 帖子链接，请先复制包含 /status/ 的链接。", true); return; }
    ++resolveSequence;
    submit.disabled = false;
    input.value = text;
    videos.replaceChildren();
    showStatus("地址已粘贴，点击「获取视频」。");
  } catch {
    showStatus("无法读取剪贴板，请检查 Chrome 的剪贴板权限，或手动粘贴链接。", true);
  }
});
async function renderJobs() {
  try {
    const jobs = await request({type: "RECENT"});
    document.querySelector("#recent").hidden = !jobs.length;
    const container = document.querySelector("#jobs"); container.replaceChildren();
    for (const job of jobs) {
      const line = document.createElement("div"); line.className = "job";
      const state = job.state === "complete" ? "✓ 下载完成" : job.state === "interrupted" ? `下载中断（${job.error || "未知原因"}）` : job.state === "converting" ? `♫ 转换中 ${job.progress || 0}%` : "↓ 下载中";
      line.textContent = `${state} · ${(job.format || "mp4").toUpperCase()} · 视频 ${job.index + 1}`;
      if (job.state === "converting") { const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "取消"; cancel.addEventListener("click", async () => { cancel.disabled = true; try { await request({type: "AUDIO_CANCEL"}); } catch (error) { showStatus(error.message, true); cancel.disabled = false; } }); line.append(cancel); }
      container.append(line);
    }
  } catch {}
}
function render(post) {
  videos.replaceChildren();
  post.media.forEach((media, index) => {
    const card = document.createElement("div"); card.className = "card";
    if (media.poster) { const img = document.createElement("img"); img.className = "thumb"; img.src = media.poster; img.alt = `视频 ${index + 1} 预览`; img.referrerPolicy = "no-referrer"; card.append(img); }
    const details = document.createElement("div"); details.className = "details";
    const title = document.createElement("strong"); title.textContent = `视频 ${index + 1}${media.durationMs ? ` · ${(media.durationMs / 1000).toFixed(1)} 秒` : ""}`;
    const controls = document.createElement("div"); controls.className = "controls";
    const select = document.createElement("select"); select.setAttribute("aria-label", `视频 ${index + 1} 清晰度`);
    media.variants.forEach((v, n) => { const option = document.createElement("option"); option.value = String(n); option.textContent = `${v.label}${n === 0 ? " · 最高" : ""}`; select.append(option); });
    const button = document.createElement("button"); button.type = "button"; button.textContent = media.variants.length ? "↓ MP4 视频" : "暂无 MP4";
    const mp3 = document.createElement("button"); mp3.type = "button"; mp3.className = "audio"; mp3.textContent = "♫ MP3 音轨"; mp3.disabled = !media.variants.length;
    const size = document.createElement("p"); size.className = "size"; size.setAttribute("aria-live", "polite");
    let sizeRequest = 0;
    async function updateSize() {
      const variant = media.variants[Number(select.value)], sequence = ++sizeRequest;
      size.textContent = `MP4：查询中 · MP3：${core.audioSize(media.durationMs)}（成品估算）`;
      if (!variant) { size.textContent = "文件大小未知"; return; }
      try {
        const bytes = await request({type: "SIZE", url: variant.url});
        if (sequence === sizeRequest) size.textContent = `MP4：${core.sizeText(bytes)} · MP3：${core.audioSize(media.durationMs)}（成品估算）`;
      } catch { if (sequence === sizeRequest) size.textContent = `MP4：大小未知 · MP3：${core.audioSize(media.durationMs)}（成品估算）`; }
    }
    select.addEventListener("change", updateSize);
    if (!media.variants.length) { const option = document.createElement("option"); option.textContent = "首版暂不支持分段视频"; select.append(option); select.disabled = button.disabled = true; }
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await request({type: "DOWNLOAD", postId: post.postId, index, variant: media.variants[Number(select.value)]});
        showStatus("已提交给 Chrome 下载。完成状态见下方，文件保存在下载目录的 X_Videos 文件夹。");
        await renderJobs();
      } catch (error) { showStatus(error.message, true); }
      finally { button.disabled = false; }
    });
    mp3.addEventListener("click", async () => {
      mp3.disabled = true;
      try { await request({type: "AUDIO_START", postId: post.postId, index, variant: media.variants[0]}); showStatus("正在本机转换 MP3（128 kbps）。关闭弹窗后仍会继续，请保持 Chrome 运行。"); await renderJobs(); }
      catch (error) { showStatus(error.message, true); }
      finally { mp3.disabled = false; }
    });
    controls.append(select, button, mp3); details.append(title, controls, size); card.append(details); videos.append(card);
    updateSize();
  });
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  const id = core.postId(input.value.trim());
  if (!id) { showStatus("请输入包含 /status/ 的 X 或 Twitter 帖子链接。", true); return; }
  const sequence = ++resolveSequence;
  submit.disabled = true; videos.replaceChildren(); showStatus("正在获取视频…");
  try {
    let post;
    if (activeTab?.id && core.postId(activeTab.url) === id) {
      try { post = await chrome.tabs.sendMessage(activeTab.id, {type: "GET_POST", postId: id}); } catch {}
    }
    post = core.cleanPost(post) || await request({type: "RESOLVE", postId: id});
    if (sequence !== resolveSequence || core.postId(input.value.trim()) !== id) return;
    render(post);
    showStatus(`找到 ${post.media.length} 个视频，已默认选择最高可用清晰度。`);
  } catch (error) { if (sequence === resolveSequence && core.postId(input.value.trim()) === id) showStatus(error.message, true); }
  finally { if (sequence === resolveSequence) submit.disabled = false; }
});
document.querySelector("#downloads").addEventListener("click", () => chrome.tabs.create({url: "chrome://downloads/"}));
chrome.storage.onChanged.addListener((changes, area) => { if (area === "session" && Object.keys(changes).some(key => key.startsWith("download:") || key === "audio:active")) renderJobs(); });
(async () => {
  try {
    [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!input.value && core.postId(activeTab?.url)) { input.value = activeTab.url; form.requestSubmit(); }
  } catch {}
  await renderJobs();
})();

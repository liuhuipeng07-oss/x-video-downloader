import {convertUrlToMp3} from './audio-engine.mjs';

const blobs = new Map();
let running;
const send = message => chrome.runtime.sendMessage(message).catch(() => {});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || (sender.url && sender.url !== chrome.runtime.getURL('background.js')) || message?.target !== 'offscreen') return;
  if (message.type === 'RELEASE_AUDIO') {
    const url = blobs.get(message.jobId);
    if (url) URL.revokeObjectURL(url);
    blobs.delete(message.jobId); respond({ok: true}); return;
  }
  if (message.type === 'CANCEL_AUDIO' && running?.jobId === message.jobId) {
    running.controller.abort(); respond({ok: true}); return;
  }
  if (message.type !== 'CONVERT_AUDIO') return;
  if (running) { respond({ok: false, error: '已有音轨正在转换，请等待完成'}); return; }
  if (!XVideoCore.mp4Url(message.url)) { respond({ok: false, error: '音轨来源无效'}); return; }
  const {jobId, url} = message, controller = new AbortController();
  running = {jobId, controller};
  respond({ok: true});
  let progress = 0, lastUpdate = 0;
  const report = () => send({type: 'AUDIO_PROGRESS', jobId, progress});
  // Heartbeat maintains progress through service-worker suspension and popup closure.
  const heartbeat = setInterval(report, 10000);
  convertUrlToMp3(url, {signal: controller.signal, onProgress: value => {
    progress = Math.floor(value * 100);
    if (Date.now() - lastUpdate > 750) { lastUpdate = Date.now(); report(); }
  }}).then(async buffer => {
    const blobUrl = URL.createObjectURL(new Blob([buffer], {type: 'audio/mpeg'}));
    blobs.set(jobId, blobUrl);
    const result = await send({type: 'AUDIO_READY', jobId, blobUrl, bytes: buffer.byteLength});
    if (!result?.ok) { URL.revokeObjectURL(blobUrl); blobs.delete(jobId); throw new Error(result?.error || 'MP3 下载启动失败'); }
  }).catch(error => send({type: 'AUDIO_ERROR', jobId, error: controller.signal.aborted ? '已取消 MP3 转换' : error.message || 'MP3 转换失败，请重试'})).finally(() => {
    clearInterval(heartbeat); running = null;
  });
});

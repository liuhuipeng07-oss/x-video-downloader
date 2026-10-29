const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const extension = path.join(__dirname, '../extension');
const id = '1234567890123456789';
function setup({response, status = 200, state = 'in_progress', failDownload = false, failAudio = false} = {}) {
  const data = {}, downloads = [], notices = [], offscreenMessages = []; let listener, onChanged, fetches = 0, hasOffscreen = false;
  const context = vm.createContext({URL, AbortSignal, crypto: require('node:crypto').webcrypto, console, setTimeout, clearTimeout,
    chrome: {
      runtime: {id: 'test', getURL: file => `chrome-extension://test/${file}`, onMessage: {addListener: fn => { listener = fn; }}, getContexts: async () => hasOffscreen ? [{documentUrl: 'chrome-extension://test/offscreen.html'}] : [], sendMessage: async message => { offscreenMessages.push(message); if (failAudio && message.type === 'CONVERT_AUDIO') throw new Error('offscreen failed'); return {ok: true}; }},
      offscreen: {createDocument: async () => { hasOffscreen = true; }},
      storage: {session: {get: async key => key === null ? {...data} : {[key]: data[key]}, set: async value => Object.assign(data, value), remove: async keys => { for (const key of keys) delete data[key]; }}},
      tabs: {sendMessage: async (tabId, message) => notices.push({tabId, message})},
      downloads: {onChanged: {addListener: fn => { onChanged = fn; }}, download: async options => { if (failDownload) throw new Error('Download blocked'); downloads.push(options); return 99; }, search: async () => [{state}]}
    },
    fetch: async () => { fetches++; return {ok: status === 200, status, headers: new Map(), text: async () => JSON.stringify(response || {})}; }
  });
  context.importScripts = file => vm.runInContext(fs.readFileSync(path.join(extension, file), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
  const sender = {id: 'test', url: 'https://x.com/a/status/' + id, tab: {id: 7}};
  function send(message, from = sender) { return new Promise(resolve => { const result = listener(message, from, resolve); if (!result) resolve(undefined); }); }
  return {send, data, downloads, notices, offscreenMessages, onChanged: delta => onChanged(delta), get fetches() { return fetches; }};
}
const variant = {url: 'https://video.twimg.com/amplify_video/1/vid/720x1280/test.mp4'};
test('reject untrusted senders, malformed IDs and arbitrary download hosts', async () => {
  const app = setup();
  assert.equal(await app.send({type: 'RESOLVE', postId: id}, {id: 'foreign', url: 'https://x.com/', tab: {id: 1}}), undefined);
  assert.equal(await app.send({type: 'RESOLVE', postId: id}, {id: 'test', url: 'https://evil.test/', tab: {id: 1}}), undefined);
  assert.equal((await app.send({type: 'RESOLVE', postId: '../123'})).ok, false);
  assert.equal((await app.send({type: 'DOWNLOAD', postId: id, index: 0, variant: {url: 'https://evil.test/a.mp4'}})).ok, false);
  assert.equal(app.fetches, 0); assert.equal(app.downloads.length, 0);
});
test('real tweet fixture resolves once; concurrent requests and cache avoid duplicate network calls', async () => {
  const response = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/public-post.json'), 'utf8'));
  const app = setup({response});
  const [a, b] = await Promise.all([app.send({type: 'RESOLVE', postId: id}), app.send({type: 'RESOLVE', postId: id})]);
  assert.equal(a.ok, true); assert.equal(b.data.postId, id);
  assert.equal((await app.send({type: 'RESOLVE', postId: id})).ok, true); assert.equal(app.fetches, 1);
});
test('HTTP 429 establishes a global cooldown even for a different tweet', async () => {
  const app = setup({status: 429});
  assert.equal((await app.send({type: 'RESOLVE', postId: id})).ok, false);
  assert.equal((await app.send({type: 'RESOLVE', postId: '9876543210123456789'})).ok, false);
  assert.equal(app.fetches, 1); assert.ok(app.data.rateLimitUntil > Date.now());
});
test('empty public response gives actionable error and a retry cooldown', async () => {
  const app = setup();
  const result = await app.send({type: 'RESOLVE', postId: id});
  assert.equal(result.ok, false); assert.match(result.error, /播放帖子/);
  await app.send({type: 'RESOLVE', postId: id}); assert.equal(app.fetches, 1);
});
test('download uses safe filename and reports actual completion; repeat clicks are suppressed', async () => {
  const app = setup({state: 'complete'});
  const result = await app.send({type: 'DOWNLOAD', postId: id, index: 0, variant});
  assert.equal(result.ok, true); assert.equal(result.data.downloadId, 99);
  assert.equal(app.downloads[0].filename, `X_Videos/X_${id}_1_720x1280.mp4`);
  assert.equal(app.downloads[0].saveAs, false);
  assert.equal(app.data['download:99'].state, 'complete');
  assert.equal(app.notices[0].message.job.state, 'complete');
  assert.equal((await app.send({type: 'DOWNLOAD', postId: id, index: 0, variant})).ok, false);
  assert.equal(app.downloads.length, 1);
});
test('download failure is returned, not reported as a successful save', async () => {
  const app = setup({failDownload: true});
  const result = await app.send({type: 'DOWNLOAD', postId: id, index: 0, variant});
  assert.equal(result.ok, false); assert.match(result.error, /blocked/);
  assert.equal(Object.keys(app.data).filter(k => k.startsWith('download:')).length, 0);
});
test('later network interruption updates status and page notification', async () => {
  const app = setup();
  await app.send({type: 'DOWNLOAD', postId: id, index: 0, variant});
  app.onChanged({id: 99, state: {current: 'interrupted'}, error: {current: 'NETWORK_FAILED'}});
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(app.data['download:99'].state, 'interrupted');
  assert.equal(app.notices.at(-1).message.job.error, 'NETWORK_FAILED');
});
test('MP3 starts one offscreen conversion, streams progress, downloads a real local blob and releases it only after completion', async () => {
  const app = setup();
  const started = await app.send({type: 'AUDIO_START', postId: id, index: 0, variant});
  assert.equal(started.ok, true); const jobId = started.data.jobId;
  assert.equal(app.data['audio:active'].state, 'converting');
  assert.equal((await app.send({type: 'AUDIO_START', postId: id, index: 0, variant})).ok, false);
  const sender = {id: 'test', url: 'chrome-extension://test/offscreen.html'};
  assert.equal((await app.send({type: 'AUDIO_PROGRESS', jobId, progress: 42}, sender)).ok, true);
  assert.equal(app.data['audio:active'].progress, 42);
  const result = await app.send({type: 'AUDIO_READY', jobId, blobUrl: 'blob:chrome-extension://test/123'}, sender);
  assert.equal(result.ok, true); assert.equal(app.downloads[0].filename, `X_Videos/X_${id}_1_audio.mp3`);
  assert.equal(app.data['audio:active'], undefined); assert.equal(app.data['download:99'].format, 'mp3');
  assert.equal(app.offscreenMessages.filter(m => m.type === 'RELEASE_AUDIO').length, 0);
  app.onChanged({id: 99, state: {current: 'complete'}}); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(app.offscreenMessages.find(m => m.type === 'RELEASE_AUDIO').jobId, jobId);
});
test('page messages cannot forge MP3 blobs or offscreen progress', async () => {
  const app = setup();
  assert.equal(await app.send({type: 'AUDIO_READY', jobId: 'forged', blobUrl: 'blob:chrome-extension://test/evil'}), undefined);
  assert.equal((await app.send({type: 'AUDIO_START', postId: id, index: 0, variant: {url: 'https://evil.test/a.mp4'}})).ok, false);
  assert.equal(app.downloads.length, 0);
});
test('MP3 cancellation is routed to the active job and conversion errors become retryable status', async () => {
  const app = setup(); const started = await app.send({type: 'AUDIO_START', postId: id, index: 0, variant});
  await app.send({type: 'AUDIO_CANCEL'});
  assert.equal(app.offscreenMessages.at(-1).type, 'CANCEL_AUDIO');
  assert.equal((await app.send({type: 'AUDIO_ERROR', jobId: started.data.jobId, error: '这个视频没有音轨'}, {id: 'test', url: 'chrome-extension://test/offscreen.html'})).ok, true);
  assert.equal(app.data['audio:active'].state, 'interrupted');
  assert.equal((await app.send({type: 'AUDIO_START', postId: id, index: 0, variant})).ok, true);
});
test('failed offscreen startup is marked failed so retries are not blocked indefinitely', async () => {
  const app = setup({failAudio: true});
  assert.equal((await app.send({type: 'AUDIO_START', postId: id, index: 0, variant})).ok, false);
  assert.equal(app.data['audio:active'].state, 'interrupted');
  assert.match(app.data['audio:active'].error, /offscreen failed/);
});

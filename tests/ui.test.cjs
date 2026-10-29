const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const extension = path.join(__dirname, '../extension');
const id = '1234567890123456789', quoteId = '9876543210123456789';
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/public-post.json'), 'utf8'));
const pause = (ms = 240) => new Promise(resolve => setTimeout(resolve, ms));
const load = (window, file) => window.eval(fs.readFileSync(path.join(extension, file), 'utf8'));
const article = (postId = id, poster = fixture.mediaDetails[0].media_url_https) => `<article data-testid="tweet"><a href="https://x.com/a/status/${postId}"><time>今天</time></a><div data-testid="videoPlayer"><video poster="${poster}"></video></div><div role="group"><button>喜欢</button></div></article>`;
function content(html = article(), {resolveError, downloadError} = {}) {
  const dom = new JSDOM(html, {url: `https://x.com/a/status/${id}`, runScripts: 'outside-only'}), w = dom.window, messages = [];
  let listener;
  w.chrome = {runtime: {id: 'test', onMessage: {addListener: fn => { listener = fn; }}, sendMessage: async message => {
    messages.push(message);
    if (message.type === 'RESOLVE') return resolveError ? {ok: false, error: resolveError} : {ok: true, data: w.XVideoCore.extractPosts(fixture)[0]};
    if (message.type === 'DOWNLOAD') return downloadError ? {ok: false, error: downloadError} : {ok: true, data: {downloadId: 99}};
    if (message.type === 'SIZE') return {ok: true, data: 1459093};
    if (message.type === 'AUDIO_START') return {ok: true, data: {jobId: 'audio-test'}};
  }}};
  load(w, 'media-core.js'); load(w, 'content.js');
  const bridge = post => w.dispatchEvent(new w.MessageEvent('message', {source: w, origin: w.location.origin, data: {source: 'x-video-helper', type: 'MEDIA', post}}));
  return {dom, w, messages, bridge, status: job => listener({type: 'DOWNLOAD_STATUS', job}, {id: 'test'}, () => {})};
}
test('post button saves highest quality on one click, suppresses navigation, and only says completed after Chrome status', async t => {
  const app = content(); t.after(() => app.dom.window.close()); await pause();
  const host = app.w.document.querySelector('.x-video-helper-host'); assert.ok(host);
  let bubbled = false; app.w.document.querySelector('article').addEventListener('click', () => { bubbled = true; });
  host.shadowRoot.querySelector('.main').click(); await pause(15);
  assert.match(host.shadowRoot.querySelector('.size').textContent, /MP4：1.39 MB.*MP3：约/);
  host.shadowRoot.querySelector('.row button').click(); await pause(15);
  assert.equal(bubbled, false);
  const request = app.messages.find(m => m.type === 'DOWNLOAD'); assert.equal(request.variant.width, 720); assert.equal(request.postId, id);
  assert.doesNotMatch(host.shadowRoot.querySelector('.main').textContent, /完成/);
  app.status({postId: id, state: 'complete'}); assert.match(host.shadowRoot.querySelector('.main').textContent, /下载完成/);
});
test('quality menu chooses the requested variant and closes on outside click / Escape', async t => {
  const app = content(); t.after(() => app.dom.window.close()); await pause();
  const shadow = app.w.document.querySelector('.x-video-helper-host').shadowRoot;
  shadow.querySelector('.more').click(); await pause(15); assert.equal(shadow.querySelector('.menu').hidden, false);
  const select = shadow.querySelector('select'); select.value = '2'; shadow.querySelector('.row button').click(); await pause(15);
  assert.equal(app.messages.find(m => m.type === 'DOWNLOAD').variant.width, 320);
  shadow.querySelector('.more').click(); await pause(10); app.w.document.body.click(); assert.equal(shadow.querySelector('.menu').hidden, true);
  shadow.querySelector('.more').click(); await pause(10); shadow.querySelector('select').dispatchEvent(new app.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  assert.equal(shadow.querySelector('.menu').hidden, true);
});
test('infinite scrolling and recycled articles do not duplicate buttons or retain the old post ID', async t => {
  const app = content(); t.after(() => app.dom.window.close()); await pause();
  app.w.document.querySelector('article').append(app.w.document.createElement('div')); await pause();
  assert.equal(app.w.document.querySelectorAll('.x-video-helper-host').length, 1);
  app.w.document.querySelector('a').href = 'https://x.com/a/status/' + quoteId; await pause();
  assert.equal(app.w.document.querySelectorAll('.x-video-helper-host').length, 1);
  assert.equal(app.w.document.querySelector('.x-video-helper-host').dataset.postId, quoteId);
  app.w.document.body.insertAdjacentHTML('beforeend', article(id)); await pause();
  assert.equal(app.w.document.querySelectorAll('.x-video-helper-host').length, 2);
});
test('quoted video poster binds the download button to the quoted source; malformed bridge data is ignored', async t => {
  const app = content(article(quoteId)); t.after(() => app.dom.window.close());
  app.bridge({postId: 'bad', media: []});
  app.bridge(app.w.XVideoCore.extractPosts(fixture)[0]); await pause();
  const host = app.w.document.querySelector('.x-video-helper-host'); assert.equal(host.dataset.postId, id);
  host.shadowRoot.querySelector('.main').click(); await pause(15);
  host.shadowRoot.querySelector('.row button').click(); await pause(15);
  assert.equal(app.messages.filter(m => m.type === 'RESOLVE').length, 0);
  assert.equal(app.messages.find(m => m.type === 'DOWNLOAD').postId, id);
});
test('multi-video click opens a picker and never silently downloads a different video', async t => {
  const app = content(); t.after(() => app.dom.window.close());
  const post = app.w.XVideoCore.extractPosts(fixture)[0]; post.media.push({...post.media[0], id: 'second'}); app.bridge(post); await pause();
  const shadow = app.w.document.querySelector('.x-video-helper-host').shadowRoot;
  shadow.querySelector('.main').click(); await pause(15);
  assert.equal(app.messages.filter(m => m.type === 'DOWNLOAD').length, 0); assert.equal(shadow.querySelectorAll('.row').length, 2);
  shadow.querySelectorAll('.row')[1].querySelector('button').click(); await pause(15); assert.equal(app.messages.find(m => m.type === 'DOWNLOAD').index, 1);
});
test('HLS-only media and network failures show actionable errors without creating a download', async t => {
  const app = content(undefined, {resolveError: '网络连接失败'}); t.after(() => app.dom.window.close()); await pause();
  const shadow = app.w.document.querySelector('.x-video-helper-host').shadowRoot;
  shadow.querySelector('.main').click(); await pause(15); assert.match(shadow.querySelector('.note').textContent, /网络连接失败/);
  app.bridge({postId: id, media: [{id: 'hls', variants: []}]}); await pause(); shadow.querySelector('.main').click(); await pause(15);
  assert.match(shadow.querySelector('.row button').textContent, /暂无 MP4/); assert.equal(app.messages.filter(m => m.type === 'DOWNLOAD').length, 0);
});
test('page fetch observer keeps response readable and republishes sanitized media after READY', async t => {
  const dom = new JSDOM('', {url: 'https://x.com/home', runScripts: 'outside-only'}), w = dom.window; t.after(() => w.close());
  const sent = []; w.postMessage = message => sent.push(message);
  w.fetch = async () => new Response(JSON.stringify({data: fixture}), {headers: {'content-type': 'application/json'}});
  load(w, 'media-core.js'); load(w, 'page-hook.js');
  const response = await w.fetch('https://x.com/i/api/graphql/abc/HomeTimeline');
  assert.equal((await response.json()).data.id_str, id); await pause(30);
  assert.equal(sent[0].post.postId, id); assert.equal(sent[0].post.media[0].variants[0].width, 720);
  assert.equal(sent[0].post.text, undefined); assert.equal(sent[0].post.user, undefined);
  const count = sent.length;
  w.dispatchEvent(new w.MessageEvent('message', {source: w, origin: w.location.origin, data: {source: 'x-video-helper-content', type: 'READY'}}));
  assert.ok(sent.length > count);
});
test('popup prefills current tweet, renders variants, selects a quality and submits the correct download', async t => {
  const dom = new JSDOM(fs.readFileSync(path.join(extension, 'popup.html'), 'utf8'), {url: 'https://extension.test/popup.html', runScripts: 'outside-only'}), w = dom.window; t.after(() => w.close());
  const messages = [];
  w.chrome = {runtime: {sendMessage: async message => { messages.push(message); return {ok: true, data: message.type === 'RECENT' ? [] : message.type === 'RESOLVE' ? w.XVideoCore.extractPosts(fixture)[0] : {downloadId: 99}}; }}, tabs: {query: async () => [{id: 1, url: 'https://x.com/a/status/' + id}], sendMessage: async () => null, create: async () => {}}, storage: {onChanged: {addListener: () => {}}}};
  load(w, 'media-core.js'); load(w, 'popup.js'); await pause(10);
  assert.equal(w.document.querySelector('#url').value, 'https://x.com/a/status/' + id);
  await pause(15);
  assert.equal(messages.filter(m => m.type === 'RESOLVE').length, 1);
  assert.equal(w.document.querySelectorAll('.card').length, 1); assert.equal(w.document.querySelector('select').options.length, 3);
  w.document.querySelector('select').value = '1'; w.document.querySelector('.controls button').click(); await pause(15);
  assert.equal(messages.find(m => m.type === 'DOWNLOAD').variant.width, 480); assert.match(w.document.querySelector('#status').textContent, /已提交/);
  w.document.querySelector('.controls .audio').click(); await pause(15);
  assert.equal(messages.find(m => m.type === 'AUDIO_START').postId, id); assert.match(w.document.querySelector('#status').textContent, /关闭弹窗后仍会继续/);
});
test('one-click MP3 starts audio conversion rather than downloading a renamed MP4', async t => {
  const app = content(); t.after(() => app.dom.window.close()); await pause();
  const shadow = app.w.document.querySelector('.x-video-helper-host').shadowRoot;
  shadow.querySelector('.audio').click(); await pause(15);
  assert.match(shadow.querySelector('.size').textContent, /MP3：约/);
  shadow.querySelectorAll('.row button')[1].click(); await pause(15);
  assert.equal(app.messages.filter(m => m.type === 'DOWNLOAD').length, 0);
  assert.equal(app.messages.find(m => m.type === 'AUDIO_START').postId, id);
  assert.equal(shadow.querySelector('.audio').disabled, true);
});
test('paste button inserts a valid clipboard link without starting a download, and handles invalid clipboard text', async t => {
  const dom = new JSDOM(fs.readFileSync(path.join(extension, 'popup.html'), 'utf8'), {url: 'https://extension.test/popup.html', runScripts: 'outside-only'}), w = dom.window; t.after(() => w.close());
  let clipboard = 'https://x.com/a/status/' + id; const messages = [];
  Object.defineProperty(w.navigator, 'clipboard', {value: {readText: async () => clipboard}});
  w.chrome = {runtime: {sendMessage: async message => { messages.push(message); return {ok: true, data: []}; }}, tabs: {query: async () => [], create: async () => {}}, storage: {onChanged: {addListener: () => {}}}};
  load(w, 'media-core.js'); load(w, 'popup.js'); await pause(10);
  w.document.querySelector('#paste').click(); await pause(10);
  assert.equal(w.document.querySelector('#url').value, clipboard);
  assert.match(w.document.querySelector('#status').textContent, /已粘贴/);
  assert.equal(messages.filter(m => m.type === 'RESOLVE' || m.type === 'DOWNLOAD').length, 0);
  clipboard = '不是链接'; w.document.querySelector('#paste').click(); await pause(10);
  assert.match(w.document.querySelector('#status').textContent, /不是有效/);
  assert.equal(w.document.querySelector('#url').value, 'https://x.com/a/status/' + id);
});

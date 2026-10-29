const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const context = vm.createContext({URL});
vm.runInContext(fs.readFileSync(path.join(root, 'extension/media-core.js'), 'utf8'), context);
const core = context.XVideoCore;
const clean = value => JSON.parse(JSON.stringify(value));
const id = '1234567890123456789';
const video = (size, bitrate = 0) => ({url: `https://video.twimg.com/ext_tw_video/123/pu/vid/${size}/sample.mp4?tag=12`, bitrate});
test('display actual file size and estimate 128 kbps MP3 size only when duration is known', () => {
  assert.equal(core.sizeText(1459093), '1.39 MB');
  assert.equal(core.sizeText(null), '大小未知');
  assert.equal(core.audioSize(60000), '约 0.92 MB');
  assert.equal(core.audioSize(0), '大小未知');
});

test('accept X/Twitter links and strip tracking; reject lookalike hosts and malformed IDs', () => {
  for (const url of [`https://x.com/sample_user/status/${id}?s=20`, `https://twitter.com/a/status/${id}/video/1`, `https://x.com/i/web/status/${id}`]) assert.equal(core.postId(url), id);
  for (const url of [`https://x.com.evil.test/a/status/${id}`, `https://x.com@evil.test/a/status/${id}`, `http://x.com/a/status/${id}`, `https://x.com/a/status/${id}oops`, `https://x.com/a/status/NaN`, 'javascript:alert(1)']) assert.equal(core.postId(url), null);
});
test('reject arbitrary downloads, credentials, ports, playlists and path traversal', () => {
  for (const url of ['https://evil.test/v.mp4', 'https://video.twimg.com.evil.test/v.mp4', 'https://user:pass@video.twimg.com/a.mp4', 'http://video.twimg.com/v.mp4', 'https://video.twimg.com:8080/v.mp4', 'https://video.twimg.com/a.m3u8', 'https://video.twimg.com/v.mp4#fragment', 'file:///C:/secret.mp4']) assert.equal(core.mp4Url(url), null);
  assert.throws(() => core.filename('../../bad', 0, video('720x1280')));
  assert.throws(() => core.filename(id, -1, video('720x1280')));
});
test('choose highest resolution independent of response order; deduplicate; exclude HLS', () => {
  const list = core.variants([video('320x568', 632000), {url: 'https://video.twimg.com/a.m3u8'}, video('720x1280', 2176000), video('480x852', 950000), video('720x1280', 2176000)]);
  assert.deepEqual(clean(list.map(v => v.width)), [720, 480, 320]);
  assert.equal(core.filename(id, 0, list[0]), `X_Videos/X_${id}_1_720x1280.mp4`);
});
test('GraphQL wrappers and quoted posts keep their own IDs and videos', () => {
  const main = {rest_id: id, legacy: {extended_entities: {media: [{id_str: '10', type: 'video', video_info: {variants: [video('720x1280')]}}]}}, quoted_status_result: {result: {rest_id: '9876543210123456789', legacy: {extended_entities: {media: [{id_str: '11', type: 'video', video_info: {variants: [video('480x852')]}}]}}}}};
  const result = core.extractPosts({data: {tweetResult: {result: {__typename: 'TweetWithVisibilityResults', tweet: main}}}});
  assert.equal(result.length, 2);
  assert.equal(result.find(p => p.postId === id).media[0].variants[0].width, 720);
  assert.equal(result.find(p => p.postId === '9876543210123456789').media[0].variants[0].width, 480);
});
test('multi-video and HLS-only media retain order and unsupported entries', () => {
  const data = {id_str: id, mediaDetails: [{type: 'photo'}, {id_str: '1', type: 'video', video_info: {variants: [{url: 'https://video.twimg.com/a.m3u8'}]}}, {id_str: '2', type: 'animated_gif', video_info: {variants: [video('480x852')]}}]};
  const [post] = core.extractPosts(data);
  assert.deepEqual(clean(post.media.map(m => m.id)), ['1', '2']);
  assert.equal(post.media[0].variants.length, 0);
  assert.equal(post.media[1].variants.length, 1);
});
test('synthetic tweet response resolves to the correct ID and 720×1280 MP4', () => {
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/public-post.json'), 'utf8'));
  const [post] = core.extractPosts(sample);
  assert.equal(post.postId, id);
  assert.equal(post.media.length, 1);
  assert.equal(post.media[0].variants.length, 3);
  assert.equal(post.media[0].variants[0].width, 720);
  assert.equal(post.media[0].variants[0].height, 1280);
});
test('malformed bridge input is filtered and cyclic data cannot hang extraction', () => {
  assert.equal(core.cleanPost({postId: 'bad', media: []}), null);
  const safe = core.cleanPost({postId: id, media: [{poster: 'https://evil.test/track', variants: [{url: 'https://evil.test/v.mp4'}]}]});
  assert.equal(safe.media[0].poster, ''); assert.equal(safe.media[0].variants.length, 0);
  const cycle = {}; cycle.self = cycle; assert.deepEqual(clean(core.extractPosts(cycle)), []);
});

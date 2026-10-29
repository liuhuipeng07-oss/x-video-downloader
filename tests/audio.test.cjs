const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {Worker} = require('node:worker_threads');

function wav(seconds = 2) {
  const rate = 44100, count = rate * seconds, buffer = Buffer.alloc(44 + count * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 15000), 44 + i * 2);
  return buffer;
}
test('actual packaged LAME encoder creates decodable MP3 audio with duration and progress', {timeout: 30000}, async () => {
  const {convertToMp3} = await import('../audio-engine.mjs');
  const {BufferSource, Input, MP3} = await import('mediabunny');
  const progress = [];
  const buffer = await convertToMp3(new BufferSource(wav()), {onProgress: p => progress.push(p)});
  assert.ok(buffer.byteLength > 20000);
  const output = new Input({source: new BufferSource(buffer), formats: [MP3]});
  try { const audio = await output.getPrimaryAudioTrack(); assert.ok(audio); assert.equal(await audio.getCodecParameterString(), 'mp3'); const duration = await output.computeDuration(); assert.ok(duration >= 1.95 && duration < 2.2, String(duration)); } finally { output.dispose(); }
  assert.ok(progress.some(p => p > 0));
  const filename = path.join(__dirname, '../verification/encoder-tone.mp3'); fs.writeFileSync(filename, Buffer.from(buffer));
  const probe = cp.spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type:format=duration', '-of', 'json', filename], {encoding: 'utf8'});
  assert.equal(probe.status, 0, probe.stderr); const info = JSON.parse(probe.stdout);
  assert.equal(info.streams.length, 1); assert.equal(info.streams[0].codec_name, 'mp3');
  const decode = cp.spawnSync('ffmpeg', ['-v', 'error', '-i', filename, '-f', 'null', '-'], {encoding: 'utf8'});
  assert.equal(decode.status, 0, decode.stderr); assert.equal(decode.stderr, '');
});
test('a pre-cancelled conversion never emits a file', async () => {
  const {convertToMp3} = await import('../audio-engine.mjs'); const {BufferSource} = await import('mediabunny');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(convertToMp3(new BufferSource(wav()), {signal: controller.signal}), /已取消/);
});
test('the extracted packaged encoder worker initializes and encodes without blob scripts', {timeout: 15000}, async t => {
  const worker = new Worker(path.join(__dirname, '../extension/vendor/mp3-encoder.worker.js')); t.after(() => worker.terminate());
  let nextId = 0;
  function command(command) { return new Promise((resolve, reject) => { const id = nextId++; const handler = message => { if (message.id !== id) return; worker.off('message', handler); message.success ? resolve(message.data) : reject(message.error); }; worker.on('message', handler); worker.once('error', reject); worker.postMessage({id, command}); }); }
  await command({type: 'init', data: {numberOfChannels: 1, sampleRate: 44100, bitrate: 128000}});
  const pcm = new Int16Array(44100); for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(2 * Math.PI * 440 * i / 44100) * 15000;
  const encoded = await command({type: 'encode', data: {audioData: pcm.buffer, numberOfFrames: pcm.length}});
  const flushed = await command({type: 'flush'});
  assert.ok(encoded.encodedData.byteLength + flushed.flushedData.byteLength > 10000);
});

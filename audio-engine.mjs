import {Input, UrlSource, MP4, WAVE, Output, BufferTarget, Mp3OutputFormat, Conversion} from 'mediabunny';
import {registerMp3Encoder} from '@mediabunny/mp3-encoder';

registerMp3Encoder();

// Conversion is incremental: no full-length PCM buffer or decoded video frames are retained.
// The compressed MP3 output stays in memory until handed to Chrome's download manager.
export async function convertToMp3(source, {onProgress = () => {}, signal} = {}) {
  const input = new Input({source, formats: [MP4, WAVE]});
  let conversion;
  const abort = () => { input.dispose(); if (conversion) conversion.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    if (signal?.aborted) throw new Error('已取消转换');
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('这个视频没有音轨，无法导出 MP3');
    if (!(await track.canDecode())) throw new Error('当前 Chrome 不支持此音频编码，请更新浏览器后重试');
    const output = new Output({format: new Mp3OutputFormat(), target: new BufferTarget()});
    conversion = await Conversion.init({input, output, video: {discard: true}, audio: {codec: 'mp3', bitrate: 128000}, showWarnings: false});
    if (!conversion.isValid) throw new Error('此音轨暂时无法转换为 MP3');
    conversion.onProgress = progress => onProgress(Math.max(0, Math.min(1, progress)));
    await conversion.execute();
    if (!output.target.buffer?.byteLength) throw new Error('转换结果为空，请重试');
    return output.target.buffer;
  } finally {
    signal?.removeEventListener('abort', abort);
    input.dispose();
  }
}

export function convertUrlToMp3(url, options) {
  return convertToMp3(new UrlSource(url, {
    maxCacheSize: 16 * 1024 * 1024, parallelism: 1,
    requestInit: {credentials: 'omit', referrerPolicy: 'no-referrer'},
    getRetryDelay: () => null
  }), options);
}

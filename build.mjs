import fs from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const base = new URL('./', import.meta.url);
const encoderFile = new URL('node_modules/@mediabunny/mp3-encoder/dist/bundles/mediabunny-mp3-encoder.mjs', base);
const original = await fs.readFile(encoderFile, 'utf8');
// Extract the package's bundled worker into a real, packaged JS file. Chrome's
// extension CSP can then keep worker-src 'self' without permitting blob scripts.
const workerStart = original.indexOf('// packages/mp3-encoder/src/encode.worker.ts');
const workerEnd = original.indexOf('// packages/mp3-encoder/src/index.ts', workerStart);
if (workerStart < 0 || workerEnd < 0) throw new Error('Upstream MP3 worker layout changed');
let workerText;
vm.runInNewContext(original.slice(workerStart, workerEnd) + '\nWorker2();', {inlineWorker: text => { workerText = text; }});
if (!workerText || !workerText.includes('WebAssembly')) throw new Error('MP3 worker extraction failed');
await fs.mkdir(new URL('extension/vendor/', base), {recursive: true});
await fs.writeFile(new URL('extension/vendor/mp3-encoder.worker.js', base), workerText);
const inlineStart = original.indexOf('// inline-worker:__inline-worker');
const modified = original.slice(0, inlineStart)
  + 'async function inlineWorker(){ return new Worker(new URL("./vendor/mp3-encoder.worker.js", import.meta.url)); }\nfunction Worker2(){ return inlineWorker(); }\n'
  + original.slice(workerEnd);
await build({entryPoints: ['offscreen-source.mjs'], absWorkingDir: fileURLToPath(base), outfile: 'extension/offscreen.js', bundle: true, format: 'esm', platform: 'browser', target: 'chrome116', minify: true, legalComments: 'eof', plugins: [{name: 'packaged-mp3-worker', setup(build) {
  build.onLoad({filter: /mediabunny-mp3-encoder\.mjs$/}, args => ({contents: modified, loader: 'js', resolveDir: args.path.replace(/[/\\][^/\\]+$/, '')}));
}}]});
await fs.copyFile(new URL('node_modules/mediabunny/LICENSE', base), new URL('extension/vendor/mediabunny-LICENSE.txt', base));
await fs.copyFile(new URL('node_modules/@mediabunny/mp3-encoder/LICENSE', base), new URL('extension/vendor/mp3-encoder-LICENSE.txt', base));
await fs.writeFile(new URL('extension/vendor/NOTICE.txt', base), `Mediabunny and @mediabunny/mp3-encoder 1.63.0: MPL-2.0\nhttps://github.com/Vanilagy/mediabunny/tree/v1.63.0\nSources are available from the version-pinned npm packages and the above repository.\nMP3 encoding uses LAME 3.100, LGPL: https://lame.sourceforge.io/\nThe MP3 encoder is modified only to load its worker from a packaged file.\nSee build.mjs in the provided source project for the exact modification.\nNo runtime scripts are fetched from third-party servers.\n`);
console.log('Built MP4 + MP3 extension with packaged encoder worker.');

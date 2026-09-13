import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, cp, writeFile, open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = resolve(new URL('..', import.meta.url).pathname);
const vendor = join(root, 'native', 'vendor', 'kws');
const out = join(root, 'native', '.build', 'alfred-deps');
const cacheRoot = join(root, 'native', '.build', 'alfred-kws-cache');
const privacyCheck = join(vendor, 'privacy-check.cc');
const deps = {
  sherpa: {
    tag: 'v1.13.8',
    url: 'https://github.com/k2-fsa/sherpa-onnx/archive/refs/tags/v1.13.8.tar.gz',
    sha256: 'b0374cc56dbc186d442ae73d5de743bb092470b640c4c50ce7b029044c0c4fa8',
    dir: 'sherpa-onnx-1.13.8',
  },
  kaldi: {
    tag: 'v1.22.3',
    url: 'https://github.com/csukuangfj/kaldi-native-fbank/archive/refs/tags/v1.22.3.tar.gz',
    sha256: '9176cc66fc7ce1edf85cf355b06e320c57db6297df74277f575183468893cf61',
    dir: 'kaldi-native-fbank-1.22.3',
  },
  onnxLicense: {
    url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/LICENSE',
    sha256: '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c',
  },
};
const patches = [
  join(vendor, 'patches', 'kaldi-native-fbank-v1.22.3-raw-pcm-wipes.patch'),
  join(vendor, 'patches', 'sherpa-onnx-v1.13.8-alfred-kws-private.patch'),
];
const wrapper = [
  join(vendor, 'wrapper', 'alfred_kws_private.h'),
  join(vendor, 'wrapper', 'alfred_kws_private.c'),
];
const cmakeFlags = [
  '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0',
  '-DSHERPA_ONNX_ENABLE_C_API=ON',
  '-DSHERPA_ONNX_ENABLE_BINARY=OFF', '-DSHERPA_ONNX_BUILD_C_API_EXAMPLES=OFF',
  '-DSHERPA_ONNX_ENABLE_TESTS=OFF', '-DSHERPA_ONNX_ENABLE_PYTHON=OFF',
  '-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF', '-DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF',
  '-DSHERPA_ONNX_ENABLE_TTS=OFF', '-DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF',
  '-DSHERPA_ONNX_ENABLE_GPU=OFF', '-DSHERPA_ONNX_ENABLE_DIRECTML=OFF',
  '-DSHERPA_ONNX_ENABLE_RKNN=OFF', '-DSHERPA_ONNX_ENABLE_AXERA=OFF',
  '-DSHERPA_ONNX_ENABLE_AXCL=OFF', '-DSHERPA_ONNX_ENABLE_ASCEND_NPU=OFF',
  '-DSHERPA_ONNX_ENABLE_QNN=OFF', '-DSHERPA_ONNX_ENABLE_SPACEMIT=OFF',
  '-DSHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=OFF',
];

function run(cmd, args, opts = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`${cmd} exited ${code}`)));
  });
}
async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
async function download(url, path) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed ${url}: ${res.status}`);
  await mkdir(dirname(path), { recursive: true });
  await pipeline(res.body, createWriteStream(path));
}
async function ensureDownload(item, path) {
  try { if (await sha256(path) === item.sha256) return; } catch {}
  await download(item.url, path);
  const actual = await sha256(path);
  if (actual !== item.sha256) throw new Error(`${basename(path)} checksum ${actual}`);
}
async function fingerprint(arch) {
  const h = createHash('sha256');
  h.update(JSON.stringify({ deps, cmakeFlags, arch }));
  for (const file of [script, privacyCheck, ...patches, ...wrapper]) h.update(await readFile(file));
  return h.digest('hex').slice(0, 24);
}
async function copyDist(from) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(from, out, { recursive: true });
}
async function copyLicenses(dist, src, downloads) {
  await cp(join(src, deps.sherpa.dir, 'LICENSE'), join(dist, 'LICENSE.sherpa-onnx'));
  await cp(join(src, deps.kaldi.dir, 'LICENSE'), join(dist, 'LICENSE.kaldi-native-fbank'));
  const license = join(downloads, 'onnxruntime-LICENSE-v1.28.2');
  await ensureDownload(deps.onnxLicense, license);
  await cp(license, join(dist, 'LICENSE.onnxruntime'));
}

const host = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : null;
if (!host || process.platform !== 'darwin') throw new Error('Alfred KWS build requires macOS arm64 or x86_64.');
await mkdir(cacheRoot, { recursive: true });
const fp = await fingerprint(host);
const cache = join(cacheRoot, fp);
const cachedDist = join(cache, 'dist');
try {
  if ((await readFile(join(cachedDist, '.fingerprint'), 'utf8')).trim() === fp) {
    await copyDist(cachedDist);
    console.log(`Alfred KWS deps restored from cache ${fp}`);
    process.exit(0);
  }
} catch {}

const downloads = join(cacheRoot, 'downloads');
const src = join(cache, 'src');
const build = join(cache, 'build');
const dist = join(cache, 'dist');
const lockPath = join(cacheRoot, `${fp}.lock`);
let lock;
try {
  lock = await open(lockPath, 'wx');
  await lock.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
} catch {
  throw new Error(`Alfred KWS deps build already in progress for ${fp}; remove ${lockPath} only if no build is running.`);
}
try {
  await rm(cache, { recursive: true, force: true });
  await mkdir(src, { recursive: true });
  await ensureDownload(deps.sherpa, join(downloads, 'sherpa-onnx-v1.13.8.tar.gz'));
  await ensureDownload(deps.kaldi, join(downloads, 'kaldi-native-fbank-v1.22.3.tar.gz'));
  await run('tar', ['-xzf', join(downloads, 'sherpa-onnx-v1.13.8.tar.gz'), '-C', src]);
  await run('tar', ['-xzf', join(downloads, 'kaldi-native-fbank-v1.22.3.tar.gz'), '-C', src]);
  await run('patch', ['-d', join(src, deps.kaldi.dir), '-p1', '-i', patches[0]]);
  await run('patch', ['-d', join(src, deps.sherpa.dir), '-p1', '-i', patches[1]]);
  await run('cmake', [
    '-S', join(src, deps.sherpa.dir), '-B', build,
    `-DCMAKE_OSX_ARCHITECTURES=${host}`,
    `-DALFRED_KALDI_NATIVE_FBANK_SOURCE_DIR=${join(src, deps.kaldi.dir)}`,
    ...cmakeFlags,
  ]);
  await run('cmake', ['--build', build, '--target', 'sherpa-onnx-c-api', '--', '-j4']);
  await run('c++', [
    '-std=c++17', '-arch', host, '-mmacosx-version-min=13.0',
    '-I', join(src, deps.kaldi.dir), '-I', join(build, '_deps', 'kissfft-src'),
    privacyCheck,
    join(build, 'lib', 'libkaldi-native-fbank-core.a'),
    join(build, 'lib', 'libkissfft-float.a'),
    '-o', join(cache, 'privacy-check'),
  ]);
  await run(join(cache, 'privacy-check'), []);
  await mkdir(join(dist, 'include', 'sherpa-onnx', 'c-api'), { recursive: true });
  await mkdir(join(dist, 'lib'), { recursive: true });
  await run('cc', ['-arch', host, '-mmacosx-version-min=13.0', '-I', join(vendor, 'wrapper'), '-I', join(src, deps.sherpa.dir), '-c', wrapper[1], '-o', join(cache, 'alfred_kws_private.o')]);
  await run('libtool', ['-static', '-o', join(dist, 'lib', 'libalfred-kws-private.a'), join(cache, 'alfred_kws_private.o')]);
  await run('find', [join(build, 'lib'), '-maxdepth', '1', '-type', 'f', '-name', '*.a', '-exec', 'cp', '{}', join(dist, 'lib'), ';']);
  await cp(join(build, '_deps', 'onnxruntime-src', 'lib', 'libonnxruntime.a'), join(dist, 'lib', 'libonnxruntime.a'));
  await cp(wrapper[0], join(dist, 'include', 'alfred_kws_private.h'));
  await cp(join(src, deps.sherpa.dir, 'sherpa-onnx', 'c-api', 'c-api.h'), join(dist, 'include', 'sherpa-onnx', 'c-api', 'c-api.h'));
  await copyLicenses(dist, src, downloads);
  await writeFile(join(dist, '.fingerprint'), `${fp}\n`);
  await copyDist(dist);
  console.log(`Alfred KWS deps built ${fp} for ${host}`);
} finally {
  await lock?.close().catch(() => {});
  await rm(lockPath, { force: true }).catch(() => {});
}

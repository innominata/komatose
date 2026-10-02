import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, access, rename } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const root = await mkdtemp(join(tmpdir(), 'scan-image-edit-test-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');
process.env.SCAN_GPU_MODE = '';
// The test machines may have real GPUs; the fake sd-server speaks for the device
// side, so pin both editors to CPU for host-independent reason strings.
process.env.SCAN_IMAGE_DEVICE = 'cpu';

// The editor counts as installed once the marker, weight files, text encoder, and
// the sd-server executable are all present. Qwen2.5-VL lives beside the weights.
const editDir = join(root, 'models/image/qwen-image-edit-2511');
await mkdir(join(editDir, 'VAE'), { recursive: true });
process.env.SCAN_IMAGE_EDIT_MODEL_DIR = editDir;
await writeFile(join(editDir, 'qwen-image-edit-2511-Q4_K_M.gguf'), 'diffusion');
await writeFile(join(editDir, 'VAE', 'Qwen_Image-VAE.safetensors'), 'vae');
await writeFile(join(editDir, 'Qwen2.5-VL-7B-Instruct.Q5_K_M.gguf'), 'encoder');
await writeFile(join(editDir, 'Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf'), 'mmproj');
await writeFile(join(editDir, 'installed.json'), JSON.stringify({
  quant: 'q4_k_m',
  diffusion: { file: 'qwen-image-edit-2511-Q4_K_M.gguf' },
  vae: { file: join('VAE', 'Qwen_Image-VAE.safetensors') },
  textEncoder: { file: 'Qwen2.5-VL-7B-Instruct.Q5_K_M.gguf', vision: 'Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf' },
}));

const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
process.env.SCAN_IMAGE_PORT = String(port);
const probe2 = createServer();
await new Promise<void>((resolve) => probe2.listen(0, '127.0.0.1', resolve));
const editPort = (probe2.address() as { port: number }).port;
await new Promise<void>((resolve) => probe2.close(() => resolve()));
process.env.SCAN_IMAGE_EDIT_PORT = String(editPort);

const requestsPath = join(root, 'requests.jsonl');
const modePath = join(root, 'mode');
const fakeBin = join(root, 'sd-server');
await writeFile(modePath, 'success');
await writeFile(fakeBin, String.raw`#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const root = ${JSON.stringify(root)};
const mode = () => fs.readFileSync(root + '/mode', 'utf8');
const fill = fs.readFileSync(root + '/fill.png');
const wide = fs.readFileSync(root + '/wide.png');
const port = Number(process.argv[process.argv.indexOf('--listen-port') + 1]);
fs.writeFileSync(root + '/args-' + port + '.json', JSON.stringify(process.argv.slice(2)));
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'qwen-image-edit-2511' }] }));
    }
    const body = Buffer.concat(chunks);
    fs.appendFileSync(root + '/requests.jsonl', JSON.stringify({
      url: req.url,
      body: body.toString('latin1'),
      bytes: body.length,
    }) + '\n');
    const answer = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const current = mode();
    if (current === 'wait') return;
    if (current === 'http500') return answer(500, { error: 'no free device' });
    if (current === 'nopng') return answer(200, { data: [{ b64_json: '' }] });
    if (current === 'trailing') return answer(200, { data: [] });
    return answer(200, { data: [{ b64_json: (current === 'wide' ? wide : fill).toString('base64') }] });
  });
}).listen(port, '127.0.0.1');
`, { mode: 0o755 });
process.env.SCAN_IMAGE_SD_SERVER = fakeBin;

await sharp({ create: { width: 512, height: 512, channels: 3, background: '#c83219' } }).png().toFile(join(root, 'fill.png'));
await sharp({ create: { width: 512, height: 256, channels: 3, background: '#c83219' } }).png().toFile(join(root, 'wide.png'));

const { cleanWithQwenImage } = await import('../src/lib/server/qwenImageClean');
const { imageEditStatus, probeImageEditCleaning, stopAllImageEditServers } = await import('../src/lib/server/imageEdit');

const calls = async () =>
  (await readFile(requestsPath, 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { url: string; body: string; bytes: number });

/** Pulls an uploaded multipart part back out of the body the fake server recorded. */
function uploaded(body: string, filename: string) {
  const raw = Buffer.from(body, 'latin1');
  const at = raw.indexOf(Buffer.from(`filename="${filename}"`));
  assert.ok(at > 0, `no upload named ${filename}`);
  const start = raw.indexOf('\r\n\r\n', at) + 4;
  return raw.subarray(start, raw.indexOf('\r\n--', start));
}

async function fixture(name: string, width: number, height: number, pixels: [number, number][]) {
  const source = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) source.set([i % 251, (i * 3) % 253, (i * 7) % 255, 255], i * 4);
  const mask = Buffer.alloc(width * height);
  for (const [x, y] of pixels) mask[y * width + x] = 255;
  const opts = { path: join(root, `${name}.png`), mask: join(root, `${name}-mask.png`), out: join(root, `${name}-out.png`) };
  await sharp(source, { raw: { width, height, channels: 4 } }).png().toFile(opts.path);
  await sharp(mask, { raw: { width, height, channels: 1 } }).png().toFile(opts.mask);
  return opts;
}

test('cleaning replaces marked lettering and keeps native page dimensions', async () => {
  assert.deepEqual(await probeImageEditCleaning(), {
    available: true, reason: 'Starts Qwen-Image-Edit 2511 on CPU when cleaning runs',
  });
  const opts = await fixture('small', 96, 80, [[40, 30], [41, 30], [42, 31]]);
  const result = await cleanWithQwenImage(opts);
  assert.equal(result.method, 'qwen-image-edit');
  assert.equal(result.patches, 1);
  const output = await sharp(opts.out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const source = await sharp(opts.path).ensureAlpha().raw().toBuffer();
  assert.equal(output.info.width, 96);
  assert.equal(output.info.height, 80);
  assert.deepEqual(output.data.subarray((30 * 96 + 40) * 4, (30 * 96 + 40) * 4 + 4), Buffer.from([200, 50, 25, 255]));
  // The editor returns a flat fill for the whole crop. Only the mask, plus a 4px falloff, is kept.
  const at = (y: number, x: number) => (y * 96 + x) * 4;
  assert.deepEqual(output.data.subarray(at(25, 40), at(25, 40) + 4), source.subarray(at(25, 40), at(25, 40) + 4));
  assert.deepEqual(output.data.subarray(0, 4), source.subarray(0, 4));
  const feather = at(28, 40);
  const cover = Math.round(255 * (1 - 2 / 5)) / 255;
  const blended = Buffer.from([0, 0, 0, 255]);
  for (let c = 0; c < 3; c++) blended[c] = Math.round([200, 50, 25][c] * cover + source[feather + c] * (1 - cover));
  assert.deepEqual(output.data.subarray(feather, feather + 4), blended);

  const request = (await calls()).at(-1)!;
  assert.equal(request.url, '/v1/images/edits');
  assert.match(request.body, /Edit the attached comic panel/);
  // stable-diffusion.cpp feeds the mask to the sampler, not to the model, so the prompt
  // must not describe guide-image colours the model never sees.
  assert.doesNotMatch(request.body, /white marks|black is surrounding artwork/);
  assert.match(request.body, /<sd_cpp_extra_args>/);
  // A truncated schedule leaves the marked lettering behind, so full strength is required.
  assert.match(request.body, /"strength":1/);
  assert.match(request.body, /"sample_steps":20/);
  // stable-diffusion.cpp's JSON mirrors its C struct: a top-level cfg_scale is ignored and
  // text guidance has to arrive as sample_params.guidance.txt_cfg.
  assert.match(request.body, /"guidance":\{"txt_cfg":2\.5\}/);
  assert.doesNotMatch(request.body, /"cfg_scale"/);
  assert.match(request.body, /"flow_shift":3/);
  // No LoRA is configured in this fixture, so the request must not ask for one.
  assert.doesNotMatch(request.body, /"lora"/);
});

test('letterer notes are forwarded without replacing the repaint instructions', async () => {
  const opts = await fixture('notes', 32, 32, [[8, 8]]);
  const count = (await calls()).length;
  await cleanWithQwenImage({
    ...opts,
    prompt: 'Rebuild the balloon tail behind the lettering. Keep the sleeve folds.',
  });
  assert.equal((await calls()).length, count + 1);
  const request = (await calls()).at(-1)!;
  assert.match(request.body, /Rebuild the balloon tail behind the lettering\. Keep the sleeve folds\./);
  // The client composes the draft; the server wraps it with the removal contract only.
  assert.match(request.body, /Erase the lettering and sound effects and rebuild the artwork they cover/);
  assert.doesNotMatch(request.body, /Additional direction from the letterer/);
});

test('style LoRAs are offered to the sampler and loaded from the editor LoRA directory', async () => {
  const opts = await fixture('lora', 40, 40, [[20, 20]]);
  const count = (await calls()).length;
  process.env.SCAN_IMAGE_LORAS = 'webtoon.safetensors:0.7, tidy.safetensors';
  try {
    await cleanWithQwenImage(opts);
  } finally {
    delete process.env.SCAN_IMAGE_LORAS;
  }
  const request = (await calls()).at(-1)!;
  const { imageEditLorasDir } = await import('../src/lib/server/gpuMode');
  const loraDir = imageEditLorasDir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(request.body, new RegExp(`"lora":\\[\\{"path":"${loraDir}/webtoon\\.safetensors","multiplier":0\\.7\\},\\{"path":"${loraDir}/tidy\\.safetensors","multiplier":1\\}\\]`));
  // The native API still resolves names from this directory. The edits route does not.
  const args = JSON.parse(await readFile(join(root, `args-${process.env.SCAN_IMAGE_EDIT_PORT}.json`), 'utf8')) as string[];
  const at = args.indexOf('--lora-model-dir');
  assert.ok(at > 0, 'the server is told where LoRAs live');
  assert.match(args[at + 1], /loras$/);
  // The fixture itself asks for no LoRA, so the previous request must have been clean.
  assert.equal(count, (await calls()).length - 1);
});

test('long pages are cropped without changing native dimensions or missing tile edges', async () => {
  const opts = await fixture('strip', 800, 1800, [[767, 767], [768, 768], [20, 1700]]);
  const count = (await calls()).length;
  const result = await cleanWithQwenImage(opts);
  assert.equal(result.patches, 2);
  const output = await sharp(opts.out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const source = await sharp(opts.path).ensureAlpha().raw().toBuffer();
  assert.equal(output.info.width, 800);
  assert.equal(output.info.height, 1800);
  assert.deepEqual(output.data.subarray((767 * 800 + 767) * 4, (767 * 800 + 767) * 4 + 4), Buffer.from([200, 50, 25, 255]));
  assert.deepEqual(output.data.subarray((1700 * 800 + 20) * 4, (1700 * 800 + 20) * 4 + 4), Buffer.from([200, 50, 25, 255]));
  // Artwork outside every crop keeps its original pixels, and so does artwork inside a
  // crop once it is past the mask falloff.
  assert.deepEqual(output.data.subarray(0, 4), Buffer.from([0, 0, 0, 255]));
  const inside = (600 * 800 + 600) * 4;
  assert.deepEqual(output.data.subarray(inside, inside + 4), source.subarray(inside, inside + 4));
  assert.equal((await calls()).length - count, 2);
  // Qwen-Image-2.1 blurs and drifts unless both crop sides are divisible by 32, and the
  // crop has to grow past the marked bounds so the model can continue the surrounding art.
  for (const [index, call] of (await calls()).slice(count).entries()) {
    const size = /name="size"\s*\r?\n\r?\n(\d+)x(\d+)/.exec(call.body);
    assert.ok(size, 'every edit request declares a size');
    const [width, height] = [Number(size![1]), Number(size![2])];
    assert.equal(width % 32, 0, `${width} must be divisible by 32`);
    assert.equal(height % 32, 0, `${height} must be divisible by 32`);
    assert.ok(width >= 512 && height >= 512, `${width}x${height} must keep a usable working size`);
    // The crop hangs off the page here, so its padding must repeat the edge pixels. White
    // padding used to make the model paint blank corners into the reconstruction.
    const crop = await sharp(uploaded(call.body, 'crop.png')).raw().toBuffer({ resolveWithObject: true });
    assert.equal(crop.info.width, width);
    assert.equal(crop.info.height, height);
    for (let i = 0; i < crop.data.length; i += crop.info.channels) {
      assert.notDeepEqual(
        Buffer.from(crop.data.subarray(i, i + 3)),
        Buffer.from([255, 255, 255]),
        `crop ${index} must not be padded with white`,
      );
    }
  }
});

test('empty, mismatched and cancelled masks never invoke the editor', async () => {
  const opts = await fixture('empty', 20, 20, []);
  const count = (await calls()).length;
  await assert.rejects(cleanWithQwenImage(opts), /mask is empty/);
  await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).png().toFile(opts.mask);
  await assert.rejects(cleanWithQwenImage(opts), /dimensions/);
  await assert.rejects(cleanWithQwenImage(opts, AbortSignal.abort()), /Error/);
  assert.equal((await calls()).length, count);
  await assert.rejects(access(opts.out));
});

test('editor errors and malformed results leave the previous output intact', async () => {
  const opts = await fixture('failure', 20, 20, [[10, 10]]);
  await writeFile(opts.out, 'previous cleaned artifact');
  for (const [mode, error] of [
    ['http500', /HTTP 500/],
    ['nopng', /returned no image/],
    ['trailing', /returned no image/],
    ['wide', /different image framing/],
  ] as const) {
    await writeFile(modePath, mode);
    await assert.rejects(cleanWithQwenImage(opts), error);
    assert.equal(await readFile(opts.out, 'utf8'), 'previous cleaned artifact');
  }
  await writeFile(modePath, 'success');
});

test('cancelling a running edit stops waiting and leaves no output', async () => {
  const opts = await fixture('cancel', 20, 20, [[10, 10]]);
  await writeFile(modePath, 'wait');
  const count = (await calls()).length;
  const controller = new AbortController();
  const task = assert.rejects(cleanWithQwenImage(opts, controller.signal), /Cancelled/);
  for (let i = 0; i < 100 && (await calls()).length === count; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await calls()).length, count + 1);
  controller.abort();
  await task;
  await assert.rejects(access(opts.out));
  await writeFile(modePath, 'success');
});

test('the editor loads its own weights, encoder and sampling defaults', async () => {
  assert.deepEqual(await probeImageEditCleaning('qwen-image-edit-2511'), {
    available: true, reason: 'Qwen-Image-Edit 2511 is resident on CPU',
  });
  const opts = await fixture('edit-2511', 64, 64, [[32, 32], [33, 32]]);
  const result = await cleanWithQwenImage({ ...opts, model: 'qwen-image-edit-2511' });
  assert.equal(result.method, 'qwen-image-edit');
  assert.equal(result.backend, 'Qwen-Image-Edit 2511 · stable-diffusion.cpp');

  const editStatus = imageEditStatus('qwen-image-edit-2511');
  assert.equal(editStatus.state, 'running');
  const args = JSON.parse(await readFile(join(root, `args-${editStatus.port}.json`), 'utf8')) as string[];
  assert.match(args[args.indexOf('--diffusion-model') + 1], /qwen-image-edit-2511-Q4_K_M\.gguf$/);
  assert.match(args[args.indexOf('--llm') + 1], /Qwen2\.5-VL-7B-Instruct\.Q5_K_M\.gguf$/);
  assert.ok(args.includes('qwen_image_zero_cond_t=true'), 'zero_cond_t is passed through');

  const request = (await calls()).at(-1)!;
  assert.match(request.body, /"guidance":\{"txt_cfg":2\.5\}/);
  assert.match(request.body, /"flow_shift":3/);
  assert.match(request.body, /"sample_method":"euler"/);
  assert.match(request.body, /"strength":1/);

  assert.equal(editStatus.id, 'qwen-image-edit-2511');
  assert.deepEqual(editStatus.models.map((row) => [row.id, row.installed, row.active]), [
    ['qwen-image-edit-2511', true, true],
    ['qwen-image-edit-2511-lightning', false, false],
  ]);
  assert.equal(editStatus.quant, 'q4_k_m');
});

test('Lightning is installed only when the 2511 weights and the LoRA are both present', async () => {
  const { IMAGE_EDIT_LIGHTNING_LORA } = await import('../src/lib/imageEdit');
  const { imageEditLorasDir } = await import('../src/lib/server/gpuMode');
  const { installTarget } = await import('../src/lib/installCatalog');
  const { targetInstalled } = await import('../src/lib/server/modelInstall');
  const loraDir = imageEditLorasDir();
  const lora = join(loraDir, IMAGE_EDIT_LIGHTNING_LORA);
  await mkdir(loraDir, { recursive: true });

  assert.equal(targetInstalled(installTarget('qwen-image-edit-2511-lightning')!).installed, false);
  assert.match(targetInstalled(installTarget('qwen-image-edit-2511-lightning')!).detail || '', /Lightning LoRA is not downloaded/);
  assert.deepEqual(await probeImageEditCleaning('qwen-image-edit-2511-lightning'), {
    available: false, reason: 'Qwen-Image-Edit 2511 Lightning is not installed',
  });

  await writeFile(lora, 'lora');
  try {
    const away = `${editDir}.away`;
    await rename(editDir, away);
    await mkdir(editDir);
    try {
      assert.equal(targetInstalled(installTarget('qwen-image-edit-2511-lightning')!).installed, false);
      assert.match(targetInstalled(installTarget('qwen-image-edit-2511-lightning')!).detail || '', /weights are not installed/);
      assert.deepEqual(await probeImageEditCleaning('qwen-image-edit-2511-lightning'), {
        available: false, reason: 'Qwen-Image-Edit 2511 Lightning is not installed',
      });
    } finally {
      await rm(editDir, { recursive: true, force: true });
      await rename(away, editDir);
    }
    assert.equal(targetInstalled(installTarget('qwen-image-edit-2511-lightning')!).installed, true);
  } finally {
    await rm(lora);
  }
});

test('a running 2511 server is reused for a Lightning clean', async () => {
  const { IMAGE_EDIT_LIGHTNING_LORA } = await import('../src/lib/imageEdit');
  const { imageEditLorasDir } = await import('../src/lib/server/gpuMode');
  const lora = join(imageEditLorasDir(), IMAGE_EDIT_LIGHTNING_LORA);
  await mkdir(imageEditLorasDir(), { recursive: true });
  await writeFile(lora, 'lora');
  try {
    const opts = await fixture('lightning', 64, 64, [[20, 20]]);
    const before = imageEditStatus('qwen-image-edit-2511');
    assert.equal(before.state, 'running');
    const result = await cleanWithQwenImage({ ...opts, model: 'qwen-image-edit-2511-lightning' });
    assert.equal(result.method, 'qwen-image-edit-lightning');
    const request = (await calls()).at(-1)!;
    assert.match(request.body, /"sample_steps":8/);
    assert.match(request.body, /"guidance":\{"txt_cfg":1\}/);
    assert.match(request.body, /"flow_shift":3/);
    assert.match(request.body, /"sample_method":"euler"/);
    assert.match(request.body, /"strength":1/);
    assert.match(request.body, new RegExp(`"path":"${lora.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));

    const lightning = imageEditStatus('qwen-image-edit-2511-lightning');
    const base = imageEditStatus('qwen-image-edit-2511');
    assert.equal(lightning.state, 'running');
    assert.equal(base.state, 'running');
    assert.equal(lightning.port, base.port);
    assert.deepEqual(lightning.models.map((row) => [row.id, row.installed, row.active]), [
      ['qwen-image-edit-2511', true, true],
      ['qwen-image-edit-2511-lightning', true, true],
    ]);

    process.env.SCAN_IMAGE_EDIT_LIGHTNING_CFG = '1.5';
    try {
      await cleanWithQwenImage({ ...opts, model: 'qwen-image-edit-2511-lightning' });
    } finally {
      delete process.env.SCAN_IMAGE_EDIT_LIGHTNING_CFG;
    }
    assert.match((await calls()).at(-1)!.body, /"txt_cfg":1\.5/);

    await cleanWithQwenImage({ ...opts, model: 'qwen-image-edit-2511' });
    const baseRequest = (await calls()).at(-1)!;
    assert.match(baseRequest.body, /"sample_steps":20/);
    assert.match(baseRequest.body, /"guidance":\{"txt_cfg":2\.5\}/);
    assert.doesNotMatch(baseRequest.body, /"lora"/);
  } finally {
    await rm(lora, { force: true });
  }
});

test('disabling one editor removes only that id from the clean method list', async () => {
  const { listRegistryRows, saveProbeResult, updateRegistryRow } = await import('../src/lib/server/modelRegistryStore');
  const { imageWorkflowChoices } = await import('../src/lib/server/modelImageWorkflow');
  const ids = ['qwen-image-edit-2511', 'qwen-image-edit-2511-lightning'] as const;
  for (const id of ids) {
    const row = listRegistryRows(true).find((item) => item.id === id);
    assert.ok(row?.taskFingerprints?.cleaning, `${id} has no cleaning fingerprint`);
    saveProbeResult(id, {
      operation: 'cleaning',
      ok: true,
      at: Date.now(),
      fingerprint: row.taskFingerprints.cleaning,
    });
  }
  const offered = () => imageWorkflowChoices()
    .map((row) => row.id)
    .filter((id) => (ids as readonly string[]).includes(id));
  assert.deepEqual(offered().sort(), [...ids].sort());
  updateRegistryRow('qwen-image-edit-2511-lightning', { disabled: true });
  assert.deepEqual(offered(), ['qwen-image-edit-2511']);
  updateRegistryRow('qwen-image-edit-2511', { disabled: true });
  updateRegistryRow('qwen-image-edit-2511-lightning', { disabled: false });
  assert.deepEqual(offered(), ['qwen-image-edit-2511-lightning']);
});

test('an editor with no weights installed is reported as unavailable', async () => {
  // A missing text encoder is enough: the installer is what makes the pair usable.
  const encoder = join(editDir, 'Qwen2.5-VL-7B-Instruct.Q5_K_M.gguf');
  const saved = await readFile(encoder);
  await rm(encoder);
  try {
    assert.deepEqual(await probeImageEditCleaning('qwen-image-edit-2511'), {
      available: false, reason: 'Qwen-Image-Edit 2511 is not installed',
    });
    const opts = await fixture('missing-2511', 32, 32, [[16, 16]]);
    await assert.rejects(
      cleanWithQwenImage({ ...opts, model: 'qwen-image-edit-2511' }),
      /Qwen-Image-Edit 2511 is not installed/,
    );
  } finally {
    await writeFile(encoder, saved);
  }
});

after(async () => {
  await stopAllImageEditServers().catch(() => {});
  await rm(root, { recursive: true, force: true });
});
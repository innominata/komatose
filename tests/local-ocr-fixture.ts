import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Explicit test evidence only; never write to an application's data directory. */
export async function fixturePasses(id: string, operations: import('../src/lib/modelTasks').ModelTaskId[]) {
  if (!process.env.SCAN_ROOT?.startsWith(tmpdir() + '/')) throw new Error('Fixture evidence requires an isolated temporary SCAN_ROOT');
  const { saveProbeResult, saveCapabilityResults, findRegistryRow } = await import('../src/lib/server/modelRegistryStore');
  const { CAPABILITY_REQUIREMENTS } = await import('../src/lib/modelCapabilities');
  const row = findRegistryRow(id)!;
  for (const operation of operations) {
    const required = row.qualificationAdapter !== 'direct' ? CAPABILITY_REQUIREMENTS[operation] : undefined;
    if (required) saveCapabilityResults(id, required.map(capability => ({ capability, fingerprint: row.capabilityFingerprints?.[capability], ok: true, outcome: 'passed', at: Date.now() })));
    else saveProbeResult(id, { operation, ok: true, outcome: 'passed', at: Date.now() });
  }
}

/** Stand-in for CTD: keep the centre of each region, with no installed model dependency. */
export async function localMaskFixture() {
  const root = await mkdtemp(join(tmpdir(), 'scan-mask-fixture-'));
  const worker = join(root, 'worker.py'), log = join(root, 'calls.jsonl');
  await writeFile(worker, `#!/usr/bin/python3
import sys,json,struct,zlib
def chunk(kind,data):
    return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
for line in sys.stdin:
    msg=json.loads(line)
    assert msg['cmd']=='mask' and msg['detect']
    with open(${JSON.stringify(log)},'a') as f: f.write(json.dumps(msg)+'\\n')
    with open(msg['path'],'rb') as f: width,height=struct.unpack('>II',f.read(24)[16:24])
    pixels=bytearray(width*height)
    for poly in msg['regions']:
        x0,x1=min(p['x'] for p in poly)*width,max(p['x'] for p in poly)*width
        y0,y1=min(p['y'] for p in poly)*height,max(p['y'] for p in poly)*height
        for y in range(max(0,int(y0+(y1-y0)*.2)),min(height,int(y1-(y1-y0)*.2))):
            for x in range(max(0,int(x0+(x1-x0)*.2)),min(width,int(x1-(x1-x0)*.2))): pixels[y*width+x]=255
    rows=b''.join(b'\\0'+pixels[y*width:(y+1)*width] for y in range(height))
    png=b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,0,0,0,0))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b'')
    with open(msg['out'],'wb') as f: f.write(png)
    print(json.dumps({'ok':True,'pixels':pixels.count(255)}),flush=True)
`, { mode: 0o755 });
  const oldPython = process.env.SCAN_WORKFLOW_PYTHON, oldGpu = process.env.SCAN_GPU_MODE;
  process.env.SCAN_WORKFLOW_PYTHON = worker;
  process.env.SCAN_GPU_MODE = 'cpu';
  await fixturePasses('koharu', ['textMask']);
  return {
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    restore() {
      if (oldPython === undefined) delete process.env.SCAN_WORKFLOW_PYTHON;
      else process.env.SCAN_WORKFLOW_PYTHON = oldPython;
      if (oldGpu === undefined) delete process.env.SCAN_GPU_MODE;
      else process.env.SCAN_GPU_MODE = oldGpu;
    },
  };
}

/** Supply inert workers; tests intercept their HTTP calls and never load model weights. */
export async function localOcrFixture() {
  const mask = await localMaskFixture();
  await import('../src/lib/server/localReview');
  const root = await mkdtemp(join(tmpdir(), 'scan-ocr-fixture-'));
  const old = [process.env.SCAN_REVIEW_MODELS_DIR, process.env.SCAN_REVIEW_PYTHON, process.env.SCAN_REVIEW_LLAMA_SERVER];
  process.env.SCAN_REVIEW_MODELS_DIR = root;
  process.env.SCAN_REVIEW_PYTHON = process.execPath;
  process.env.SCAN_REVIEW_LLAMA_SERVER = process.execPath;
  const files = {
    'hayai-ocr-v2': ['model.safetensors', 'config.json', 'modeling_hayai.py', 'configuration_hayai.py', 'tokenizer.json'],
    'paddleocr-vl-1.6': ['PaddleOCR-VL-1.6-GGUF.gguf', 'PaddleOCR-VL-1.6-GGUF-mmproj.gguf', 'chat_template.jinja'],
    'qwen3-vl-8b': ['Qwen3-VL-8B-Instruct-Q8_0.gguf', 'mmproj-F16.gguf'],
  };
  const state = (globalThis as any).__scanLocalReview;
  for (const [id, names] of Object.entries(files)) {
    await mkdir(join(root, id));
    for (const name of names) await writeFile(join(root, id, name), 'fixture');
    state.services.set(id, { child: { exitCode: null, killed: false, kill() {} },
      url: `http://ocr.fixture/${id}`, token: 'fixture', ready: Promise.resolve() });
  }
  for (const id of Object.keys(files)) await fixturePasses(id, ['vision', 'sourceReview']);
  await writeFile(join(root, 'installed.json'), JSON.stringify(Object.fromEntries(Object.keys(files).map(id => [id, true]))));
  return () => {
    mask.restore();
    clearTimeout(state.idle);
    for (const id of Object.keys(files)) state.services.delete(id);
    ['SCAN_REVIEW_MODELS_DIR', 'SCAN_REVIEW_PYTHON', 'SCAN_REVIEW_LLAMA_SERVER'].forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i];
    });
  };
}

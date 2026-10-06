import { translationModel, translationRuntimeOf } from '../translationModels';
import { CAPABILITIES, CAPABILITY_VERSION } from '../modelCapabilities';
import { homedir } from 'node:os';
import { envVar } from './envFile';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ModelPackage, PackageCommand } from '../modelPackage';
import { MODEL_TASK_IDS, TASK_CONTRACT_VERSION, TASK_FIXTURE_VERSION } from '../modelTasks';
import type { ModelRow } from '../modelRegistry';

export type DiscoveredPackage = { manifest: ModelPackage; directory: string; fingerprint: string };
export type PackageDiscovery = { packages: DiscoveredPackage[]; errors: { path: string; id?: string; error: string }[] };
let snapshot: PackageDiscovery | undefined;
let snapshotRoot = '';
export const packageRoots = () => {
  const root = process.env.SCAN_ROOT || process.cwd();
  return [process.env.SCAN_BUNDLED_PACKAGES_DIR || join(process.cwd(), 'model-packages'), join(process.env.SCAN_DATA_DIR || join(root, 'data'), 'model-packages')];
};
export function packageFile(directory: string, path: string): string {
  const full = resolve(directory, path);
  if (isAbsolute(path) || relative(directory, full).startsWith('..')) throw new Error('Package files must stay inside the package directory');
  return full;
}
function command(value: unknown): value is PackageCommand {
  const v = value as PackageCommand;
  return !!v && typeof v.executable === 'string' && !!v.executable.trim() && !/[\0\r\n]/.test(v.executable)
    && (v.executableEnv == null || typeof v.executableEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.executableEnv))
    && (v.args == null || Array.isArray(v.args) && v.args.every(a => typeof a === 'string' && !a.includes('\0')))
    && (v.env == null || typeof v.env === 'object' && Object.values(v.env).every(a => typeof a === 'string'));
}
export function validatePackage(value: unknown): ModelPackage {
  const p = value as ModelPackage;
  if (!p || p.version !== 1 || !/^[a-z0-9][a-z0-9._-]*$/.test(p.id || '') || !p.name?.trim() || !p.revision?.trim()) throw new Error('Invalid model package identity/version');
  if (!p.adapter?.id || !['local_http', 'remote_http', 'cli', 'proofreader'].includes(p.access)) throw new Error('Invalid adapter/access');
  for (const key of ['operations', 'capabilities', 'supportedTasks', 'supportsImages']) {
    if (key in p || key in p.adapter) throw new Error(`Packages cannot declare ${key}; run task probes instead`);
  }
  if (p.adapter.command && !command(p.adapter.command)) throw new Error('Invalid adapter command');
  if (p.setup && !command(p.setup)) throw new Error('Invalid setup command');
  for (const [action, cmd] of Object.entries(p.lifecycle || {})) {
    if (!['install', 'installation-status', 'start', 'health', 'stop'].includes(action) || !command(cmd)) throw new Error('Invalid lifecycle command');
  }
  for (const list of [p.dependencies, p.artifacts, p.adapter.files, p.environment]) if (list != null && (!Array.isArray(list) || list.some(v => typeof v !== 'string'))) throw new Error('Invalid package file/dependency list');
  if (p.artifactDirectories && (!Array.isArray(p.artifactDirectories) || p.artifactDirectories.some(item => !item || typeof item.path !== 'string'))) throw new Error('Invalid artifact directory');
  if (p.service && (!p.service.id || p.service.concurrency != null && (!Number.isInteger(p.service.concurrency) || p.service.concurrency < 1))) throw new Error('Invalid service configuration');
  return p;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const fingerprint = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
export function discoverModelPackages(refresh = false): PackageDiscovery {
  const roots = packageRoots();
  const key = roots.join('\0');
  if (!refresh && snapshot && snapshotRoot === key) return snapshot;
  const result: PackageDiscovery = { packages: [], errors: [] };
  for (const root of roots) {
    const ids = new Set<string>();
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, entry.name);
      const path = join(directory, 'model.json');
      if (!existsSync(path)) continue;
      let candidateId = entry.name;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof parsed.id === 'string') candidateId = parsed.id;
        const manifest = validatePackage(parsed);
        if (ids.has(manifest.id)) throw new Error(`Duplicate model package: ${manifest.id}`);
        const files = new Map<string, string>();
        // Every package-local script/template participates, even if no explicit files list was supplied.
        const scan = (folder: string) => {
          for (const item of readdirSync(folder, { withFileTypes: true })) {
            if (['node_modules', '.venv', '__pycache__', '.git'].includes(item.name)) continue;
            const full = join(folder, item.name);
            if (item.isDirectory()) scan(full);
            else if (item.isFile() && item.name !== 'model.json' && /\.(?:js|mjs|cjs|ts|py|sh|json|jinja|txt)$/.test(item.name)) files.set(relative(directory, full), createHash('sha256').update(readFileSync(full)).digest('hex'));
          }
        };
        scan(directory);
        for (const file of manifest.adapter.files || []) files.set(file, createHash('sha256').update(readFileSync(packageFile(directory, file))).digest('hex'));
        const { name: _name, ...identity } = manifest;
        const replaced = result.packages.findIndex(pkg => pkg.manifest.id === manifest.id);
        if (replaced >= 0) result.packages.splice(replaced, 1);
        result.packages.push({ manifest, directory, fingerprint: fingerprint({ identity, files: [...files].sort() }) });
        ids.add(manifest.id);
      } catch (error) { result.errors.push({ path, id: candidateId, error: (error as Error).message }); }
    }
  }
  const services = new Map<string, DiscoveredPackage[]>();
  for (const pkg of result.packages) {
    const id = pkg.manifest.service?.id;
    if (!id) continue;
    services.set(id, [...(services.get(id) || []), pkg]);
  }
  for (const [serviceId, list] of services) {
    const first = list[0].manifest.service!;
    if (list.every(pkg => pkg.manifest.service!.concurrency === first.concurrency && pkg.manifest.service!.resource === first.resource)) continue;
    const error = `Shared service ${serviceId} must use the same concurrency and resource`;
    for (const pkg of list) {
      const index = result.packages.findIndex(item => item.manifest.id === pkg.manifest.id);
      if (index >= 0) result.packages.splice(index, 1);
      result.errors.push({ path: join(pkg.directory, 'model.json'), id: pkg.manifest.id, error });
    }
  }
  snapshotRoot = key;
  return snapshot = result;
}
export const modelPackageError = (id: string) => discoverModelPackages().errors.find(error => error.id === id)?.error;
export const modelPackage = (id: string) => discoverModelPackages().packages.find(p => p.manifest.id === id);

/** Task contract shared by every builtin model. A change here restales all of them. */
const SHARED_TASK_FILES = [
  'src/lib/modelCapabilities.ts', 'src/lib/server/modelQualification.ts', 'src/lib/modelTasks.ts', 'src/lib/server/modelAdapters.ts', 'src/lib/server/modelProbe.ts',
  'src/lib/server/modelTaskCatalog.ts', 'src/lib/server/modelTaskRunner.ts',
];
/** Implementation files for one builtin adapter. A change restales only that adapter's models. */
const ADAPTER_SOURCE_FILES: Record<string, string[]> = {
  'native-ocr': ['src/lib/server/localReview.ts', 'ocr/hayai_review.py', 'ocr/manga_ocr_review.py'],
  'native-translator': ['src/lib/server/specialistTranslation.ts', 'src/lib/server/translationRuntime.ts', 'src/lib/translationModels.json',
    'ocr/ko_en_translate.py', 'ocr/opus_mt_translate.py', 'ocr/sugoi_translate.py', 'ocr/translategemma-ja-en.jinja'],
  'workflow-image': ['src/lib/server/modelImageAdapters.ts', 'src/lib/server/localWorker.ts', 'src/lib/server/detect.ts',
    'ocr/workflow.py', 'ocr/worker.py', 'ocr/koharu_mask.py', 'ocr/lettering.py', 'ocr/coo.py'],
  'native-detector': ['src/lib/server/modelImageAdapters.ts', 'src/lib/server/localWorker.ts', 'src/lib/server/ocr.ts', 'ocr/worker.py', 'ocr/detect.py', 'ocr/native_detect.py', 'ocr/lettering.py', 'ocr/workflow.py'],
  'image-editor': ['src/lib/server/modelImageAdapters.ts', 'src/lib/server/qwenImageClean.ts', 'src/lib/server/imageEdit.ts'],
  'browser-proofreader': ['src/lib/server/proofreadService.ts'],
  cli: ['src/lib/server/cliTranslate.ts', 'src/lib/server/cliDiscovery.ts', 'src/lib/server/cliAdapters/registry.ts', 'src/lib/server/cliAdapters/types.ts', 'src/lib/server/cliAdapters/command.ts'],
  openai: ['src/lib/server/llm.ts', 'src/lib/server/openaiHttp.ts', 'src/lib/server/ocrReview.ts', 'src/lib/server/managedModels.ts'],
  'local-chat': ['src/lib/server/llm.ts', 'src/lib/server/openaiHttp.ts', 'src/lib/server/ocrReview.ts', 'src/lib/server/managedModels.ts', 'src/lib/server/localReview.ts'],
};
function pythonRuntimeFingerprint(adapter: string | undefined, row: ModelRow) {
  const workflow = adapter === 'workflow-image' || adapter === 'native-detector';
  const translator = translationModel(row.id);
  const review = adapter === 'native-ocr' && ['hayai-ocr-v2', 'manga-ocr'].includes(row.id)
    || adapter === 'native-translator' && translator && translationRuntimeOf(translator) === 'pytorch';
  if (!workflow && !review) return undefined;
  const python = envVar(workflow ? 'SCAN_WORKFLOW_PYTHON' : 'SCAN_REVIEW_PYTHON') || (adapter === 'native-translator' ? envVar('SCAN_TRANSLATION_PYTHON') : undefined);
  const environment = python ? resolve(python, '../..') : resolve(process.env.SCAN_ROOT || process.cwd(), workflow ? '.venv-workflow' : '.venv-review');
  try { return fingerprint(JSON.parse(readFileSync(join(environment, '.komatose-runtime.json'), 'utf8'))); }
  catch { return 'legacy'; }
}
export function adapterSourceFiles(adapterId: string, cliAdapter?: string): string[] {
  const own = ADAPTER_SOURCE_FILES[adapterId] || [];
  const cliFile = adapterId === 'cli' && cliAdapter ? [`src/lib/server/cliAdapters/${cliAdapter}.ts`] : [];
  const codex = adapterId === 'cli' && cliAdapter === 'codex'
    ? ['src/lib/server/codexClean.ts', 'src/lib/server/codexCleanPrompt.ts', 'src/lib/server/modelImageAdapters.ts'] : [];
  return [...SHARED_TASK_FILES, ...own, ...cliFile, ...codex];
}
function builtinAdapterId(row: ModelRow, pkg?: DiscoveredPackage): string | undefined {
  if (pkg?.manifest.adapter.command) return undefined;
  return pkg?.manifest.adapter.id || (row.access === 'cli' ? 'cli' : row.access === 'proofreader' ? 'browser-proofreader' : 'openai');
}
const codeFingerprints = new Map<string, { signature: string; hash: string }>();
function codeFingerprint(relativePaths: string[]): string {
  const root = process.cwd();
  const files = [...new Set(relativePaths)].map(path => join(root, path)).filter(existsSync).sort();
  const key = files.join('|');
  const signature = files.map(path => `${path}:${statSync(path).mtimeMs}:${statSync(path).size}`).join('|');
  const cached = codeFingerprints.get(key);
  if (cached?.signature === signature) return cached.hash;
  const hash = fingerprint(files.map(path => createHash('sha256').update(readFileSync(path)).digest('hex')));
  codeFingerprints.set(key, { signature, hash });
  return hash;
}
export function rowTaskFingerprints(row: ModelRow): Record<string, string> {
  const pkg = modelPackage(row.id);
  const artifacts = pkg?.manifest.artifacts?.map(file => {
    file = file.replaceAll("{root}", process.env.SCAN_ROOT || process.cwd());
    const path = file.startsWith('/') ? file : resolve(pkg.directory, file);
    try { const s = statSync(path); return [path, s.size, s.mtimeMs]; } catch { return [path, 'missing']; }
  });
  const weights = [row.managedLaunch?.modelPath, row.managedLaunch?.projectorPath, row.managedLaunch?.templatePath].filter(Boolean).map(path => {
    try { const s = statSync(path!); return [path, s.size, s.mtimeMs]; } catch { return [path, 'missing']; }
  });
  const directoryArtifacts: unknown[] = [];
  const installationRoot = process.env.SCAN_DATA_DIR || join(process.env.SCAN_ROOT || process.cwd(), 'data');
  try {
    const receipt = JSON.parse(readFileSync(join(installationRoot, 'models/package-installations', `${row.id}.json`), 'utf8'));
    for (const path of receipt.artifacts || []) {
      try { const stat = statSync(path); directoryArtifacts.push([path, stat.size, stat.mtimeMs]); }
      catch { directoryArtifacts.push([path, 'missing']); }
    }
  } catch { /* Packages without receipts use declared artifacts. */ }

  for (const directory of pkg?.manifest.artifactDirectories || []) {
    const base = directory.rootEnv && envVar(directory.rootEnv) || directory.path;
    const path = resolve(pkg!.directory, base.replaceAll('{root}', process.env.SCAN_ROOT || process.cwd()).replaceAll('{home}', homedir()), directory.subdirectory || '');
    const visit = (path: string, depth = 0) => {
      try {
        const stat = statSync(path);
        if (stat.isDirectory() && depth < 6) for (const name of readdirSync(path).sort()) visit(join(path, name), depth + 1);
        else directoryArtifacts.push([path, stat.size, stat.mtimeMs]);
      } catch { directoryArtifacts.push([path, 'missing']); }
    };
    visit(path);
  }
  const adapterId = builtinAdapterId(row, pkg);
  const config = { pythonRuntime: pythonRuntimeFingerprint(adapterId, row), directoryArtifacts, weights, slug: row.slug, runtime: row.runtime, access: row.access, cliAdapter: row.cliAdapter,
    http: row.http, launch: row.managedLaunch, preset: row.requestPreset || "generic", revision: row.modelRevision,
    environment: Object.fromEntries((pkg?.manifest.environment || []).map(name => [name, envVar(name)])),
    inheritedEndpoint: row.access === 'local_http' && !row.http?.baseUrl && !row.managedLaunch ? envVar('LLAMASWAP_URL') || 'http://127.0.0.1:8081/v1' : undefined,
    dependencies: pkg?.manifest.dependencies?.map(id => [id, modelPackage(id)?.fingerprint, modelPackageError(id)]),
    package: pkg?.fingerprint, packageError: modelPackageError(row.id), artifacts,
    adapterVersion: adapterId ? codeFingerprint(adapterSourceFiles(adapterId, row.cliAdapter)) : undefined };
  return Object.fromEntries(MODEL_TASK_IDS.map(task => [task, fingerprint({ config, task, contract: TASK_CONTRACT_VERSION, fixture: TASK_FIXTURE_VERSION })]));
}

export function packageRows(existing: ModelRow[]): ModelRow[] {
  const rows = new Map(existing.map(row => [row.id, row]));
  for (const { manifest: p } of discoverModelPackages().packages) {
    if (p.kind === "runtime") continue;
    const old = rows.get(p.id);
    rows.set(p.id, { ...old, id: p.id, name: old?.name || p.name, slug: p.model || old?.slug || p.id,
      access: p.access, operations: [...MODEL_TASK_IDS], roles: old?.roles || ['admin','translator','proofreader','typesetter'],
      seeded: old?.seeded ?? false, operationsLocked: false, packageId: p.id,
      managedLaunch: old && 'managedLaunch' in old ? old.managedLaunch : p.config?.launch as ModelRow['managedLaunch'],
      http: old?.http ?? (typeof p.config?.baseUrl === 'string' ? { baseUrl: p.config.baseUrl, apiKeyEnv: String(p.config.apiKeyEnv || '') } : undefined),
    });
  }
  return [...rows.values()].map(row => {
    const pkg = modelPackage(row.id);
    const adapter = builtinAdapterId(row, pkg);
    const general = ['openai', 'local-chat', 'cli'].includes(adapter || '');
    const qualificationAdapter = general ? 'general' : adapter === 'native-ocr' ? 'ocr' : adapter === 'native-translator' ? 'translator' : 'direct';
    const backend = String(pkg?.manifest.config?.backend || row.id);
    const implementedTasks = general ? MODEL_TASK_IDS.filter(task => !['textMask', 'segmentBubble', 'inpaint', 'cleaning'].includes(task)
      && (adapter !== 'cli' || task !== 'detect')).concat(adapter === 'cli' && (row.cliAdapter || pkg?.manifest.config?.provider) === 'codex' ? ['cleaning'] : [])
      : adapter === 'native-ocr' ? ['vision', 'sourceReview'] as const
      : adapter === 'native-translator' ? ['translate'] as const
      : adapter === 'browser-proofreader' ? ['pageImageProofread'] as const
      : adapter === 'image-editor' ? ['cleaning'] as const
      : adapter === 'native-detector' ? (backend === 'ctd' ? ['detect', 'textMask'] as const : ['detect'] as const)
      : adapter === 'workflow-image' ? (backend === 'sam' ? ['segmentBubble'] as const : backend === 'koharu' ? ['detect', 'textMask'] as const : backend === 'coo' ? ['detect'] as const : ['inpaint'] as const)
      : MODEL_TASK_IDS;
    const taskFingerprints = rowTaskFingerprints(row);
    const capabilityFingerprints = Object.fromEntries(CAPABILITIES.map(({ id }) => [id, fingerprint({
      tasks: taskFingerprints, capability: id, version: CAPABILITY_VERSION,
    })]));
    return { ...row, qualificationAdapter, implementedTasks: [...implementedTasks], taskFingerprints, capabilityFingerprints };
  });
}

import { envVar } from './envFile';
/** Compatibility implementations of lifecycle operations for bundled adapters. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DiscoveredPackage } from './modelPackages';
import { findRegistryRow } from './modelRegistryStore';
import { ModelTaskError } from '../modelTasks';

export function nativeInstallationStatus(id: string): { installed: boolean; detail?: string } {
  try {
    const root = process.env.SCAN_DATA_DIR || resolve(process.env.SCAN_ROOT || process.cwd(), 'data');
    const receipt = JSON.parse(readFileSync(resolve(root, 'models/package-installations', `${id}.json`), 'utf8'));
    const installed = Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0 && receipt.artifacts.every((path: string) => {
      const stat = statSync(path); return stat.isFile() && stat.size > 0;
    });
    return { installed, detail: installed ? undefined : 'Model artifacts are missing; reinstall this package' };
  } catch { return { installed: false, detail: 'Install this model package to verify its weights' }; }
}

export async function builtinPackageReadiness(pkg: DiscoveredPackage): Promise<{ available: boolean; reason?: string }> {
  const row = findRegistryRow(pkg.manifest.id);
  if (!row) return { available: false, reason: 'Model configuration missing' };
  const adapter = pkg.manifest.adapter.id;
  if (adapter === 'native-ocr' || adapter === 'local-chat') {
    const { installedLocalReviewModels } = await import('./localReview');
    return { available: installedLocalReviewModels().some(m => m.id === row.id), reason: 'Install this model package if its weights are missing' };
  }
  if (adapter === 'native-translator') {
    const { listTranslationModels } = await import('./translationRuntime');
    const status = listTranslationModels().find(m => m.id === row.id);
    return { available: status?.available === true, reason: status?.reason };
  }
  if (adapter === 'native-detector' || adapter === 'workflow-image' || adapter === 'image-editor') {
    const { installTarget } = await import('../installCatalog');
    const { targetInstalled } = await import('./modelInstall');
    const target = installTarget(row.id);
    const status = target ? targetInstalled(target) : nativeInstallationStatus(row.id);
    return { available: status.installed, reason: status.detail };
  }
  if (adapter === 'cli') {
    const { cliReadiness, isCliToolId } = await import('./cliDiscovery');
    const id = String(pkg.manifest.config?.provider || row.cliAdapter);
    if (isCliToolId(id)) return cliReadiness(id);
    return { available: false, reason: 'CLI adapter executable missing' };
  }
  if (adapter === 'browser-proofreader') {
    const { proofreaderStatus } = await import('./proofreadService');
    const status = await proofreaderStatus(row.id as any);
    return { available: status.ready, reason: status.reason };
  }
  const { probeModelConnection } = await import('./modelConnection');
  return probeModelConnection(row);
}

async function runSetup(pkg: DiscoveredPackage, signal?: AbortSignal, progress?: (s: string) => void) {
  const cmd = pkg.manifest.setup;
  if (!cmd) throw new ModelTaskError('unsupported', 'This package does not provide an installer');
  const root = process.env.SCAN_ROOT || process.cwd();
  const expand = (s: string) => s.replaceAll('{package}', pkg.directory).replaceAll('{root}', root);
  signal?.throwIfAborted();
  await new Promise<void>((done, reject) => {
    const child = spawn(expand((cmd.executableEnv && envVar(cmd.executableEnv)) || cmd.executable), (cmd.args || []).map(expand), {
      cwd: root, env: { ...process.env, ...cmd.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const cancel = () => {
      if (child.pid) try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {}
    };
    signal?.addEventListener('abort', cancel, { once: true });
    child.once('close', () => signal?.removeEventListener('abort', cancel));
    child.stdout.on('data', data => progress?.(data.toString()));
    child.stderr.on('data', data => progress?.(data.toString()));
    child.once('error', reject);
    child.once('close', code => signal?.aborted ? reject(new ModelTaskError('cancelled', 'Installation cancelled')) : code === 0 ? done() : reject(new Error(`Installer exited ${code}`)));
  });
}

export async function operateBuiltinPackage(pkg: DiscoveredPackage, action: string, signal?: AbortSignal, progress?: (s: string) => void): Promise<any> {
  if (action === 'install') {
    await runSetup(pkg, signal, progress);
    const status = await operateBuiltinPackage(pkg, 'installation-status', signal, progress);
    if (!status.installed) throw new ModelTaskError('error', status.reason || 'Installer finished, but installation checks did not pass');
    return status;
  }
  if (action === 'installation-status') {
    if (pkg.manifest.artifacts?.length) return { installed: pkg.manifest.artifacts.every(p => existsSync(resolve(pkg.directory, p.replaceAll("{root}", process.env.SCAN_ROOT || process.cwd())))) };
    const status = await builtinPackageReadiness(pkg); return { installed: status.available, reason: status.reason };
  }
  const row = findRegistryRow(pkg.manifest.id);
  if (!row) throw new Error('Model configuration missing');
  if (row.managedLaunch) {
    const { operateManagedModel, waitManagedOperation, managedModelStatus } = await import('./managedModels');
    if (action === 'health') return { ready: managedModelStatus(row).state === 'running' };
    operateManagedModel(row.id, action as 'start' | 'stop');
    await waitManagedOperation(row.id);
    return { ready: managedModelStatus(row).state === 'running' };
  }
  const adapter = pkg.manifest.adapter.id;
  if (adapter === 'native-ocr' || adapter === 'local-chat') {
    const { operateReviewServer, waitReviewOperation, listReviewServerStatuses } = await import('./localReview');
    if (action !== 'health') { operateReviewServer(row.id, action as 'start' | 'stop'); await waitReviewOperation(row.id); }
    return { ready: (await listReviewServerStatuses()).some(s => s.id === row.id && s.state === 'running') };
  }
  if (adapter === 'image-editor') {
    const { operateImageEditServer, waitImageEditOperation, imageEditStatus } = await import('./imageEdit');
    if (action !== 'health') { operateImageEditServer(action as 'start' | 'stop', row.id as any); await waitImageEditOperation(row.id as any); }
    return { ready: imageEditStatus(row.id as any).state === 'running' };
  }
  if (adapter === 'native-translator') {
    const runtime = await import('./translationRuntime');
    if (action === 'start') await runtime.startTranslationModel(row.slug, signal);
    if (action === 'stop') await runtime.stopTranslationRuntime();
    return { ready: action !== 'stop' && runtime.translationModelRunning(row.slug) };
  }
  if (adapter === 'workflow-image' || adapter === 'native-detector') {
    let running = false;
    if (adapter === 'workflow-image') {
      const runtime = await import('./localWorker');
      if (action === 'stop') runtime.restartWorkflowWorker();
      if (action === 'start') await runtime.startWorkflowWorker(signal);
      running = runtime.workflowWorkerRunning();
    } else {
      const runtime = await import('./ocr');
      if (action === 'stop') runtime.stopWorker();
      if (action === 'start') await runtime.startOcrWorker(signal);
      running = runtime.ocrWorkerRunning();
    }
    if (action === 'stop') return { ready: false };
    const installed = await builtinPackageReadiness(pkg);
    return { ready: running && installed.available, reason: installed.reason };
  }
  if (action === 'health') return { ready: (await builtinPackageReadiness(pkg)).available };
  throw new ModelTaskError('unsupported', 'This adapter uses an externally managed service');
}

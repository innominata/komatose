import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { DATA_DIR } from './paths';
import { envVar } from './envFile';
export const D1_REVISION = 'bb1e436ea78eb96a3f1acb6da865f70c2fbeb563';
export const DECIDER_COMMIT = '88dcc460d628698bb8305b98c200c34f1edfdc04';
export const D1_FILES = { 'd1-3B-Q8_0.gguf': 2874781280, 'mmproj-d1-3B-F16.gguf': 853993696 };
export const D1_SHA256: Record<string, string> = { 'd1-3B-Q8_0.gguf': '2f0942d5a5f64cf69c3356d2be439b71644b1f0eb3a580912a5a0179eeaba77d', 'mmproj-d1-3B-F16.gguf': '093be6e3437800b868bc24df13f1d6f6da877ad28dfa5a5da5db01e9e8df7128' };
export const deciderRuntimeDir = () => envVar('SCAN_DECIDER_RUNTIME_DIR') || join(DATA_DIR, 'runtimes/llama-decider');
export const deciderModelsDir = () => join(envVar('SCAN_DECIDER_MODELS_DIR') || join(DATA_DIR, 'models/deciders'), 'd1-3b');
export const deciderBinary = () => join(deciderRuntimeDir(), 'build/bin/llama-server');
export function deciderInstalled(id: string): { installed: boolean; detail?: string } {
  try {
    const dir = id === 'llama-decider' ? deciderRuntimeDir() : deciderModelsDir();
    const receipt = JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8'));
    const installed = id === 'llama-decider'
      ? receipt.commit === DECIDER_COMMIT && receipt.backend === 'vulkan' && typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256) && statSync(deciderBinary()).size > 0
      : receipt.revision === D1_REVISION && Object.entries(D1_FILES).every(([file, size]) =>
        receipt.files?.[file]?.bytes === size && receipt.files[file].sha256 === D1_SHA256[file] && statSync(join(dir, file)).size === size);
    return { installed, detail: installed ? undefined : 'Reinstall the decider package to verify its artifacts' };
  } catch { return { installed: false, detail: 'Install the decider package' }; }
}

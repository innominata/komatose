import { IMAGE_EDIT_MODELS } from "$lib/imageEdit";

export type CleanBackend = {
  models?: Array<{ id: string; label: string; tasks: string[] }>;
  bigLama?: boolean;
  sam?: boolean;
  codex?: { available?: boolean; reason?: string };
  /** One readiness entry per local artwork editor, keyed by clean-method id. */
  imageEdit?: Record<string, { available?: boolean; reason?: string }>;
  devices?: { name: string; backend: string }[];
};

/** Ordinary deterministic editor tools are independent of model eligibility. */
export const CLEAN_INPAINT_MODELS = [
  { id: 'auto', label: 'Auto · balloon fill, then selected inpainter', icon: 'bi-layers-fill', color: '#e8c36a' },
  { id: 'telea', label: 'OpenCV Telea', icon: 'bi-paint-bucket', color: '#6bcf7f' },
  { id: 'flat', label: 'Sampled flat fill', icon: 'bi-square-fill', color: '#8ea4c8' },
  { id: 'clone', label: 'Clone / patch', icon: 'bi-copy', color: '#b794f4' },
] as const;

export function cleanModelChoices(backend: CleanBackend | null | undefined) {
 const tools = CLEAN_INPAINT_MODELS.filter(m => ['flat', 'telea', 'clone', 'auto'].includes(m.id));
 return [...tools, ...(backend?.models || []).filter(m => m.tasks.includes('inpaint') || m.tasks.includes('cleaning')).map(m => ({ id: m.id, label: m.label, icon: 'bi-stars', color: '#b794f4' }))];
}
export function inpaintUnavailable(id: string, backend: CleanBackend | null | undefined) {
 if (['flat','telea','clone','auto'].includes(id)) return '';
 return backend?.models?.some(m => m.id === id && (m.tasks.includes('inpaint') || m.tasks.includes('cleaning'))) ? '' : 'Needs a current passing task test';
}

export function canStartClean(
  canClean: boolean,
  busy: boolean,
  hasMask: boolean,
  strokeCount: number,
  unavailable: string,
) {
  return Boolean(canClean && !busy && !unavailable && (hasMask || strokeCount > 0));
}

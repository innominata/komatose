import { validateTranscriptionChoice } from './decider';

/** Application task contracts. No model names or capability declarations belong here. */
export const MODEL_TASKS = [
  { id: 'sourceDecide', label: 'Decide Transcription', group: 'Transcription', description: 'Choose the exact visible reading from OCR candidates using the crop.' },
  { id: 'translate', label: 'Translate', group: 'Translation', description: 'Translate source text into English.' },
  { id: 'alternatives', label: 'Alternative Translations', group: 'Translation', description: 'Suggest other phrasings for a translation.' },
  { id: 'vision', label: 'Read Text / OCR', group: 'Transcription', description: 'Read the original text from a crop.' },
  { id: 'sourceReview', label: 'Review Transcription', group: 'Transcription', description: 'Return an independent transcription. English is supplied separately by the selected translator.' },
  { id: 'describe', label: 'Describe Page', group: 'Scene notes', description: 'Describe the visible scene on a page.' },
  { id: 'compactNotes', label: 'Summarize Scene Notes', group: 'Scene notes', description: 'Condense page captions into chapter context.' },
  { id: 'proofreadEnglish', label: 'Proofread English', group: 'Review', description: 'Correct existing English using the source and context.' },
  { id: 'chapterReview', label: 'Review Chapter', group: 'Review', description: 'Find chapter-wide issues and inconsistencies.' },
  { id: 'pageImageProofread', label: 'Proofread Page Images', group: 'Review', description: 'Compare source and typeset pages.' },
  { id: 'advisory', label: 'Enquire', group: 'Review', description: 'Answer an editor’s question.' },
  { id: 'detect', label: 'Detect Text', group: 'Images', description: 'Locate lettering regions on a page.' },
  { id: 'textMask', label: 'Mask Text', group: 'Images', description: 'Return a pixel mask of lettering.' },
  { id: 'segmentBubble', label: 'Segment Bubble', group: 'Images', description: 'Return the interior mask of a speech bubble.' },
  { id: 'inpaint', label: 'Inpaint', group: 'Images', description: 'Reconstruct the masked area of an image.' },
  { id: 'cleaning', label: 'Edit Image', group: 'Images', description: 'Edit a masked image using instructions.' },
] as const;

export type ModelTaskId = (typeof MODEL_TASKS)[number]['id'];
export const MODEL_TASK_IDS: ModelTaskId[] = MODEL_TASKS.map(task => task.id);
export const TASK_CONTRACT_VERSION = 2;
export const TASK_FIXTURE_VERSION = 2;
export const taskDefinition = (id: string) => MODEL_TASKS.find(task => task.id === id);
export const taskLabel = (id: string) => taskDefinition(id)?.label ?? id;
export type ProbeOutcome = 'passed' | 'failed_validation' | 'unsupported' | 'error' | 'cancelled';

export class ModelTaskError extends Error {
  constructor(public readonly outcome: Exclude<ProbeOutcome, 'passed'>, message: string) {
    super(message);
    this.name = 'ModelTaskError';
  }
}

/** These validate the production contract; fixture correctness is checked separately. */
export function validateTaskOutput(task: ModelTaskId, output: unknown, schema?: { required?: string[] }): void {
  const value = output as any;
  const text = (v: unknown) => typeof v === 'string' && Boolean(v.trim());
  const object = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
  let valid = false;
  switch (task) {
    case 'sourceDecide': try { validateTranscriptionChoice(output); valid = true; } catch { valid = false; } break;
    case 'translate': valid = Array.isArray(value) && value.length > 0 && value.every(v => object(v) && text(v.translation)); break;
    case 'vision': valid = object(value) && typeof value.source === 'string'; break;
    case 'sourceReview': valid = object(value) && ['readable', 'uncertain', 'unreadable', 'unassessed'].includes(value.status)
      && typeof value.source === 'string' && text(value.answer)
      && (value.status === 'unreadable' ? !value.source.trim() : text(value.source))
      && (value.translation == null || typeof value.translation === 'string'); break;
    case 'describe': valid = text(value); break;
    case 'compactNotes': valid = object(value) && typeof value.chapter === 'string' && Array.isArray(value.pages)
      && value.pages.every((v: any) => object(v) && Number.isInteger(v.i) && text(v.caption)); break;
    case 'chapterReview': valid = object(value) && text(value.summary) && Array.isArray(value.issues)
      && value.issues.every((v: any) => object(v) && text(v.text) && ['info', 'warn', 'error'].includes(v.severity))
      && Array.isArray(value.questions) && value.questions.every((v: any) => object(v) && text(v.text)) && typeof value.notes === 'string'; break;
    case 'alternatives': valid = Array.isArray(value) && value.every(v => object(v) && text(v.translation)); break;
    case 'proofreadEnglish': {
      const entries = value instanceof Map ? [...value.values()] : object(value) ? Object.values(value) : null;
      valid = entries !== null && entries.every((v: any) => object(v) && text(v.translation)); break;
    }
    case 'advisory': valid = schema?.required && !schema.required.includes('answer')
      ? object(value) && schema.required.every(key => value[key] !== undefined)
      : object(value) && text(value.answer) && Array.isArray(value.suggestions)
      && value.suggestions.every((v: any) => object(v) && ['source', 'body'].includes(v.target) && object(v) && text(v.text) && typeof v.reason === 'string'); break;
    case 'pageImageProofread': valid = object(value) && text(value.critique); break;
    case 'detect': valid = object(value) && Array.isArray(value.regions) && value.regions.every((v: any) =>
      object(v) && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(v[k])) && v.x >= 0 && v.y >= 0 && v.w > 0 && v.h > 0
      && v.x + v.w <= 1.001 && v.y + v.h <= 1.001
      && (!v.polygon || (Array.isArray(v.polygon) && v.polygon.length >= 3 && v.polygon.every((p: any) =>
        object(p) && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= 1.001 && p.y <= 1.001)))); break;
    default: valid = object(value) && (text(value.image) || text(value.mask));
  }
  if (!valid) throw new ModelTaskError('failed_validation', `${taskLabel(task)} returned an invalid or incomplete result`);
}

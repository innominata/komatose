import sharp from 'sharp';
import type { ModelRow } from '../modelRegistry';
import { MODEL_TASKS, ModelTaskError, validateTaskOutput, type ModelTaskId } from '../modelTasks';
import { SFX_PROBE_JPEG } from './fixtures/sfxProbe';
import { VISION_PROBE_JPEG } from './fixtures/visionProbe';
import { KOREAN_VISION_PROBE_PNG } from './fixtures/koreanVisionProbe';
import { executeModelTask } from './modelTaskRunner';
const visionProbeJpeg = async () => Buffer.from(VISION_PROBE_JPEG);
const sfxProbeJpeg = async () => Buffer.from(SFX_PROBE_JPEG);

export async function taskFixture(task: ModelTaskId): Promise<Record<string, any>> {
  const jpeg = await visionProbeJpeg();
  const common = { seriesNotes: '', seriesGlossary: '', prior: '', pages: 'p1', pageLabel: 'p1', lang: 'japanese',
    script: 'Complete chapter: 1 lines on 1 pages.\n[1] p1: テスト → Test.',
  };
  switch (task) {
    case 'sourceDecide': return { ...common, jpeg, candidates: [{ id: 'A', source: '待って' }, { id: 'B', source: '持って' }] };
    case 'translate': return { ...common, boxes: [{ x: 0, y: 0, w: 1, h: 1, source: 'テスト', lineType: '""', literal: '', translation: '', reasoning: '' }], requireTranslation: true };
    case 'vision': case 'describe': case 'detect': return { ...common, jpeg };
    case 'sourceReview': {
      const { SOURCE_REVIEW_SCHEMA, SOURCE_REVIEW_SYSTEM } = await import('./regionAi');
      return { ...common, jpeg, images: [jpeg], system: SOURCE_REVIEW_SYSTEM,
        prompt: 'Read this crop and return the original transcription and completed findings.', schema: SOURCE_REVIEW_SCHEMA };
    }
    case 'advisory': {
      const { ADVISORY_SCHEMA, ENQUIRY_SYSTEM } = await import('./regionAi');
      return { ...common, system: ENQUIRY_SYSTEM, prompt: 'What does テスト mean in English?', images: [], schema: ADVISORY_SCHEMA };
    }
    case 'pageImageProofread': {
      const { PAGE_PROOFREAD_SYSTEM, PAGE_PROOFREAD_SCHEMA } = await import('./pageProofread');
      const meta = await sharp(jpeg).metadata();
      const english = await sharp(Buffer.from(`<svg width="${meta.width}" height="${meta.height}"><rect width="100%" height="100%" fill="white"/><text x="10" y="40" font-size="28">Wait!</text></svg>`)).jpeg().toBuffer();
      return { ...common, system: PAGE_PROOFREAD_SYSTEM, prompt: 'Compare the raw source page with the English typeset page.', images: [jpeg, english], schema: PAGE_PROOFREAD_SCHEMA };
    }
    case 'chapterReview': return common;
    case 'compactNotes': return { ...common, rows: [{ i: 1, caption: 'Two friends meet outside a school. One waves to the other.' }] };
    case 'alternatives': return { ...common, source: '待って！', current: 'Wait!', fresh: 'Hold on!', lineType: '""', page: 'p1' };
    case 'proofreadEnglish': return { ...common, settled: '', items: [{ i: 1, page: 'p1', lineType: '""', source: 'これはテストです。', literal: '', current: 'Ths is a tset.', notes: '' }] };
    case 'segmentBubble': {
      const bubble = await sharp(Buffer.from('<svg width="256" height="256"><rect width="256" height="256" fill="#888"/><ellipse cx="128" cy="128" rx="90" ry="75" fill="white" stroke="black" stroke-width="4"/><text x="94" y="138" font-size="24">Hello!</text></svg>')).jpeg().toBuffer();
      return { ...common, jpeg: bubble, image: bubble, box: [.35, .43, .3, .15], kind: 'bubble',
        prompt: 'Return a mask of the white speech bubble interior containing the text.' };
    }
    default: {
      const { width = 128, height = 128 } = await sharp(jpeg).metadata();
      const mask = await sharp(Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/><rect x="${width / 4}" y="${height / 4}" width="${width / 2}" height="${height / 2}" fill="white"/></svg>`)).png().toBuffer();
      return { ...common, jpeg, image: jpeg, mask, box: [0, 0, 1, 1], prompt: 'Remove the lettering inside the mask and reconstruct the background.' };
    }
  }
}

export async function validateFixtureResult(task: ModelTaskId, value: any, input?: Record<string, any>) {
  const fail = (reason: string) => { throw new ModelTaskError('failed_validation', reason); };
  if (task === 'sourceDecide' && input && value.choice !== input.candidates.find((c: any) => c.source.includes('待って'))?.id) fail('The decider did not choose the visible fixture reading');
  if (task === 'vision' || task === 'sourceReview') {
    if (!String(value.source || '').replace(/\s/g, '').includes(input?.lang === 'korean' ? '기다려' : '待って')) fail('The reading does not match the text in the fixture');
  }
  if (task === 'translate' && !/test/i.test(value[0]?.translation || '')) fail('The fixture translation did not preserve its basic meaning');
  if (task === 'proofreadEnglish') {
    const hits: any[] = value instanceof Map ? [...value.values()] : Object.values(value);
    if (!hits.some(hit => /this/i.test(hit.translation) && /test/i.test(hit.translation))) fail('The fixture typos were not corrected');
  }
  if (task === 'alternatives' && !value.length) fail('No alternative was returned for the fixture');
  if (task === 'detect' && !value.regions.length) fail('No text region was detected in the fixture');
  if (task === 'textMask' || task === 'segmentBubble') {
    const mask = Buffer.from(String(value.mask || value.image).split(',')[1], 'base64');
    const { data } = await sharp(mask).greyscale().raw().toBuffer({ resolveWithObject: true });
    const selected = data.reduce((sum, pixel) => sum + (pixel > 127 ? 1 : 0), 0);
    if (!selected || selected >= data.length * .99) fail('The fixture needs a selective mask, not an empty or full image');
  }
  if ((task === 'inpaint' || task === 'cleaning') && input) {
    const image = Buffer.from(String(value.image).split(',')[1], 'base64');
    const original = await sharp(input.jpeg || input.image).removeAlpha().raw().toBuffer();
    const changed = await sharp(image).removeAlpha().raw().toBuffer();
    if (original.equals(changed)) fail('The fixture image was returned without any edit');
  }
}

/** Server contracts extend the same ordered catalog rendered by the client. */
export const MODEL_TASK_CATALOG = MODEL_TASKS.map(definition => ({
  ...definition,
  fixture: () => taskFixture(definition.id),
  fixtures: async () => {
    const first = await taskFixture(definition.id);
    // Detect always exposes both a dialogue crop and an SFX crop; probeModelRow
    // runs both and passes if either finds a region (COO only hits SFX).
    if (definition.id === 'sourceDecide') return [first, { ...first, candidates: first.candidates.map((c: any) => ({ ...c, id: c.id === 'A' ? 'B' : 'A' })).reverse() }];
    if (definition.id === 'detect') return [first, { ...first, jpeg: await sfxProbeJpeg() }];
    if (definition.id === 'vision') return [first, { ...first, lang: 'korean', jpeg: Buffer.from(KOREAN_VISION_PROBE_PNG) }];
    return definition.id === 'translate' ? [first, { ...first, lang: 'korean',
      boxes: first.boxes.map((box: any) => ({ ...box, source: '테스트' })) }] : [first];
  },
  validate: (output: unknown) => validateTaskOutput(definition.id, output),
  validateFixture: (output: unknown, input: Record<string, any>) => validateFixtureResult(definition.id, output, input),
  run: (row: ModelRow, input: Record<string, any>, options: Parameters<typeof executeModelTask>[3]) =>
    executeModelTask(row, definition.id, input, options),
}));
export function modelTaskContract(id: ModelTaskId) {
  const task = MODEL_TASK_CATALOG.find(task => task.id === id);
  if (!task) throw new ModelTaskError('unsupported', `Unknown task: ${id}`);
  return task;
}

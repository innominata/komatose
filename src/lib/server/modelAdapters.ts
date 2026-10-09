/** Bundled adapters. Native runtime knowledge is confined to this boundary. */
import type { ModelRow } from '../modelRegistry';
import { ModelTaskError, type ModelTaskId } from '../modelTasks';
import type { DiscoveredPackage } from './modelPackages';
import { withAssistantHttp } from './openaiHttp';
import { modelHttpConfig } from './modelConnection';

export type TaskInput = Record<string, any>;
const unsupported = (task: string) => { throw new ModelTaskError('unsupported', `This adapter does not implement ${task}`); };

export async function invokeBuiltinAdapter(pkg: DiscoveredPackage, row: ModelRow, task: ModelTaskId, input: TaskInput, abort?: AbortSignal, retain?: (release: () => void) => void): Promise<any> {
  const adapter = pkg.manifest.adapter.id;
  const opts = { ...input, abort, model: input.model || row.slug };
  if (adapter === 'systemone') {
    if (task !== 'sourceDecide') return unsupported(task);
    return (await import('./transcriptionDecider')).invokeDecider(row, input, abort, retain);
  }
  if (adapter === 'native-ocr') {
    if (task !== 'vision' && task !== 'sourceReview') return unsupported(task);
    if (row.languages && !row.languages.includes(input.lang || 'japanese')) throw new ModelTaskError('unsupported', 'This recognizer does not support the requested chapter language');
    const { localTranscription, withLocalReview } = await import('./localReview');
    const source = await withLocalReview(signal => localTranscription(row.id as any, input.jpeg, signal, input.lang), abort);
    return task === 'vision' ? { source, lineType: '""' } : {
      status: source.trim() ? 'unassessed' : 'unreadable', source, translation: '',
      answer: source.trim() ? 'Independent transcription. This recognizer does not assess uncertainty.' : 'The recognizer returned no text.',
    };
  }
  if (adapter === 'native-translator') {
    if (task !== 'translate') return unsupported(task);
    const { translationModel } = await import('../translationModels');
    const model = translationModel(row.slug);
    if (!model) throw new ModelTaskError('error', 'Translation recipe is missing');
    if (!model.languages.includes(input.lang || 'japanese')) throw new ModelTaskError('unsupported', 'This adapter does not implement the requested source language');
    const { translateWithSpecialist } = await import('./specialistTranslation');
    return translateWithSpecialist(model, input.boxes, opts as any);
  }
  if (adapter === 'workflow-image' || adapter === 'native-detector' || adapter === 'image-editor') {
    const { invokeImageAdapter } = await import('./modelImageAdapters');
    return invokeImageAdapter(pkg, row, task, input, abort);
  }
  if (adapter === 'browser-proofreader') {
    if (task !== 'pageImageProofread') return unsupported(task);
    const { proofreadWithService } = await import('./proofreadService');
    return proofreadWithService({ proofreader: row.id as any, images: input.images, prompt: input.prompt, followUp: input.followUp, abort } as any);
  }
  if (adapter === 'cli') {
    const cli = await import('./cliTranslate');
    const engine = String(pkg.manifest.config?.provider || row.cliAdapter || '');
    switch (task) {
      case 'translate': return cli.translateScriptWithCli(engine as any, input.boxes, opts as any);
      case 'vision': return cli.readBubbleWithCli(engine as any, input.jpeg, opts as any);
      case 'describe': return cli.describePageWithCli(engine as any, input.jpeg, opts as any);
      case 'compactNotes': return cli.compactSceneNotesWithCli(engine as any, input.rows, opts as any);
      case 'chapterReview': return cli.reviewChapterWithCli(engine as any, opts as any);
      case 'proofreadEnglish': return cli.proofreadScriptWithCli(engine as any, input.items, opts as any);
      case 'alternatives': return cli.suggestAlternativesWithCli(engine as any, opts as any);
      case 'sourceReview': case 'advisory': case 'pageImageProofread':
        return cli.advisoryWithCli(engine, opts as any);
      case 'cleaning': {
        if (engine !== 'codex') return unsupported(task);
        const { invokeImageAdapter } = await import('./modelImageAdapters');
        return invokeImageAdapter(pkg, row, task, input, abort);
      }
      default: return unsupported(task);
    }
  }
  if (adapter !== 'openai' && adapter !== 'local-chat') return unsupported(task);
  // These are protocol limitations, not declarations about a model. A new API
  // adapter can implement image output without changing application dispatch.
  if (['textMask','segmentBubble','inpaint','cleaning'].includes(task)) return unsupported(task);
  const llm = await import('./llm');
  const run = async () => {
    switch (task) {
      case 'translate': return input.ocrSource
        ? (await import('./ocrReview')).translateOcrGenericLocal(input.boxes, opts as any)
        : llm.translateScript(input.boxes, opts as any);
      case 'vision': return llm.readBubble(input.jpeg, abort, opts.model, input.lang);
      case 'describe': return llm.describePage(input.jpeg, opts as any);
      case 'compactNotes': return llm.compactSceneNotes(input.rows, opts as any);
      case 'chapterReview': return llm.reviewChapterScript(opts as any);
      case 'proofreadEnglish': return llm.proofreadScript(input.items, opts as any);
      case 'alternatives': return llm.suggestAlternativesScript(opts as any);
      case 'sourceReview': case 'advisory': case 'pageImageProofread': case 'detect': {
        const images: Buffer[] = input.images || (input.jpeg ? [input.jpeg] : []);
        const messages: any[] = [
          { role: 'system', content: input.system || 'Locate lettering regions. Return JSON {"regions":[{"x":0.1,"y":0.1,"w":0.2,"h":0.2}]} using normalized coordinates.' },
          { role: 'user', content: [{ type: 'text', text: input.prompt || 'Locate text in this image.' },
            ...images.map(bytes => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } }))] },
        ];
        const output = await llm.chatCompletions(messages, { model: opts.model, abort, maxTokens: 6000,
          schema: input.schema ? { type: 'json_schema', json_schema: { name: task, strict: true, schema: input.schema } } : undefined });
        return llm.extractJsonObject(output);
      }
      default: return unsupported(task);
    }
  };
  if (adapter === 'local-chat' && !row.managedLaunch) {
    const local = await import('./localReview');
    return local.withLocalReview(async signal => {
      abort = signal;
      opts.abort = signal;
      const config = await local.localReviewHttpConfig(row.id as any, signal);
      return withAssistantHttp(config, run);
    }, abort);
  }

  if (pkg.manifest.lifecycle?.start) {
    const { invokePackage } = await import('./modelSupervisor');
    const health = await invokePackage(pkg, 'health', {}, { signal: abort });
    if (!health?.ready) {
      await invokePackage(pkg, 'start', {}, { signal: abort });
      const ready = await invokePackage(pkg, 'health', {}, { signal: abort });
      if (!ready?.ready) throw new ModelTaskError('error', 'The configured API service did not become ready');
    }
  }
  const { holdManagedModel } = await import('./managedModels');
  const release = await holdManagedModel(row.id, Boolean(row.managedLaunch), abort);
  retain?.(release);
  try { return await withAssistantHttp(modelHttpConfig(row, opts.model), run); }
  finally { if (!retain) release(); }
}

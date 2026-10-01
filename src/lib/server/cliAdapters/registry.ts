import type { DetectedBox } from '../llm';
import type { LineType } from '../../types';
import type { AdvisoryRequest, ChapterReviewOptions, ChapterReviewResult, CleaningOptions, CliAdapter, PageDescribeOptions, TranslationOptions, VisionReadOptions } from './types';

/** Instance-owned, validated registry; no implicit fallback to another provider. */
export class CliAdapterRegistry {
  private readonly adapters = new Map<string, CliAdapter>();

  constructor(adapters: readonly CliAdapter[]) {
    for (const adapter of adapters) {
      if (!/^[a-z][a-z0-9-]*$/.test(adapter.id))
        throw new Error(`Invalid CLI adapter ID: ${adapter.id}`);
      if (this.adapters.has(adapter.id))
        throw new Error(`Duplicate CLI adapter: ${adapter.id}`);
      this.adapters.set(adapter.id, Object.freeze({ ...adapter }));
    }
  }

  has(id: unknown): id is string { return typeof id === 'string' && this.adapters.has(id); }
  list(): readonly CliAdapter[] { return [...this.adapters.values()]; }
  get(id: string): CliAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown CLI adapter: ${id}`);
    return adapter;
  }

  requireTranslation(id: string): CliAdapter & { translate: NonNullable<CliAdapter['translate']> } {
    const adapter = this.get(id);
    if (!adapter.translate) throw new Error(`${adapter.label} does not support translation`);
    return adapter as CliAdapter & { translate: NonNullable<CliAdapter['translate']> };
  }

  requireRead(id: string): CliAdapter & { read: NonNullable<CliAdapter['read']> } {
    const adapter = this.get(id);
    if (!adapter.read) throw new Error(`${adapter.label} does not support vision reading`);
    return adapter as CliAdapter & { read: NonNullable<CliAdapter['read']> };
  }

  requireReview(id: string): CliAdapter & { review: NonNullable<CliAdapter['review']> } {
    const adapter = this.get(id);
    if (!adapter.review) throw new Error(`${adapter.label} does not support chapter review`);
    return adapter as CliAdapter & { review: NonNullable<CliAdapter['review']> };
  }

  requireDescribe(id: string): CliAdapter & { describe: NonNullable<CliAdapter['describe']> } {
    const adapter = this.get(id);
    if (!adapter.describe) throw new Error(`${adapter.label} does not support page description`);
    return adapter as CliAdapter & { describe: NonNullable<CliAdapter['describe']> };
  }

  requireClean(id: string): CliAdapter & { clean: NonNullable<CliAdapter['clean']> } {
    const adapter = this.get(id);
    if (!adapter.clean) throw new Error(`${adapter.label} does not support cleaning`);
    return adapter as CliAdapter & { clean: NonNullable<CliAdapter['clean']> };
  }

  async translate(id: string, boxes: DetectedBox[], options: TranslationOptions): Promise<DetectedBox[]> {
    options.abort?.throwIfAborted();
    const adapter = this.requireTranslation(id);
    if (options.jpeg && !adapter.supportsImages)
      throw new Error(`${adapter.label} does not support image attachments`);
    if (!adapter.executable()) throw new Error(`${adapter.label} CLI not found`);
    const result = await adapter.translate(boxes, { ...options, model: options.model || adapter.defaultModel() });
    options.abort?.throwIfAborted();
    return result;
  }

  async read(id: string, jpeg: Buffer, options: VisionReadOptions = {}): Promise<{ source: string; lineType: LineType }> {
    options.abort?.throwIfAborted();
    const adapter = this.requireRead(id);
    if (!adapter.supportsImages) throw new Error(`${adapter.label} does not support image attachments`);
    if (!adapter.executable()) throw new Error(`${adapter.label} CLI not found`);
    const result = await adapter.read(jpeg, { ...options, model: options.model || adapter.defaultModel() });
    options.abort?.throwIfAborted();
    return result;
  }

  async review(id: string, options: ChapterReviewOptions): Promise<ChapterReviewResult> {
    options.abort?.throwIfAborted();
    const adapter = this.requireReview(id);
    if (!adapter.executable()) throw new Error(`${adapter.label} CLI not found`);
    const result = await adapter.review({ ...options, model: options.model || adapter.defaultModel() });
    options.abort?.throwIfAborted();
    return result;
  }

  async describe(id: string, jpeg: Buffer, options: PageDescribeOptions = {}): Promise<string> {
    options.abort?.throwIfAborted();
    const adapter = this.requireDescribe(id);
    if (!adapter.supportsImages) throw new Error(`${adapter.label} does not support image attachments`);
    if (!adapter.executable()) throw new Error(`${adapter.label} CLI not found`);
    const result = await adapter.describe(jpeg, { ...options, model: options.model || adapter.defaultModel() });
    options.abort?.throwIfAborted();
    return result;
  }

  async clean(id: string, image: Buffer, options: CleaningOptions): Promise<Buffer> {
    options.abort?.throwIfAborted();
    const adapter = this.requireClean(id);
    if (!adapter.supportsImages) throw new Error(`${adapter.label} does not support image attachments`);
    if (!adapter.executable()) throw new Error(`${adapter.label} CLI not found`);
    const result = await adapter.clean(image, { ...options, model: options.model || adapter.defaultModel() });
    options.abort?.throwIfAborted();
    return result;
  }

  async advisory(id: string, request: AdvisoryRequest): Promise<unknown> {
    request.abort?.throwIfAborted();
    const adapter = this.get(id);
    if (request.images.length && !adapter.supportsImages)
      throw new Error(`${adapter.label} does not support image attachments`);
    if (!adapter.executable()) throw new Error(`${adapter.label} CLI not found`);
    return adapter.advisory({ ...request, model: request.model || adapter.defaultModel() });
  }
}

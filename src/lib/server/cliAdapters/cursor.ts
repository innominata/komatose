import { runUnlessAborted } from './command';
import type { AdapterOptions, CliAdapter } from './types';

type CursorRuntime = {
  prompt(request: { prompt: string; images: Buffer[]; model?: string; abort?: AbortSignal }): Promise<string>;
  parse(text: string): unknown;
};
export function createCursorAdapter(options: AdapterOptions, runtime: CursorRuntime): CliAdapter {
  return {
    ...options, id: 'cursor', label: 'Cursor', supportsImages: true,
    async advisory(request) {
      request.abort?.throwIfAborted();
      const text = await runUnlessAborted(request.abort, runtime.prompt({
        prompt: `${request.system}\n\n${request.prompt}\nReturn JSON matching this schema: ${JSON.stringify(request.schema)}`,
        images: request.images, model: request.model, abort: request.abort,
      }));
      request.abort?.throwIfAborted();
      return runtime.parse(text);
    },
  };
}

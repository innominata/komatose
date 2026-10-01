import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandAdvisory } from './command';
import type { AdapterOptions, CliAdapter, CommandRuntime } from './types';

type GrokRuntime = CommandRuntime & {
  headlessArgs(work: string): string[];
  imagePromptArgs(work: string, prompt: string, images: Buffer[]): Promise<string[]>;
};
export function createGrokAdapter(options: AdapterOptions, runtime: GrokRuntime): CliAdapter {
  return {
    ...options, id: 'grok', label: 'Grok', supportsImages: true,
    advisory: request => commandAdvisory('grok', options, runtime, request, async (work, bin) => {
      const args = ['--system-prompt-override', `${request.system} Do not use tools.`,
        '--json-schema', JSON.stringify(request.schema), ...runtime.headlessArgs(work)];
      if (request.images.length)
        args.push(...await runtime.imagePromptArgs(work, request.prompt, request.images));
      else {
        const path = join(work, 'prompt.txt');
        await writeFile(path, request.prompt);
        args.push('--prompt-file', path);
      }
      if (request.model) args.push('-m', request.model);
      return { command: { bin, args, cwd: work, abort: request.abort } };
    }),
  };
}

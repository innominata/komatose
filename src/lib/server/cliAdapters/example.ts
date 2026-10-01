import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandAdvisory } from './command';
import type { AdapterOptions, CliAdapter, CommandRuntime } from './types';

/**
 * Minimum CliAdapter: id, label, image flag, executable, default model,
 * listModels, and advisory. Optional task handlers come from `options`.
 * Not registered in the production registry.
 */
export function createExampleAdapter(options: AdapterOptions, runtime: CommandRuntime): CliAdapter {
	return {
		...options,
		id: 'example',
		label: 'Example',
		supportsImages: false,
		advisory: (request) =>
			commandAdvisory('example', options, runtime, request, async (work, bin) => {
				const prompt = join(work, 'prompt.txt');
				await writeFile(prompt, `${request.system}\n\n${request.prompt}`);
				const args = ['--prompt-file', prompt];
				if (request.model) args.push('--model', request.model);
				return { command: { bin, args, cwd: work, abort: request.abort } };
			}),
	};
}

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandAdvisory } from './command';
import type { AdapterOptions, CliAdapter, CommandRuntime } from './types';

export function createCodexAdapter(options: AdapterOptions, runtime: CommandRuntime): CliAdapter {
  return {
    ...options, id: 'codex', label: 'Codex', supportsImages: true,
    advisory: request => commandAdvisory('codex', options, runtime, request, async (work, bin) => {
      const schema = join(work, 'schema.json');
      const last = join(work, 'last.txt');
      await writeFile(schema, JSON.stringify(request.schema));
      const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
        '--color', 'never', '--output-schema', schema, '-o', last,
        '-C', work, '-c', 'approval_policy="never"'];
      for (const [i, bytes] of request.images.entries()) {
        const path = join(work, `image-${i + 1}.jpg`);
        await writeFile(path, bytes);
        args.push('-i', path);
      }
      if (request.model) args.push('-m', request.model);
      args.push('--', '-');
      return {
        command: { bin, args, cwd: work, abort: request.abort,
          stdin: `${request.system}\n\n${request.prompt}\nReturn JSON matching this schema: ${JSON.stringify(request.schema)}` },
        output: async () => existsSync(last) ? readFile(last, 'utf8') : '',
      };
    }),
  };
}

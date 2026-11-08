import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandAdvisory } from './command';
import type { AdapterOptions, CliAdapter, CommandRuntime } from './types';

/**
 * Claude Code (`claude -p`). Prompts and images go in as one stream-json user
 * message on stdin, so images are real image blocks rather than files the model
 * would have to open with a tool. All built-in tools are disabled and the
 * session is not saved.
 */
export const CLAUDE_SYSTEM_PROMPT =
	'You are a backend assistant for a comic translation tool. Follow the user message exactly and reply with JSON only. Do not use tools.';

export function claudeArgs(model?: string): string[] {
	const args = [
		'-p',
		'--input-format', 'stream-json',
		'--output-format', 'stream-json',
		'--verbose',
		'--tools', '',
		'--strict-mcp-config',
		'--disable-slash-commands',
		'--no-session-persistence',
		'--system-prompt', CLAUDE_SYSTEM_PROMPT,
	];
	if (model) args.push('--model', model);
	return args;
}

/** One stream-json user message: text first, then images in order. */
export function claudeStdin(prompt: string, images: Buffer[] = []): string {
	const content: unknown[] = [{ type: 'text', text: prompt }];
	for (const bytes of images) {
		content.push({ type: 'image', source: { type: 'base64', media_type: imageMediaType(bytes), data: bytes.toString('base64') } });
	}
	return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

function imageMediaType(bytes: Buffer): string {
	if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
	if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
	if (bytes.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
	return 'image/jpeg';
}

/** `claude` output when this server's account has no usable login. */
export function claudeAuthError(text: string): string | null {
	const raw = String(text || '');
	if (/not logged in|please run \/login|invalid api key|oauth token (has )?expired/i.test(raw)) {
		return 'Claude Code is not signed in on this server. Run `claude` and /login (or set ANTHROPIC_API_KEY) as the account Komatose runs under.';
	}
	return null;
}

type ClaudeResult = { text: string; isError: boolean };

/** Final `result` event from stream-json output, or null when there is none. */
export function claudeResult(stdout: string): ClaudeResult | null {
	const lines = String(stdout || '').split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line.startsWith('{')) continue;
		let rec: Record<string, unknown>;
		try {
			rec = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (rec?.type !== 'result') continue;
		const errors = Array.isArray(rec.errors) ? rec.errors.map(String).join('\n') : '';
		const text = typeof rec.result === 'string' ? rec.result : errors || String(rec.subtype || '');
		return { text: text.trim(), isError: rec.is_error === true || (rec.subtype !== undefined && rec.subtype !== 'success') };
	}
	return null;
}

/**
 * The model's reply from `claude -p` stream-json output. Throws the CLI's own
 * error (login, quota, unknown model) instead of trying to parse it as JSON.
 */
export function claudeReplyText(stdout: string, stderr = ''): string {
	const result = claudeResult(stdout);
	if (!result) {
		const raw = `${stderr}\n${stdout}`.trim();
		throw new Error(claudeAuthError(raw) || (raw ? `Claude Code returned no result: ${raw.slice(0, 500)}` : 'Claude Code returned no output'));
	}
	if (result.isError) throw new Error(claudeAuthError(result.text) || `Claude Code failed: ${result.text || 'unknown error'}`);
	if (!result.text) throw new Error('Claude Code returned no output');
	return result.text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function createClaudeAdapter(options: AdapterOptions, runtime: CommandRuntime): CliAdapter {
	return {
		...options, id: 'claude', label: 'Claude Code', supportsImages: true,
		advisory: request => commandAdvisory('claude', options, runtime, request, async (work, bin) => {
			const prompt = `${request.system}\n\n${request.prompt}\nReturn JSON matching this schema: ${JSON.stringify(request.schema)}`;
			// The job log reads prompt.txt; stdin carries base64 images.
			await writeFile(join(work, 'prompt.txt'), prompt);
			return { command: { bin, args: claudeArgs(request.model), cwd: work, abort: request.abort, stdin: claudeStdin(prompt, request.images) } };
		}),
	};
}

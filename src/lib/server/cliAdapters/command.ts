import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdvisoryRequest, AdapterOptions, Command, CommandRuntime } from './types';

export function abortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason && typeof reason === 'object' && 'name' in reason && (reason as { name: string }).name === 'TimeoutError') {
		return new Error('CLI timed out');
	}
	if (reason instanceof Error) return reason;
	return new Error('Cancelled');
}

/** Rejects when `signal` aborts. Does not resolve if `signal` is omitted. */
export function whenAborted(signal?: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (!signal) {
			reject(new Error('Cancelled'));
			return;
		}
		const fail = () => reject(abortError(signal));
		if (signal.aborted) fail();
		else signal.addEventListener('abort', fail, { once: true });
	});
}

export async function runUnlessAborted<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) throw abortError(signal);
	return Promise.race([work, whenAborted(signal)]);
}

/** Preserve the shared process runner's cancellation, timeout and job logging. */
export async function commandAdvisory(
	id: string, options: AdapterOptions, runtime: CommandRuntime, request: AdvisoryRequest,
	prepare: (work: string, bin: string) => Promise<{
		command: Command;
		output?: () => Promise<string>;
	}>,
): Promise<unknown> {
	request.abort?.throwIfAborted();
	const bin = options.executable();
	if (!bin) throw new Error(`${id} CLI not found`);
	const work = await mkdtemp(join(tmpdir(), 'scan-advisory-'));
	try {
		const prepared = await prepare(work, bin);
		request.abort?.throwIfAborted();
		const result = await runUnlessAborted(request.abort, runtime.run(prepared.command));
		request.abort?.throwIfAborted();
		if (result.code !== 0)
			throw new Error(`${id} exited ${result.code}: ${[result.stderr, result.stdout].filter(s => s.trim()).join('\n').trim()}`);
		const output = await prepared.output?.();
		return runtime.parse(output || result.stdout || result.stderr);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

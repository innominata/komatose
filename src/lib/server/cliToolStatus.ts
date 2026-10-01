import {
	CLI_LABEL,
	discoverCli,
	environmentOverrideVar,
	type CliDiscoveryResult,
	type CliToolId,
	type DiscoveryHost,
	type DiscoverySource,
	nodeDiscoveryHost,
} from './cliDiscovery';
import {
	clearCliToolSetting,
	readCliToolSettings,
	savedCliTool,
	setCliToolSetting,
	validateCliToolId,
} from './cliToolSettings';
import { PRODUCTION_CLI_ADAPTER_IDS } from '../cliAdapterDefs';

export type CliToolConfigSource = 'environment' | 'saved_setting' | 'automatic';

export type CliToolAdminStatus = {
	id: CliToolId;
	label: string;
	found: boolean;
	source: CliToolConfigSource;
	environmentOverride: boolean;
	environmentVar?: string;
	saved: string | null;
	message: string;
};

const TOOLS: readonly CliToolId[] = PRODUCTION_CLI_ADAPTER_IDS;

export function publicConfigSource(source?: DiscoverySource): CliToolConfigSource {
	if (source === 'override') return 'environment';
	if (source === 'saved_setting') return 'saved_setting';
	return 'automatic';
}

/** Admin-only view: includes the saved edit value, never a resolved absolute path. */
export function listCliToolAdminStatus(host: DiscoveryHost = nodeDiscoveryHost()): CliToolAdminStatus[] {
	const settings = Object.prototype.hasOwnProperty.call(host, 'savedTools')
		? host.savedTools || {}
		: readCliToolSettings();
	return TOOLS.map((id) => {
		const result = discoverCli(id, host);
		const envVar = environmentOverrideVar(id, host);
		return publicCliToolStatus(id, result, savedCliTool(id, settings) || null, envVar);
	});
}

export function publicCliToolStatus(
	id: CliToolId,
	result: CliDiscoveryResult,
	saved: string | null,
	environmentVar?: string,
): CliToolAdminStatus {
	return {
		id,
		label: CLI_LABEL[id],
		found: result.status === 'found',
		source: publicConfigSource(result.source),
		environmentOverride: Boolean(environmentVar),
		environmentVar: environmentVar || undefined,
		saved,
		message: result.reason,
	};
}

export function applyCliToolAdminAction(
	action: string,
	body: { id?: unknown; executable?: unknown },
	host?: DiscoveryHost,
): CliToolAdminStatus[] {
	if (action === 'check') {
		if (body.id != null && body.id !== '') validateCliToolId(String(body.id));
		return listCliToolAdminStatus(host);
	}
	if (action === 'save') {
		setCliToolSetting(String(body.id || ''), body.executable);
		return listCliToolAdminStatus(host);
	}
	if (action === 'clear') {
		clearCliToolSetting(String(body.id || ''));
		return listCliToolAdminStatus(host);
	}
	throw Object.assign(new Error('Unknown action'), { status: 400 });
}

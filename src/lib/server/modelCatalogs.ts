import { modelHttpConfig } from './modelConnection';
import { parseOpenAiModelList, type ListedModel } from '../cliModelLists';
import { isCliAdapterId } from '../modelRegistry';
import { llmConfig } from './llm';
import { openaiListModels } from './openaiHttp';
import { hasRegisteredCliAdapter, listRegisteredCliModels, listLocalModels } from './cliTranslate';
import { catalogCache, findRegistryRow, saveCatalogCache } from './modelRegistryStore';

export type CatalogRefresh = {
	adapter: string;
	models: ListedModel[];
	at: number;
	error?: string;
};

async function listed(adapter: string, run: () => Promise<ListedModel[]>): Promise<CatalogRefresh> {
	try {
		const models = await run();
		saveCatalogCache(adapter, models);
		return { adapter, models, at: Date.now() };
	} catch (error) {
		const previous = catalogCache(adapter);
		return {
			adapter,
			models: previous?.models || [],
			at: previous?.at || 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function refreshLiveCatalog(adapter: string): Promise<CatalogRefresh> {
	if (hasRegisteredCliAdapter(adapter) || isCliAdapterId(adapter)) {
		return listed(adapter, () => listRegisteredCliModels(adapter));
	}
	if (adapter === 'llamacpp' || adapter === 'qwen' || adapter === 'local_http') {
		return listed('llamacpp', listLocalModels);
	}
	if (adapter.startsWith('remote:') || adapter.startsWith('local:')) {
		const id = adapter.slice(adapter.indexOf(':') + 1);
		const row = findRegistryRow(id);
		if (!row || !['remote_http', 'local_http'].includes(row.access)) {
			return { adapter, models: [], at: 0, error: 'Remote model not found' };
		}
		const cfg = modelHttpConfig(row);
		if (!cfg) return { adapter, models: [], at: 0, error: 'This model has no HTTP catalog' };
		return listed(adapter, async () => {
			const json = await openaiListModels(cfg.baseUrl, cfg.apiKey);
			return parseOpenAiModelList(json);
		});
	}
	return { adapter, models: catalogCache(adapter)?.models || [], at: catalogCache(adapter)?.at || 0, error: 'Unknown catalog' };
}

export function llamaSwapUrl(): string {
	return llmConfig().url;
}

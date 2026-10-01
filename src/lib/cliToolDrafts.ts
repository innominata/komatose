/** Keep unsaved location drafts when status refreshes. */
export function refreshCliToolDrafts(
	drafts: Record<string, string>,
	tools: Array<{ id: string; saved?: string | null }>,
	syncIds: readonly string[] = [],
): Record<string, string> {
	const next = { ...drafts };
	for (const tool of tools) {
		if (!(tool.id in next)) next[tool.id] = tool.saved || '';
	}
	for (const id of syncIds) {
		const tool = tools.find((item) => item.id === id);
		if (tool) next[id] = tool.saved || '';
	}
	return next;
}

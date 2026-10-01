import type { ModelRow } from "../modelRegistry";
import type { AssistantHttpConfig } from "./openaiHttp";
import { DEFAULT_CHAT_MODEL_ID } from "../modelDefaults";
import { envVar } from "./envFile";
import { effectiveManagedRow, managedModelRunning } from "./modelUsage";

export function defaultLocalConnection() {
  return {
    url: envVar("LLAMASWAP_URL") || "http://127.0.0.1:8081/v1",
    model: envVar("LLAMASWAP_MODEL") || DEFAULT_CHAT_MODEL_ID,
    apiKey: envVar("LLAMASWAP_API_KEY"),
  };
}
export function normalizeHttpBase(raw: string): string {
  const url = raw.trim().replace(/\/+$/, "");
  if (!url) throw new Error("Model endpoint is not configured");
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Model endpoint must use HTTP or HTTPS");
  return /\/v\d+$/i.test(url) ? url : `${url}/v1`;
}
export function modelHttpConfig(
  input: ModelRow,
  slug = input.slug,
): AssistantHttpConfig | undefined {
  const row = effectiveManagedRow(input);
  if (row.access === 'cli' || row.access === 'proofreader') return undefined;
  const defaults = defaultLocalConnection();
  const managed = row.managedLaunch;
  const inherited =
    !managed &&
    row.access === "local_http" &&
    !(row.http?.baseUrl || "").trim();
  const baseUrl = managed
    ? `http://127.0.0.1:${managed.port}/v1`
    : normalizeHttpBase(row.http?.baseUrl || (inherited ? defaults.url : ""));
  // An explicit endpoint never inherits the default endpoint's credentials.
  const keyName =
    row.http?.apiKeyEnv ??
    (inherited
      ? "LLAMASWAP_API_KEY"
      : row.access === "remote_http"
        ? "OPENAI_API_KEY"
        : "");
  return {
    baseUrl,
    apiKey: keyName ? envVar(keyName) : "",
    apiKeyEnv: keyName,
    model: slug,
    rowId: row.id,
    profile:
      row.runtime === "openai" || row.access === "remote_http"
        ? "openai"
        : "llamacpp",
    requestPreset: row.requestPreset || "generic",
    requireApiKey: row.access === "remote_http",
    managed: Boolean(managed),
  };
}
export async function probeModelConnection(
  row: ModelRow,
): Promise<{ available: boolean; reason?: string }> {
  if (row.managedLaunch && !managedModelRunning(row.id))
    return {
      available: true,
      reason: `${row.name}: loads on demand`,
    };
  let cfg: AssistantHttpConfig | undefined;
  try {
    cfg = modelHttpConfig(row);
  } catch (e) {
    return { available: false, reason: String((e as Error).message) };
  }
  if (!cfg)
    return { available: false, reason: "This model uses a specialist runtime" };
  if (cfg.requireApiKey && !cfg.apiKey)
    return { available: false, reason: `${cfg.apiKeyEnv} is not set` };
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    return res.ok
      ? { available: true, reason: `${row.name}: model service responded` }
      : { available: false, reason: `${row.name}: HTTP ${res.status}` };
  } catch {
    return {
      available: false,
      reason: `${row.name}: model service is unreachable`,
    };
  }
}

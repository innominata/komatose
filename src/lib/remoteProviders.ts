/**
 * Catalog of OpenAI-compatible HTTP providers with searchable metadata.
 *
 * Why this exists: every one of these hosts speaks the same `/models` +
 * `/chat/completions` dialect, but each publishes its base URL somewhere else
 * and the admin kept looking them up. The catalog is pure data plus pure search
 * functions (no node: imports) so the browser admin UI and node tests share one
 * source of truth. Secrets are never stored here — only the `.env` variable
 * name, matching how Admin saves HTTP model rows.
 */

/** One OpenAI-compatible endpoint as Admin needs to describe and probe it. */
export type RemoteProvider = {
	id: string;
	name: string;
	group: 'global' | 'china' | 'local';
	baseUrl: string;
	/** `.env` variable name holding the secret; `''` means the endpoint needs no key. */
	apiKeyEnv: string;
	/** Where a human buys/creates a key, so Admin can deep-link instead of explaining. */
	keyUrl?: string;
	/** Example model ids (2-4) so the UI can show realistic placeholders before probing. */
	models?: string[];
	/** Caveats worth knowing before saving: odd paths, deployment placeholders, ports. */
	notes?: string;
};

/**
 * The catalog itself. `china` is a first-class group because those hosts are the
 * whole reason this file exists; `local` entries are loopback defaults with no
 * key so Admin can probe a machine's own servers without credentials.
 */
export const REMOTE_PROVIDERS: RemoteProvider[] = [
	// ── global ────────────────────────────────────────────────────────────────
	{
		id: 'openai',
		name: 'OpenAI',
		group: 'global',
		baseUrl: 'https://api.openai.com/v1',
		apiKeyEnv: 'OPENAI_API_KEY',
		keyUrl: 'https://platform.openai.com/api-keys',
		models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3', 'o3'],
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		group: 'global',
		baseUrl: 'https://openrouter.ai/api/v1',
		apiKeyEnv: 'OPENROUTER_API_KEY',
		keyUrl: 'https://openrouter.ai/keys',
		models: ['anthropic/claude-opus-5', 'google/gemini-3.5-pro', 'meta-llama/llama-4.1-405b-instruct'],
		notes: 'One key reaches many vendors; model ids are vendor-prefixed.',
	},
	{
		id: 'groq',
		name: 'Groq',
		group: 'global',
		baseUrl: 'https://api.groq.com/openai/v1',
		apiKeyEnv: 'GROQ_API_KEY',
		keyUrl: 'https://console.groq.com/keys',
		models: ['llama-4.1-70b-versatile', 'qwen-3.3-32b', 'deepseek-r1-distill-llama-70b'],
	},
	{
		id: 'together',
		name: 'Together',
		group: 'global',
		baseUrl: 'https://api.together.xyz/v1',
		apiKeyEnv: 'TOGETHER_API_KEY',
		keyUrl: 'https://api.together.ai/settings/api-keys',
		models: ['meta-llama/Llama-4.1-405B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3.8-235B-A22B'],
	},
	{
		id: 'fireworks',
		name: 'Fireworks',
		group: 'global',
		baseUrl: 'https://api.fireworks.ai/inference/v1',
		apiKeyEnv: 'FIREWORKS_API_KEY',
		keyUrl: 'https://fireworks.ai/account/api-keys',
		models: [
			'accounts/fireworks/models/llama-v4.1-405b-instruct',
			'accounts/fireworks/models/deepseek-v3p2',
			'accounts/fireworks/models/qwen3p8-235b',
		],
	},
	{
		id: 'xai',
		name: 'xAI Grok',
		group: 'global',
		baseUrl: 'https://api.x.ai/v1',
		apiKeyEnv: 'XAI_API_KEY',
		keyUrl: 'https://console.x.ai',
		models: ['grok-4.5', 'grok-4.5-mini', 'grok-4-fast'],
	},
	{
		id: 'mistral',
		name: 'Mistral',
		group: 'global',
		baseUrl: 'https://api.mistral.ai/v1',
		apiKeyEnv: 'MISTRAL_API_KEY',
		keyUrl: 'https://console.mistral.ai/api-keys',
		models: ['mistral-large-latest', 'codestral-latest', 'pixtral-large-latest'],
	},
	{
		id: 'gemini',
		name: 'Google Gemini OpenAI-compatible',
		group: 'global',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
		apiKeyEnv: 'GEMINI_API_KEY',
		keyUrl: 'https://aistudio.google.com/apikey',
		models: ['gemini-3.5-pro', 'gemini-3.5-flash', 'gemini-2.5-flash'],
		notes: 'Google mounts the OpenAI-compatible routes under /v1beta/openai; leave the path as published instead of appending /v1.',
	},
	{
		id: 'perplexity',
		name: 'Perplexity',
		group: 'global',
		baseUrl: 'https://api.perplexity.ai',
		apiKeyEnv: 'PERPLEXITY_API_KEY',
		keyUrl: 'https://www.perplexity.ai/settings/api',
		models: ['sonar-pro', 'sonar-reasoning-pro'],
		notes: 'Perplexity publishes a bare host with no /v1; chat lives at /chat/completions on this host.',
	},
	{
		id: 'cerebras',
		name: 'Cerebras',
		group: 'global',
		baseUrl: 'https://inference.cerebras.ai/v1',
		apiKeyEnv: 'CEREBRAS_API_KEY',
		keyUrl: 'https://cloud.cerebras.ai',
		models: ['llama-4.1-70b', 'qwen-3.3-32b'],
	},
	{
		id: 'sambanova',
		name: 'SambaNova',
		group: 'global',
		baseUrl: 'https://api.sambanova.ai/v1',
		apiKeyEnv: 'SAMBANOVA_API_KEY',
		keyUrl: 'https://cloud.sambanova.ai/apis',
		models: ['DeepSeek-V3.2', 'Meta-Llama-4.1-405B'],
	},
	{
		id: 'nvidia-nim',
		name: 'NVIDIA NIM',
		group: 'global',
		baseUrl: 'https://integrate.api.nvidia.com/v1',
		apiKeyEnv: 'NVIDIA_API_KEY',
		keyUrl: 'https://build.nvidia.com',
		models: ['meta/llama-4.1-405b-instruct', 'deepseek-ai/deepseek-v4.1'],
	},
	{
		id: 'huggingface',
		name: 'Hugging Face router',
		group: 'global',
		baseUrl: 'https://router.huggingface.co/v1',
		apiKeyEnv: 'HF_TOKEN',
		keyUrl: 'https://huggingface.co/settings/tokens',
		models: ['meta-llama/Llama-4.1-405B-Instruct', 'Qwen/Qwen3.8-235B-A22B'],
		notes: 'Routes to many inference providers behind one HF token.',
	},
	{
		id: 'hyperbolic',
		name: 'Hyperbolic',
		group: 'global',
		baseUrl: 'https://api.hyperbolic.xyz/v1',
		apiKeyEnv: 'HYPERBOLIC_API_KEY',
		keyUrl: 'https://app.hyperbolic.xyz/settings',
		models: ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3.8-235B'],
	},
	{
		id: 'novita',
		name: 'Novita',
		group: 'global',
		baseUrl: 'https://api.novita.ai/v3/openai',
		apiKeyEnv: 'NOVITA_API_KEY',
		keyUrl: 'https://novita.ai/console/key-management',
		models: ['deepseek/deepseek-v3.2', 'meta-llama/llama-4.1-405b-instruct'],
		notes: 'Novita publishes /v3/openai as its base; leave the path as published instead of appending /v1.',
	},
	{
		id: 'azure-openai',
		name: 'Azure OpenAI',
		group: 'global',
		baseUrl: 'https://RESOURCE.openai.azure.com/openai/deployments/DEPLOYMENT',
		apiKeyEnv: 'AZURE_OPENAI_API_KEY',
		keyUrl: 'https://portal.azure.com',
		models: ['gpt-5.4', 'gpt-5.3', 'o3'],
		notes: 'Replace RESOURCE and DEPLOYMENT by hand: Azure routes per-deployment and appends an api-version query parameter.',
	},
	// ── china ─────────────────────────────────────────────────────────────────
	{
		id: 'deepseek',
		name: 'DeepSeek',
		group: 'china',
		baseUrl: 'https://api.deepseek.com/v1',
		apiKeyEnv: 'DEEPSEEK_API_KEY',
		keyUrl: 'https://platform.deepseek.com/api_keys',
		models: ['deepseek-chat', 'deepseek-reasoner'],
		notes: 'deepseek-reasoner thinks before answering; deepseek-chat is the fast default.',
	},
	{
		id: 'moonshot',
		name: 'Moonshot Kimi',
		group: 'china',
		baseUrl: 'https://api.moonshot.cn/v1',
		apiKeyEnv: 'MOONSHOT_API_KEY',
		keyUrl: 'https://platform.moonshot.cn/console/api-keys',
		models: ['kimi-k2.5', 'moonshot-v1-128k'],
	},
	{
		id: 'zhipu',
		name: 'Zhipu GLM',
		group: 'china',
		baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
		apiKeyEnv: 'ZHIPU_API_KEY',
		keyUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
		models: ['glm-4.7', 'glm-4.7v'],
		notes: 'Zhipu publishes /api/paas/v4 as its base; leave the path as published instead of appending /v1.',
	},
	{
		id: 'dashscope',
		name: 'Alibaba Qwen DashScope compatible-mode',
		group: 'china',
		baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		apiKeyEnv: 'DASHSCOPE_API_KEY',
		keyUrl: 'https://dashscope.console.aliyun.com',
		models: ['qwen3.8-max', 'qwen-vl-max', 'qwen-mt-plus'],
	},
	{
		id: 'dashscope-intl',
		name: 'Alibaba Bailian international',
		group: 'china',
		baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
		apiKeyEnv: 'DASHSCOPE_INTL_API_KEY',
		keyUrl: 'https://bailian.console-overnight.aliyun.com',
		models: ['qwen3.8-max', 'qwen-vl-max'],
		notes: 'Same compatible-mode API as the mainland endpoint, for keys issued on the international console.',
	},
	{
		id: 'minimax',
		name: 'MiniMax',
		group: 'china',
		baseUrl: 'https://api.minimax.chat/v1',
		apiKeyEnv: 'MINIMAX_API_KEY',
		keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
		models: ['MiniMax-M2', 'abab6.5s-chat'],
	},
	{
		id: 'baichuan',
		name: 'Baichuan',
		group: 'china',
		baseUrl: 'https://api.baichuan-ai.com/v1',
		apiKeyEnv: 'BAICHUAN_API_KEY',
		keyUrl: 'https://platform.baichuan-ai.com',
		models: ['Baichuan4', 'Baichuan3-Turbo'],
	},
	{
		id: 'yi',
		name: '01.AI Yi',
		group: 'china',
		baseUrl: 'https://api.01.ai/v1',
		apiKeyEnv: 'YI_API_KEY',
		keyUrl: 'https://platform.01.ai',
		models: ['yi-large', 'yi-vision'],
	},
	{
		id: 'siliconflow',
		name: 'SiliconFlow',
		group: 'china',
		baseUrl: 'https://api.siliconflow.cn/v1',
		apiKeyEnv: 'SILICONFLOW_API_KEY',
		keyUrl: 'https://cloud.siliconflow.cn/account/ak',
		models: ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3.8-235B'],
	},
	{
		id: 'hunyuan',
		name: 'Tencent Hunyuan',
		group: 'china',
		baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
		apiKeyEnv: 'HUNYUAN_API_KEY',
		keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
		models: ['hunyuan-turbo', 'hunyuan-vision'],
	},
	{
		id: 'ark',
		name: 'Volcengine Ark',
		group: 'china',
		baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
		apiKeyEnv: 'ARK_API_KEY',
		keyUrl: 'https://console.volcengine.com/ark',
		models: ['doubao-seed-2.0', 'doubao-1.5-vision-pro'],
		notes: 'Volcengine publishes /api/v3 as its base; leave the path as published instead of appending /v1.',
	},
	{
		id: 'modelscope',
		name: 'ModelScope',
		group: 'china',
		baseUrl: 'https://api-inference.modelscope.cn/v1',
		apiKeyEnv: 'MODELSCOPE_API_KEY',
		keyUrl: 'https://modelscope.cn/my/myaccesstoken',
		models: ['Qwen/Qwen3.8-235B-A22B', 'deepseek-ai/DeepSeek-V3.2'],
	},
	{
		id: 'ppio',
		name: 'PPIO',
		group: 'china',
		baseUrl: 'https://api.ppinfra.com/v3/openai',
		apiKeyEnv: 'PPIO_API_KEY',
		keyUrl: 'https://ppinfra.com/user/center/token',
		models: ['deepseek/deepseek-v3.2', 'moonshotai/kimi-k2.5'],
		notes: 'PPIO publishes /v3/openai as its base; leave the path as published instead of appending /v1.',
	},
	{
		id: 'infini',
		name: 'Infini-AI',
		group: 'china',
		baseUrl: 'https://cloud.infini-ai.com/maas/v1',
		apiKeyEnv: 'INFINI_API_KEY',
		keyUrl: 'https://cloud.infini-ai.com',
		models: ['Qwen/Qwen3.8-235B', 'deepseek-ai/DeepSeek-V3.2'],
	},
	{
		id: 'stepfun',
		name: 'StepFun',
		group: 'china',
		baseUrl: 'https://api.stepfun.com/v1',
		apiKeyEnv: 'STEPFUN_API_KEY',
		keyUrl: 'https://platform.stepfun.com',
		models: ['step-2-16k', 'step-1v-8k'],
	},
	{
		id: 'qianfan',
		name: 'Baidu Qianfan',
		group: 'china',
		baseUrl: 'https://qianfan.baidubce.com/v2',
		apiKeyEnv: 'QIANFAN_API_KEY',
		keyUrl: 'https://console.bce.baidu.com/qianfan',
		models: ['ernie-4.5-8k', 'deepseek-v3'],
		notes: 'Baidu publishes v2 of its OpenAI-compatible API; leave the path as published instead of appending /v1.',
	},
	{
		id: '360-ai',
		name: '360 AI',
		group: 'china',
		baseUrl: 'https://api.360.cn/v1',
		apiKeyEnv: 'API360_API_KEY',
		keyUrl: 'https://ai.360.com',
		models: ['360gpt-pro', '360gpt-turbo'],
	},
	{
		id: 'spark',
		name: 'iFlytek Spark',
		group: 'china',
		baseUrl: 'https://spark-api-open.xf-yun.com/v1',
		apiKeyEnv: 'SPARK_API_KEY',
		keyUrl: 'https://xinghuo.xfyun.cn/sparkapi',
		models: ['generalv3.5', '4.0Ultra'],
		notes: 'Spark keys pair an APIPassword with the app id; both go in the same variable.',
	},
	{
		id: 'xiaomi-mimo',
		name: 'Xiaomi MiMo',
		group: 'china',
		baseUrl: 'https://api.xiaomimimo.com/v1',
		apiKeyEnv: 'MIMO_API_KEY',
		keyUrl: 'https://platform.xiaomimimo.com',
		models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
		notes: 'Pay-as-you-go keys (sk-) use this host. Token Plan keys (tp-) use a different host such as https://token-plan-cn.xiaomimimo.com/v1; paste that base URL instead.',
	},
	// ── local ─────────────────────────────────────────────────────────────────
	{
		id: 'ollama',
		name: 'Ollama',
		group: 'local',
		baseUrl: 'http://127.0.0.1:11434/v1',
		apiKeyEnv: '',
		models: ['qwen3.8:27b', 'gemma3:27b', 'deepseek-r1:32b'],
		notes: 'Loopback default; no key needed.',
	},
	{
		id: 'lm-studio',
		name: 'LM Studio',
		group: 'local',
		baseUrl: 'http://127.0.0.1:1234/v1',
		apiKeyEnv: '',
		models: ['qwen3.8-27b-instruct', 'gemma-3-27b-it'],
		notes: 'Serve any loaded model from the Developer tab; no key by default.',
	},
	{
		id: 'llamacpp',
		name: 'llama.cpp / llama-swap',
		group: 'local',
		baseUrl: 'http://127.0.0.1:8080/v1',
		apiKeyEnv: '',
		notes: 'Komatose managed chat models use their own ports; this is for an external server.',
	},
	{
		id: 'vllm',
		name: 'vLLM',
		group: 'local',
		baseUrl: 'http://127.0.0.1:8000/v1',
		apiKeyEnv: '',
		models: ['meta-llama/Llama-4.1-8B-Instruct'],
		notes: 'Model ids are the repo names vLLM was launched with.',
	},
	{
		id: 'localai',
		name: 'LocalAI',
		group: 'local',
		baseUrl: 'http://127.0.0.1:8080/v1',
		apiKeyEnv: '',
		models: ['llama-3.3-70b-instruct'],
		notes: 'Gallery model names double as model ids.',
	},
	{
		id: 'jan',
		name: 'Jan',
		group: 'local',
		baseUrl: 'http://127.0.0.1:1337/v1',
		apiKeyEnv: '',
		models: ['llama-3.2-3b-instruct'],
		notes: 'Enable the Local API Server in Jan settings first.',
	},
	{
		id: 'tgi',
		name: 'text-generation-inference',
		group: 'local',
		baseUrl: 'http://127.0.0.1:8080/v1',
		apiKeyEnv: '',
		models: ['meta-llama/Llama-4.1-8B-Instruct'],
		notes: 'TGI 3.x exposes /v1; earlier releases only served /generate.',
	},
	{
		id: 'triton',
		name: 'NVIDIA Triton OpenAI frontend',
		group: 'local',
		baseUrl: 'http://127.0.0.1:8000/v1',
		apiKeyEnv: '',
		models: ['llama-4.1-8b'],
		notes: 'Enable Triton\'s OpenAI HTTP frontend; model ids are repository names.',
	},
];

/** Lowercased haystack per provider, built once: the catalog is constant and search runs per keystroke. */
const SEARCH_TEXT = new Map<string, string>(
	REMOTE_PROVIDERS.map((provider) => [
		provider.id,
		[
			provider.name,
			provider.id,
			provider.group,
			provider.baseUrl,
			provider.apiKeyEnv,
			...(provider.models || []),
		]
			.join('\n')
			.toLowerCase(),
	]),
);

const PROVIDER_BY_ID = new Map<string, RemoteProvider>(
	REMOTE_PROVIDERS.map((provider) => [provider.id, provider]),
);

/**
 * Case-insensitive catalog search over name, id, group label, base URL, key
 * variable and model ids. An empty query lists everything so the admin UI can
 * render the full catalog without a second code path.
 */
export function searchProviders(query: string): RemoteProvider[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...REMOTE_PROVIDERS];
	return REMOTE_PROVIDERS.filter((provider) => (SEARCH_TEXT.get(provider.id) || '').includes(needle));
}

/** Direct lookup for saved rows and deep links; O(1) so probes can resolve a pasted id. */
export function providerById(id: string): RemoteProvider | undefined {
	return PROVIDER_BY_ID.get(id);
}

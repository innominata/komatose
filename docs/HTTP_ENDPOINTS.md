# HTTP chat endpoints

Komatose has two OpenAI-compatible HTTP chat paths. They share
`POST {baseUrl}/chat/completions` and `GET {baseUrl}/models`. They do not
rewrite the requested model slug or send the request to another host when a
call fails. `npm run test:http-endpoint-contract` is the shared contract (fake
HTTP servers only).

## Base URL

`baseUrl` is the OpenAI-style root including `/v1` (for example
`http://127.0.0.1:8081/v1`). `openaiCompatibleBaseUrl` appends `/v1` when the
saved remote URL has no `/vN` suffix. Chat posts to `{baseUrl}/chat/completions`.
Catalog refresh gets `{baseUrl}/models`.

## Shared request

`POST /chat/completions` JSON:

| Field | Meaning |
| --- | --- |
| `model` | Registry slug as resolved for that row. Not replaced with a default on failure. |
| `messages` | Chat turns (`system` / `user` / `assistant`; user parts may include `image_url`). |
| `temperature` | Default `0.3`. |
| `max_tokens` | Default `8192`, except DeepSeek hosts cap at `4096`. |

`Authorization: Bearer …` is sent when that path has a key. The bearer for one
row is not copied onto another base URL.

`GET /models` is the catalog probe. Setup uses it for the local endpoint; Admin
**Refresh list** uses it for llama-swap and for each remote row.

## Local llama.cpp (`profile: llamacpp`)

Used when the routed row is local HTTP (llama-swap / llama.cpp). The selected
row supplies the URL and credential variable. Only rows inheriting the default
endpoint use the legacy `LLAMASWAP_*` defaults; an explicitly configured endpoint
never falls back to another endpoint’s key. An empty local key omits the bearer
header. Managed rows derive their endpoint from the active launch recipe.

Extra body fields:

- `cache_prompt: true`
- `chat_template_kwargs.enable_thinking` / `reasoning_effort` (`medium` or `none`) only when the row explicitly uses the Qwen thinking request preset
- `response_format` is the native JSON schema object when the caller supplied one

`503` / `409` and llama-swap “loading” bodies retry on the **same** URL. Network
errors retry on that URL as well. There is no fall-through to a remote row.
Empty `choices[0].message.content` may fall back to `reasoning_content`, or
return an empty string.

## Remote OpenAI-compatible (`profile: openai`)

Used when the row is `remote_http` (or runtime `openai`). The API-key
**variable name** lives on the row; the value comes from the environment /
`.env`. A missing value throws before fetch (`{ENV} is not set…`).

Extra body fields:

- no `cache_prompt` / `chat_template_kwargs`
- `json_schema` `response_format` is sent as `{ type: 'json_object' }`
- if the host returns HTTP 400 that names `response_format`, the **same** URL
  is retried once without `response_format`
- DeepSeek hosts send `thinking: disabled` for JSON and vision so the 4096-token
  cap is spent on the reading, not a hidden chain-of-thought. Vision still folds
  the system turn onto the user image. `max_tokens` 8192 is not used: that
  combination never returns. A `finish_reason` of `length` is an error, not a
  kept partial transcription.

Empty assistant content throws. HTTP errors throw `HTTP {status}: …` and do
not call the local llama.cpp URL.

## Failures

| Situation | Local | Remote |
| --- | --- | --- |
| Missing key | Request without bearer | Error, no fetch |
| HTTP 401 | Error on that URL | Error on that URL |
| HTTP 502 (not a loading body) | Error on that URL | Error on that URL |
| Invalid JSON body | Parse error | Parse error |
| Abort / timeout | `Cancelled` / abort | `Cancelled` / abort |
| Unknown / disabled row | Router error before HTTP | Router error before HTTP |

None of these rewrite `model` or issue the same call to the other profile.

See [Managed local models](./MANAGED_MODELS.md) for recipes and lifecycle controls.

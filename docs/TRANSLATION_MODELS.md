# Dedicated manga translation models

Choose **Translate → Translation model**, then pick a named row (Qwen 27B, Hy-MT,
Shisa, Sugoi, Imsbee, a CLI slug, or a remote OpenAI-compatible row). The same picker appears
under **AI model settings → Translation**. Settings are saved for the series.
Other task models retain their existing choices.

| Saved model ID | Model | Supported source languages | Availability |
| --- | --- | --- | --- |
| `cat-translate-7b-q4` | CAT-Translate 7B Q4_K_M | Japanese → English | mradermacher imatrix Q4 of cyberagent/CAT-Translate-7b; installer provided |
| `hy-mt2-manga-v5` | Hy-MT2 1.8B JP Manga Finetune v5 | Japanese → English | Publisher's Q4_K_M GGUF; installer provided |
| `hy-mt2-1.8b-q4` | Hy-MT2 1.8B Q4_K_M | Japanese/Korean → English | Tencent official GGUF; installer provided |
| `hy-mt2-7b-q4` | Hy-MT2 7B Q4_K_M | Japanese/Korean → English | Tencent's stock Hy-MT2-7B GGUF; installer provided |
| `translategemma-4b-q4` | TranslateGemma 4B Q4_K_M | Japanese/Korean → English | mradermacher Q4_K_M GGUF of google/translategemma-4b-it; installer provided |
| `translategemma-12b-q4` | TranslateGemma 12B Q4_K_M | Japanese/Korean → English | mradermacher Q4_K_M GGUF of google/translategemma-12b-it; installer provided |
| `shisa-v2.1-qwen3-8b-q4` | Shisa v2.1 Qwen3 8B Q4_K_M | Japanese → English | mradermacher Q4_K_M GGUF of shisa-ai/shisa-v2.1-qwen3-8b; installer provided |
| `sugoi-v4-ja-en` | Sugoi v4 Ja→En | Japanese → English | CTranslate2 packaging of Ming Shiba's Sugoi v4; installer provided. NTT license |
| `imsbee-ko-en-translator` | Imsbee Ko→En Translator (sentence-base) | Korean → English | Publisher's 1.07 GB PyTorch checkpoint; installer provided |

As checked on 13 September 2026, the requested `fumetoday` Hy-MT URL is not publicly
accessible. The v5 publisher checkpoint is available under
[fumetodev/Hy-MT2-1.8B-JP-Manga-Finetune-v5-GGUF](https://huggingface.co/fumetodev/Hy-MT2-1.8B-JP-Manga-Finetune-v5-GGUF).
The registry accepts the originally requested name as an alias.

[Imsbee/ko-en-translator](https://huggingface.co/Imsbee/ko-en-translator) is a 268M
minRNN seq2seq trained from scratch (not a Qwen fine-tune). This app uses the
`sentence-base` checkpoint, which is the colloquial/everyday model. The
`doc-paper` technical-document weights are not installed. Japanese input is
rejected. The unpublished Qwen3.5 VNTL checkpoint is no longer registered.

[mradermacher/shisa-v2.1-qwen3-8b-GGUF](https://huggingface.co/mradermacher/shisa-v2.1-qwen3-8b-GGUF)
is a Q4_K_M quant of [shisa-ai/shisa-v2.1-qwen3-8b](https://huggingface.co/shisa-ai/shisa-v2.1-qwen3-8b)
(Apache 2.0, Qwen3-8B). [entai2965/sugoi-v4-ja-en-ctranslate2](https://huggingface.co/entai2965/sugoi-v4-ja-en-ctranslate2)
packages Ming Shiba's Sugoi v4 under that repo's NTT license. Both reject Korean input.

## Installation

```bash
python3 scripts/install-translation-models.py --model cat-translate-7b-q4
python3 scripts/install-translation-models.py --model hy-mt2-manga-v5
python3 scripts/install-translation-models.py --model hy-mt2-1.8b-q4
python3 scripts/install-translation-models.py --model hy-mt2-7b-q4
python3 scripts/install-translation-models.py --model translategemma-4b-q4
python3 scripts/install-translation-models.py --model translategemma-12b-q4
python3 scripts/install-translation-models.py --model shisa-v2.1-qwen3-8b-q4
python3 scripts/install-translation-models.py --model sugoi-v4-ja-en
python3 scripts/install-translation-models.py --model imsbee-ko-en-translator
```

Hy-MT manga v5 downloads the publisher's 1.13 GB GGUF, pinned to revision
`e17bc6a8dd92ddf930bd7858ceb916117ee5f916`. Shisa downloads the 5.03 GB
`shisa-v2.1-qwen3-8b.Q4_K_M.gguf` from `mradermacher/shisa-v2.1-qwen3-8b-GGUF`,
pinned to revision `9b9187f69adca28b8e2b9490b2c151fcb85c0df6`. Sugoi downloads the
CTranslate2 `model.bin` (1.10 GB), vocabularies, and SentencePiece models from
`entai2965/sugoi-v4-ja-en-ctranslate2`, pinned to revision
`71d67eb8e73ec2f5aaefc0689e03a4eb843d3a2b`. The Sugoi installer also installs
`ctranslate2` and `sentencepiece` into the review interpreter when they are missing
(`uv pip` when `uv` is on PATH, because `uv venv` does not ship a `pip` module). Imsbee
downloads `sentence-base/best.pt` (1.07 GB) and `tokenizer.json`, pinned to revision
`d21a8e314fcd9d68a27766217012c479cdf9cc81`. Each download checks size and SHA256.

Hy-MT and Shisa use the existing llama-server. Imsbee, Opus-MT, and Sugoi use the
Hayai review Python environment. Sugoi needs `ctranslate2` and `sentencepiece`
there. Point `SCAN_TRANSLATION_PYTHON` or `SCAN_REVIEW_PYTHON` at that interpreter
if it is not `.venv-review/bin/python`. Use **Refresh models** after installation.

Managed translators load on demand, serialize requests, keep only one translation
model loaded, and unload after five idle minutes. Each translator uses its saved
compute-device choice, with Auto choosing an available device. `SCAN_TRANSLATION_DEVICE`
can set the Auto choice for GGUF translators (for example `Vulkan2` on a machine
with that device, or `none` for CPU). The PyTorch Korean translator uses its own
CPU/CUDA/ROCm device settings. Changing managed models unloads the previous
translator; the primary Qwen and OCR services are independent.

Optional settings:

```dotenv
SCAN_TRANSLATION_MODELS_DIR=/srv/komatose/data/models/translation
SCAN_TRANSLATION_LLAMA_SERVER=/home/you/llama.cpp/build-vulkan/bin/llama-server
SCAN_TRANSLATION_PYTHON=/srv/komatose/.venv-review/bin/python
SCAN_TRANSLATION_DEVICE=none
SCAN_TRANSLATION_THREADS=8

# SCAN_TRANSLATION_HY_GGUF=/path/to/manga-v5-Q4_K_M.gguf
# SCAN_TRANSLATION_SHISA_GGUF=/path/to/shisa-v2.1-qwen3-8b.Q4_K_M.gguf
# SCAN_TRANSLATION_SUGOI_CKPT=/path/to/sugoi/model.bin
# SCAN_TRANSLATION_KOEN_CKPT=/path/to/sentence-base/best.pt

# Or use an existing endpoint:
# SCAN_TRANSLATION_KOEN_URL=http://127.0.0.1:8531/v1
# SCAN_TRANSLATION_KOEN_MODEL=imsbee-ko-en-translator
# SCAN_TRANSLATION_KOEN_API_KEY=
```

The Hy-MT runtime supports the corresponding `SCAN_TRANSLATION_HY_GGUF`, `_URL`,
`_MODEL` and `_API_KEY` overrides. An endpoint URL takes precedence over local weights
and includes the API prefix, normally `/v1`. Credentials stay on the server. Restart
the application after environment changes; downloading weights alone needs no restart.

## Translation behavior

These adapters translate saved source text, one region per request, and return plain
English. They never receive images or the generic JSON-output translation prompt.
Region IDs, original source and geometry are retained; empty source is skipped.
Empty, truncated or invalid output fails without publishing partial region mappings.
The existing job, suggestion, cancellation and revision checks still apply.

A shared Japanese SFX dictionary handles lettering that these models romanize or
miss. If a region's source is a known SFX (punctuation, kana, elongation, and
repeats included), English comes from the dictionary and the model is not called.
When SFX appears inside other text, only the matching terms are appended to that
request's glossary. The full list is never sent. Region cards also show the
dictionary meanings as clickable alternatives. Series glossary words or phrases
that appear in the source show as chips (not buttons): source → locked English,
with a warning tint when the current draft does not use that English.

Hy-MT manga v5 uses the publisher's terminology block with the series glossary, its native
Japanese-to-English instruction, and recommended sampling (`temperature=0.15`,
`top_k=20`, `top_p=0.6`, `min_p=0`, `repeat_penalty=1.05`). Korean input is rejected.
Stock Hy-MT2 1.8B and 7B support Japanese and Korean and use Tencent's own instruction and sampling (`temperature=0.7`,
`top_k=20`, `top_p=0.8`, `repeat_penalty=1.05`), with the glossary in that model's
terminology block. CAT-Translate uses CyberAgent's instruction, `Translate the following Japanese text into English. Output only the translation`, and the source line, decoded greedily. Without that second sentence, short lines repeat until the output limit. A glossary ahead of the instruction makes it repeat the instruction instead of translating. TranslateGemma sends the source line alone and is decoded greedily. llama.cpp
cannot compile Google's template, so the server uses
[translategemma-ja-en.jinja](../ocr/translategemma-ja-en.jinja), which emits the
same instruction from a plain user string, with Japanese (`ja`) or Korean (`ko`) selected per request. The server can switch chapter languages without reloading the model. Korean OCR that puts each Hangul syllable on its own line is joined before translation; the saved transcription is preserved.
Shisa is a Qwen3 chat model, so it gets a system message that forbids extra
scene-writing, tight sampling (`temperature=0.15`, `top_k=20`, `top_p=0.6`), and
a 96-token cap. llama-server applies the Qwen3 chat template with `--reasoning off`.
Sugoi and Opus-MT send the source text
alone: Sugoi decodes with CTranslate2 beam size 5. Imsbee uses the publisher's greedy
sentence decoder (`target_lang=en`, 128 new tokens per sentence) and the official
subtitle-dash cleanup. It does not take scene notes or the series glossary in its
native format, and none of these specialists receive the general translator's full
chapter context.

These are translation-only choices. Vision, source review (except Hayai and
Paddle English), proofreading and chat retain their own models.
**Suggest alternative** can obtain a fresh translation from a specialist; it
does not ask that specialist to generate an additional editorial list of
paraphrases. **Revise English** is the place to compare several wordings. The council is
chosen in **AI model settings → Revise English** (up to five translators). Until
that list is saved, it is the translation model plus the proofreading model when
that is a different text translator. Hy-MT samples three temperatures in one
request; the other council translators run once with in-line glossary terms and
nearby lines. Hayai and PaddleOCR-VL transcription disagreement hints, region
OCR, fill-missing suggestion English, and AI Review of those two recognizers
use this same selected Translation model. Qwen3-VL-8B remains a vision reviewer
and is no longer the OCR English translator.

Full prompts, results and available token usage are recorded in the existing job log.
Managed process logs are `data/logs/translation-<model-id>.log`.

## Validation

```bash
npm run test:translation-models
npm run test:revise-english
npm test
npm run test:review-workflow
node scripts/test-browser.mjs scripts/check-browser-models.mjs
node --import tsx scripts/smoke-translation-models.ts hy-mt2-manga-v5
node --import tsx scripts/smoke-translation-models.ts imsbee-ko-en-translator
```

The smoke test uses a temporary database and never modifies chapter text. On 9 October
2026, stock HY-MT2 1.8B/7B and TranslateGemma 4B/12B passed five Korean controls
(short dialogue, a medical sentence, multiline dialogue and stacked Hangul) and
two Japanese controls with real local inference. Hy-MT manga v5 was
tested with real local inference on two Japanese samples, including glossary terms.
Imsbee's adapter is covered by fixtures; run the smoke test after installing the
checkpoint to check real Korean inference. Smoke output establishes working
inference, not broad translation-quality evaluation.

The shared registry is [translationModels.json](../src/lib/translationModels.json).
Runtime management lives in [translationRuntime.ts](../src/lib/server/translationRuntime.ts),
and native translation requests/results in
[specialistTranslation.ts](../src/lib/server/specialistTranslation.ts).
The Korean worker is [ko_en_translate.py](../ocr/ko_en_translate.py). The Sugoi
worker is [sugoi_translate.py](../ocr/sugoi_translate.py).

Repeat Korean inference checks with `node --import tsx scripts/smoke-translation-models.ts hy-mt2-1.8b-q4 korean` (substitute the 7B or either TranslateGemma ID). The optional third argument also accepts `japanese`.

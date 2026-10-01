#!/usr/bin/env python3
"""Loopback Korean→English service for Imsbee/ko-en-translator sentence-base."""
import argparse
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

OCR_DIR = Path(__file__).resolve().parent
if str(OCR_DIR) not in sys.path:
    sys.path.insert(0, str(OCR_DIR))

_SENT_SPLIT = re.compile(r"(?<=[.!?。…？！])\s+")
_DASH_SPLIT = re.compile(r"\s*[-–—]\s+")
_HANGUL = re.compile(r"[\uac00-\ud7af]")
_HANGUL_RUN = re.compile(r"[\uac00-\ud7af]+")
_ENGLISH_WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")
_PARTICLES = set("은는이가를을의에도만와과로고야아요다")
# sentence-base was trained at 128 tokens; keep a margin for the direction tag + EOS.
_MAX_SENTENCE_TOKENS = 96


def join_ocr_lines(text: str) -> str:
    """Rebuild one sentence from manga/OCR wraps. Newlines are not sentence breaks."""
    lines = [re.sub(r"[ \t\u00a0]+", " ", line).strip() for line in text.splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return text.strip()
    hangul_lines = [line for line in lines if _HANGUL.search(line)]
    syllabic = len(hangul_lines) >= 3 and all(len(_HANGUL.findall(line)) <= 2 for line in hangul_lines)
    return re.sub(r" {2,}", " ", ("" if syllabic else " ").join(lines)).strip()


def split_sentences(text: str) -> list[str]:
    prepared = join_ocr_lines(text)
    if not prepared:
        return []
    parts = [part.strip() for part in _SENT_SPLIT.split(prepared) if part.strip()]
    return parts or [prepared]


def sentences_for_decode(text: str, token_count=None) -> list[str]:
    """Prefer one decode per bubble. Split only when the source would overflow the window."""
    prepared = join_ocr_lines(text)
    if not prepared:
        return []
    if token_count is None or token_count(prepared) <= _MAX_SENTENCE_TOKENS:
        return [prepared]
    return split_sentences(prepared)


def _token_name(tokenizer, idx: int) -> str:
    return tokenizer.id_to_token(idx) or ""


def continuation_tokens(tokenizer, text: str) -> int:
    count = 0
    for idx in tokenizer.encode(text).ids:
        name = _token_name(tokenizer, idx)
        if name.startswith("Ġ") or name.startswith("<") or name in ".!?,;:~…·'\"-—–？！。":
            continue
        count += 1
    return count


def _one_vocab_word(tokenizer, piece: str) -> bool:
    ids = tokenizer.encode(piece).ids
    return len(ids) == 1 and _token_name(tokenizer, ids[0]).startswith("Ġ")


def respace_hangul_run(tokenizer, run: str) -> str:
    """Insert missing Korean word spaces when BPE had to glue a noun onto the previous word."""
    if len(run) < 4 or continuation_tokens(tokenizer, run) == 0:
        return run
    chunks: list[str] = []
    index = 0
    while index < len(run):
        found = None
        for end in range(min(len(run), index + 10), index, -1):
            if _one_vocab_word(tokenizer, run[index:end]):
                found = end
                break
        if found is None:
            found = index + 1
        chunks.append(run[index:found])
        index = found
    merged: list[str] = []
    for chunk in chunks:
        if merged and chunk in _PARTICLES:
            merged[-1] += chunk
        else:
            merged.append(chunk)
    spaced = " ".join(merged)
    if continuation_tokens(tokenizer, spaced) < continuation_tokens(tokenizer, run):
        return spaced
    return run


def respace_hangul(tokenizer, text: str) -> str:
    return _HANGUL_RUN.sub(lambda match: respace_hangul_run(tokenizer, match.group(0)), text)


def collapsed_short_translation(source: str, english: str) -> bool:
    """Greedy often emits 'I'll tell you.' for a full Korean clause."""
    return len(_HANGUL.findall(source)) >= 6 and len(_ENGLISH_WORD.findall(english)) <= 3


def translate_korean(model, tokenizer, device, source: str, greedy_fn, beam_fn, max_new: int = 128) -> str:
    from ko_en.tokenizer import encode

    def token_count(text: str) -> int:
        return len(encode(tokenizer, text, add_eos=True)) + 1

    outs = []
    for sent in sentences_for_decode(source, token_count):
        prepared = respace_hangul(tokenizer, sent)
        english = greedy_fn(model, tokenizer, prepared, device, target_lang="en", max_new=max_new)
        if collapsed_short_translation(prepared, english):
            english = beam_fn(
                model, tokenizer, prepared, device, target_lang="en", max_new=min(max_new, 64),
            )
        outs.append(clean_subtitle_artifacts(sent, english).strip())
    return " ".join(part for part in outs if part)


def clean_subtitle_artifacts(source: str, output: str) -> str:
    if not re.match(r"\s*[-–—]", output) or re.match(r"\s*[-–—]", source):
        return output
    parts = [p.strip() for p in _DASH_SPLIT.split(output) if p.strip()]
    deduped: list[str] = []
    for part in parts:
        if not deduped or deduped[-1] != part:
            deduped.append(part)
    return " ".join(deduped)


def last_user_text(payload: dict) -> str:
    for message in reversed(payload.get("messages") or []):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            texts = [item.get("text", "") for item in content if isinstance(item, dict)]
            joined = "\n".join(part for part in texts if part).strip()
            if joined:
                return joined
    return (payload.get("text") or "").strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--checkpoint", default="")
    parser.add_argument("--tokenizer", default="")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--max-new", type=int, default=128)
    args = parser.parse_args()
    model_dir = Path(args.model_dir)
    checkpoint = Path(args.checkpoint or model_dir / "sentence-base/best.pt")
    tokenizer_path = Path(args.tokenizer or model_dir / "tokenizer.json")
    if args.device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        os.environ["HIP_VISIBLE_DEVICES"] = ""
    import torch
    from ko_en.minrnn import MinRNNConfig, MinRNNSeq2Seq
    from ko_en.model import ModelConfig, Seq2SeqTransformer
    from ko_en.tokenizer import load_tokenizer
    from ko_en.translate_runtime import beam_translate, greedy_translate

    device = "cpu" if args.device in ("cpu", "none", "") else args.device
    torch.set_num_threads(max(1, args.threads))
    torch.set_num_interop_threads(1)
    ckpt = torch.load(checkpoint, map_location=device, weights_only=False)
    if ckpt.get("arch") == "minrnn":
        model = MinRNNSeq2Seq(MinRNNConfig(**ckpt["config"])).to(device)
    else:
        model = Seq2SeqTransformer(ModelConfig(**ckpt["config"])).to(device)
    model.load_state_dict(ckpt["model"])
    model.eval()
    tokenizer = load_tokenizer(tokenizer_path)

    def translate_text(source: str) -> str:
        return translate_korean(
            model, tokenizer, device, source,
            greedy_fn=greedy_translate, beam_fn=beam_translate, max_new=args.max_new,
        )

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *rest):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % rest))

        def reply(self, status, data):
            body = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            if self.headers.get("Authorization") != f"Bearer {args.token}":
                self.reply(401, {"error": "Unauthorized"})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            if self.path == "/health":
                self.reply(200, {"model": "imsbee-ko-en-translator", "device": device})
                return
            self.reply(404, {"error": "not found"})

        def do_POST(self):
            if not self.authorized():
                return
            try:
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= 1024 * 1024:
                    self.reply(400, {"error": "Invalid translation request"})
                    return
                payload = json.loads(self.rfile.read(size))
                source = last_user_text(payload)
                if not source:
                    self.reply(400, {"error": "required: text"})
                    return
                with torch.inference_mode():
                    translation = translate_text(source)
                if self.path in ("/translate", "/v1/chat/completions"):
                    self.reply(200, {
                        "translation": translation,
                        "choices": [{"finish_reason": "stop", "message": {"content": translation}}],
                    })
                    return
                self.reply(404, {"error": "not found"})
            except Exception as error:
                self.reply(500, {"error": str(error)})

    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

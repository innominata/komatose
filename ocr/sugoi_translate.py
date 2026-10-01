#!/usr/bin/env python3
"""Loopback Japanese→English service for Sugoi v4 (CTranslate2)."""
import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def ctranslate2_device(requested: str) -> str:
    """CTranslate2's pip wheel is NVIDIA CUDA. PyTorch may see a GPU this build cannot use."""
    if requested in ("cpu", "none", ""):
        return "cpu"
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception:
        pass
    return "cpu"


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
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--max-new", type=int, default=256)
    args = parser.parse_args()
    model_dir = Path(args.model_dir)
    import ctranslate2
    import sentencepiece

    device = ctranslate2_device(args.device)
    if device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        os.environ["HIP_VISIBLE_DEVICES"] = ""
        if args.device not in ("cpu", "none", ""):
            print("CTranslate2 has no usable CUDA device; using CPU", flush=True)

    threads = max(1, args.threads)
    translator = ctranslate2.Translator(
        str(model_dir),
        device=device,
        inter_threads=1,
        intra_threads=threads,
    )
    source_spm = sentencepiece.SentencePieceProcessor(model_file=str(model_dir / "spm" / "spm.ja.nopretok.model"))
    target_spm = sentencepiece.SentencePieceProcessor(model_file=str(model_dir / "spm" / "spm.en.nopretok.model"))

    def translate_text(source: str) -> str:
        text = source.strip()
        if not text:
            return ""
        tokens = source_spm.encode(text, out_type=str)
        result = translator.translate_batch(
            [tokens],
            beam_size=5,
            max_decoding_length=max(1, args.max_new),
        )
        return target_spm.decode(result[0].hypotheses[0]).replace("<unk>", "").strip()

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
                self.reply(200, {"model": "sugoi-v4-ja-en", "device": device})
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

    print(f"Sugoi v4 ja→en ready on {device}", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

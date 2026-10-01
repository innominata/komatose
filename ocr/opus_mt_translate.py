#!/usr/bin/env python3
"""Loopback Japanese→English service for Helsinki-NLP/opus-mt-ja-en."""
import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


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
    os.environ["HF_HOME"] = str(model_dir.parent / "hf-cache")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    if args.device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        os.environ["HIP_VISIBLE_DEVICES"] = ""
    import torch
    from transformers import MarianConfig, MarianMTModel, MarianTokenizer

    device = "cpu" if args.device in ("cpu", "none", "") else args.device
    torch.set_num_threads(max(1, args.threads))
    torch.set_num_interop_threads(1)
    tokenizer = MarianTokenizer.from_pretrained(model_dir, local_files_only=True)
    checkpoint = Path(args.checkpoint) if args.checkpoint else model_dir / "pytorch_model.bin"
    # A SCAN_TRANSLATION_OPUS_JAEN_CKPT override keeps the installed config and tokenizer.
    if checkpoint.resolve() == (model_dir / "pytorch_model.bin").resolve():
        model = MarianMTModel.from_pretrained(model_dir, local_files_only=True)
    else:
        model = MarianMTModel(MarianConfig.from_pretrained(model_dir, local_files_only=True))
        model.load_state_dict(torch.load(checkpoint, map_location="cpu", weights_only=True), strict=False)
        model.tie_weights()
    model = model.to(device).eval()

    def translate_text(source: str) -> str:
        text = source.strip()
        if not text:
            return ""
        encoded = tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
        encoded = {key: value.to(device) for key, value in encoded.items()}
        with torch.inference_mode():
            ids = model.generate(**encoded, max_new_tokens=args.max_new, num_beams=1)[0]
        return tokenizer.decode(ids, skip_special_tokens=True).strip()

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
                self.reply(200, {"model": "opus-mt-ja-en", "device": device})
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

    print(f"Opus-MT ja→en ready on {device}", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

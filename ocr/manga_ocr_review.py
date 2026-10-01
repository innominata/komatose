#!/usr/bin/env python3
"""Loopback-only mayocream/manga-ocr inference for the review worker."""
import argparse
import base64
import io
import json
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def post_process(text: str) -> str:
    text = "".join(text.split())
    text = text.replace("…", "...")
    text = re.sub("[・.]{2,}", lambda match: (match.end() - match.start()) * ".", text)
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--device", default="cpu")
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
    from PIL import Image
    from transformers import AutoImageProcessor, AutoTokenizer, VisionEncoderDecoderModel

    device = args.device
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    model = VisionEncoderDecoderModel.from_pretrained(model_dir, local_files_only=True).to(device).eval()
    processor = AutoImageProcessor.from_pretrained(model_dir, local_files_only=True)
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)

    class Handler(BaseHTTPRequestHandler):
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
            if self.authorized():
                self.reply(200 if self.path == "/health" else 404,
                           {"model": "manga-ocr", "device": device})

        def do_POST(self):
            if not self.authorized():
                return
            try:
                size = int(self.headers.get("Content-Length", 0))
                if self.path != "/ocr" or not 0 < size <= 32 * 1024**2:
                    self.reply(400, {"error": "Invalid OCR request"})
                    return
                req = json.loads(self.rfile.read(size))
                image = Image.open(io.BytesIO(base64.b64decode(req["image"], validate=True)))
                image = image.convert("L").convert("RGB")
                if image.width * image.height > 20_000_000:
                    raise ValueError("Crop exceeds 20 megapixels")
                pixels = processor(image, return_tensors="pt").pixel_values.to(device)
                with torch.inference_mode():
                    ids = model.generate(pixels, max_length=300)[0].cpu()
                text = post_process(tokenizer.decode(ids, skip_special_tokens=True))
                self.reply(200, {"source": text})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                self.reply(500, {"error": str(exc)[:1000]})

    print(f"Manga OCR ready on {device}", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

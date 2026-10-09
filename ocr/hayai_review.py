#!/usr/bin/env python3
"""Loopback-only Hayai OCR v2 inference for the review worker."""
import argparse
import base64
import io
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def _to_device(value, device):
    if hasattr(value, "to"):
        return value.to(device)
    if isinstance(value, dict):
        return {key: _to_device(item, device) for key, item in value.items()}
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--model-id", choices=["hayai-ocr-v2", "hayai-ocr-v2.5-nova"], default="hayai-ocr-v2")
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
    from transformers import AutoModel, AutoProcessor, PreTrainedTokenizerFast

    device = args.device
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    if args.model_id.endswith("nova"):
        model, loading = AutoModel.from_pretrained(model_dir, trust_remote_code=True,
                                                   local_files_only=True, output_loading_info=True)
        missing = [key for key in loading.get("missing_keys", []) if key.startswith("vision_encoder.")]
        if missing:
            raise RuntimeError("Nova vision weights did not load; check Transformers/checkpoint compatibility: " + ", ".join(missing[:5]))
        model = model.to(device).eval()
    else:
        model = AutoModel.from_pretrained(model_dir, trust_remote_code=True,
                                          local_files_only=True).to(device).eval()
    tokenizer = PreTrainedTokenizerFast.from_pretrained(model_dir, local_files_only=True)
    processor = AutoProcessor.from_pretrained("google/siglip2-base-patch16-naflex",
                                              local_files_only=True)

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
                           {"model": args.model_id, "device": device})

        def do_POST(self):
            if not self.authorized():
                return
            try:
                size = int(self.headers.get("Content-Length", 0))
                if self.path != "/ocr" or not 0 < size <= 32 * 1024**2:
                    self.reply(400, {"error": "Invalid OCR request"})
                    return
                req = json.loads(self.rfile.read(size))
                image = Image.open(io.BytesIO(base64.b64decode(req["image"], validate=True))).convert("RGB")
                if image.width * image.height > 20_000_000:
                    raise ValueError("Crop exceeds 20 megapixels")
                inputs = _to_device(processor(images=[image], max_num_patches=512, return_tensors="pt"), device)
                with torch.inference_mode():
                    output = model.generate(**inputs, tokenizer=tokenizer,
                                            max_new_tokens=512, num_beams=1,
                                            **({"repetition_penalty": 1.0} if args.model_id.endswith("nova") else {}))
                self.reply(200, {"source": output[0].strip()})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                self.reply(500, {"error": str(exc)[:1000]})

    print(f"{args.model_id} ready on {device}", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

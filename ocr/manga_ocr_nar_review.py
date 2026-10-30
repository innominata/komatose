#!/usr/bin/env python3
"""Loopback-only muscgab/manga-ocr-nar-small inference for the review worker."""
import argparse
import base64
import io
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    model_dir = Path(args.model_dir)
    if args.device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        os.environ["HIP_VISIBLE_DEVICES"] = ""
    else:
        from rocm_idle import arm_rocm_blocking_sync
        arm_rocm_blocking_sync()
    import numpy as np
    import torch
    from PIL import Image

    # The inference package ships with the weights; it is pinned and hash-checked by the installer.
    sys.path.insert(0, str(model_dir))
    from manga_ocr_nar_small.model import MangaOcrNarSmallNet
    from manga_ocr_nar_small.preprocess import empty_inputs, preprocess
    from manga_ocr_nar_small.vocab import Vocab

    device = args.device
    # One thread reads a crop in ~70 ms on CPU; 2-8 threads measured 5-30x slower on this small net.
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    vocab = Vocab(model_dir / "nar_vocabulary_6817.json")
    if device == "cpu":
        net = MangaOcrNarSmallNet.load(model_dir, torch.device("cpu"), torch.float32)
        buf = empty_inputs()

        def read_ids(image):
            preprocess(image, buf)
            tensors = [torch.from_numpy(buf["P"])[None], torch.from_numpy(buf["V"]).bool()[None],
                       *(torch.from_numpy(buf[key]).long()[None] for key in ("R", "C")),
                       *(torch.from_numpy(buf[key]).long() for key in ("H", "W"))]
            with torch.inference_mode():
                return net(*tensors).numpy()
    else:
        from manga_ocr_nar_small.backends.cuda import CudaBackend
        # Requests carry one crop, so one captured graph is enough.
        backend = CudaBackend(model_dir, device=device, fp16=True, buckets=(1,), threads=1)

        def read_ids(image):
            return backend.ids([np.asarray(image, np.uint8)])

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
                           {"model": "manga-ocr-nar-small", "device": device})

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
                text = vocab.decode(read_ids(image).tolist())[0]
                self.reply(200, {"source": text.strip()})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                self.reply(500, {"error": str(exc)[:1000]})

    print(f"Manga OCR NAR Small ready on {device}", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

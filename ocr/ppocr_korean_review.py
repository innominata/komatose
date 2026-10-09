#!/usr/bin/env python3
"""Local Korean PP-OCRv5 crop recognition; CPU PaddlePaddle needs no AMD GPU support."""
import argparse
import base64
import io
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def build_recognizer(model_dir, threads=8):
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(Path(model_dir).parent / "paddlex-cache"))
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ["HIP_VISIBLE_DEVICES"] = ""
    from paddleocr import PaddleOCR
    return PaddleOCR(
        text_detection_model_name="PP-OCRv5_server_det",
        text_detection_model_dir=str(Path(model_dir) / "detector"),
        text_recognition_model_name="korean_PP-OCRv5_mobile_rec",
        text_recognition_model_dir=str(Path(model_dir) / "recognizer"),
        use_doc_orientation_classify=False, use_doc_unwarping=False,
        use_textline_orientation=False, device="cpu", cpu_threads=threads,
    )


def recognize(model, image):
    import numpy as np
    from worker import _upscaled
    texts, scores = [], []
    # Match the existing OCR worker's bounded upscale for small webtoon crops.
    # Paddle's ndarray reader expects BGR, unlike Pillow's RGB representation.
    pixels = np.ascontiguousarray(np.asarray(image.convert("RGB"))[:, :, ::-1])
    for result in model.predict(_upscaled(pixels, "auto")):
        # Paddle's OCRResult is mapping-like. Its arrays must not be coerced to bool.
        result_texts = result.get("rec_texts", [])
        result_scores = result.get("rec_scores", [])
        for index, text in enumerate(result_texts):
            if str(text).strip():
                texts.append(str(text).strip())
                if index < len(result_scores):
                    scores.append(float(result_scores[index]))
    return {"source": "\n".join(texts), "confidence": min(scores) if scores else None}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--device", choices=["cpu"], default="cpu")
    args = parser.parse_args()
    from PIL import Image
    model = build_recognizer(args.model_dir, args.threads)

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
                           {"model": "pp-ocrv5-korean", "device": "cpu"})

        def do_POST(self):
            if not self.authorized():
                return
            try:
                size = int(self.headers.get("Content-Length", 0))
                if self.path != "/ocr" or not 0 < size <= 32 * 1024**2:
                    self.reply(400, {"error": "Invalid OCR request"})
                    return
                request = json.loads(self.rfile.read(size))
                if request.get("language") not in (None, "korean"):
                    self.reply(400, {"error": "PP-OCRv5 Korean supports Korean chapters only"})
                    return
                image = Image.open(io.BytesIO(base64.b64decode(request["image"], validate=True)))
                if image.width * image.height > 20_000_000:
                    raise ValueError("Crop exceeds 20 megapixels")
                self.reply(200, recognize(model, image))
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                self.reply(500, {"error": str(exc)[:1000]})

    print("PP-OCRv5 Korean ready on CPU", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

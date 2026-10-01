#!/usr/bin/env python3
"""Install the Qwen-Image-2.1 Q8 GGUF used as the local artwork-cleaning editor.

Three weights drive stable-diffusion.cpp: the Q8_0 diffusion model, the
Qwen-Image-2.1 VAE, and a Qwen3-VL-8B text encoder (plus its vision projector
for prompt/image understanding). The text encoder is shared with the AI Review
installer so it is only downloaded once; pass --with-text-encoder to keep a
private copy inside the image model directory instead.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import time

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
from huggingface_hub import hf_hub_download  # noqa: E402

DIFFUSION = {
    "repo": "leejet/Qwen-Image-2.1-GGUF",
    "revision": "cc11433936a06e9765f7c0c0b1f0436cfd2b9856",
}
VAE = {
    "repo": "gguf-org/qwen-image-2.1-gguf",
    "revision": "b65a2a46d9ca53c7ca34ee063a8c6a506c77fec2",
}
TEXT_ENCODER = {
    "repo": "unsloth/Qwen3-VL-8B-Instruct-GGUF",
    "revision": "b93a7ee713758252c555be4210c00540df954dc2",
}

# Quantizations of the diffusion transformer. Q8_0 is the default; the smaller
# ones exist so a card that already runs a chat model can still host cleaning.
QUANTS = {
    "q8": ("qwen_image_2.1-Q8_0.gguf", 7687155744,
           "f8b244b00937f0e444a40dbf7866460871b89b30142594973b6012d1b471dc0a", 8.4),
    "q6": ("qwen_image_2.1-Q6_K.gguf", 5996851232,
           "1c51d1a8e6cf2b215719dea0c4f0f4cbfff9214a1c7571e57913f57d6a9c3c12", 6.7),
    "q5": ("qwen_image_2.1-Q5_0.gguf", 5069910048,
           "8dfeb1ee091a5d7c7d8191f69723254f031de8fe67ec219a21bf7df57590ab43", 5.7),
}
VAE_FILE = ("pig_qwen_image_2.1_vae_fp32-f16.gguf", 675659072,
            "b75d3208bc2ba5a8ce23af00aed6619d661615b4aa9363544ac68728971ef10e", 0.7)
TEXT_ENCODER_FILE = ("Qwen3-VL-8B-Instruct-Q8_0.gguf", 8709520224,
                     "cb8616bf6ed228982d9e47d7b72b42195342efa26044b0ee1873e61d9e78d3d7", 8.6)
MMPROJ_FILE = ("mmproj-F16.gguf", 1159030336,
               "d406d03ebabefdef86a2c86bf0c1b65f9e046f7a81c218f25de4931b46a07fc4", 0.8)


def review_encoder_dir():
    return Path(os.environ.get("SCAN_REVIEW_MODELS_DIR")
                or (ROOT / "data/models/review")) / "qwen3-vl-8b"


def default_dest():
    return Path(os.environ.get("SCAN_IMAGE_MODELS_DIR")
                or (ROOT / "data/models/image")) / "qwen-image-2.1"


def retry(operation):
    for attempt in range(8):
        try:
            return operation()
        except Exception as exc:
            if attempt == 7:
                raise
            pause = min(30, 2 ** (attempt + 1))
            print(f"Download service unavailable ({type(exc).__name__}); retrying in {pause}s", flush=True)
            time.sleep(pause)


def verified(path, size, sha256):
    if not path.is_file():
        return False
    if size and path.stat().st_size != size:
        return False
    if not sha256:
        return True
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == sha256


def install_file(dest, repo, revision, filename, size, sha256):
    path = dest / filename
    if verified(path, size, sha256):
        print(f"Already verified {filename}", flush=True)
        return
    dest.mkdir(parents=True, exist_ok=True)
    needed = (size or 512 * 1024**2) + 256 * 1024**2
    if shutil.disk_usage(dest).free < needed:
        raise SystemExit(f"At least {needed / 1024**3:.1f} GiB free is required for {filename}.")
    print(f"Downloading {repo}/{filename}@{revision}", flush=True)
    retry(lambda: hf_hub_download(repo_id=repo, filename=filename, revision=revision,
                                  local_dir=str(dest)))
    if not verified(path, size, sha256):
        raise SystemExit(f"Size or SHA256 verification failed for {filename}")
    print(f"Verified {filename}", flush=True)


def text_encoder(dest, private):
    """Qwen3-VL-8B drives the prompt and reference image; reuse the review copy."""
    encoder = dest if private else review_encoder_dir()
    if encoder.is_dir() and not private:
        have = [name for name, *_ in (TEXT_ENCODER_FILE, MMPROJ_FILE) if (encoder / name).is_file()]
        if len(have) == 2:
            print(f"Reusing the shared Qwen3-VL-8B text encoder at {encoder}", flush=True)
            return encoder
        print(f"Shared text encoder at {encoder} is incomplete; downloading a private copy", flush=True)
        encoder = dest
    for filename, size, sha256, _gib in (TEXT_ENCODER_FILE, MMPROJ_FILE):
        install_file(encoder, TEXT_ENCODER["repo"], TEXT_ENCODER["revision"], filename, size, sha256)
    return encoder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quant", choices=["q8", "q6", "q5"], default="q8",
                        help="Diffusion transformer quantization (default q8).")
    parser.add_argument("--dest", type=Path, default=default_dest())
    parser.add_argument("--with-text-encoder", action="store_true",
                        help="Keep a private Qwen3-VL-8B copy instead of sharing the review copy.")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    dest = args.dest.expanduser().resolve()
    filename, size, sha256, gib = QUANTS[args.quant]
    if args.verify_only:
        missing = [name for name, spec in (
            (filename, (size, sha256)),
            (VAE_FILE[0], (VAE_FILE[1], VAE_FILE[2])),
        ) if not verified(dest / name, *spec)]
        if missing:
            raise SystemExit("Not installed or checksum mismatch: " + ", ".join(missing))
        print(f"Verified {dest}", flush=True)
        return

    need = gib + VAE_FILE[3] + (TEXT_ENCODER_FILE[3] + MMPROJ_FILE[3] if args.with_text_encoder else 0)
    if shutil.disk_usage(dest.parent if dest.parent.is_dir() else dest.parent.parent).free < need * 1024**3:
        raise SystemExit(f"At least {need:.1f} GiB free is required for Qwen-Image-2.1 ({args.quant}).")

    install_file(dest, DIFFUSION["repo"], DIFFUSION["revision"], filename, size, sha256)
    install_file(dest, VAE["repo"], VAE["revision"], VAE_FILE[0], VAE_FILE[1], VAE_FILE[2])
    encoder = text_encoder(dest, args.with_text_encoder)

    marker = dest / "installed.json"
    marker.write_text(json.dumps({
        "model": "Qwen-Image-2.1",
        "quant": args.quant,
        "diffusion": {"repo": DIFFUSION["repo"], "revision": DIFFUSION["revision"],
                      "file": filename, "bytes": size, "sha256": sha256},
        "vae": {"repo": VAE["repo"], "revision": VAE["revision"],
                "file": VAE_FILE[0], "bytes": VAE_FILE[1], "sha256": VAE_FILE[2]},
        "textEncoder": {"repo": TEXT_ENCODER["repo"], "revision": TEXT_ENCODER["revision"],
                        "dir": str(encoder), "shared": not args.with_text_encoder},
    }, indent=2) + "\n")
    print(f"Installed and verified Qwen-Image-2.1 {args.quant} in {dest}", flush=True)


if __name__ == "__main__":
    main()

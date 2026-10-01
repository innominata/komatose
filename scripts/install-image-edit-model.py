#!/usr/bin/env python3
"""Install the Qwen-Image-Edit-2511 GGUF used as the local artwork editor.

Qwen-Image-Edit is an instruction editor trained on the Qwen-Image family rather
than the 7B Qwen-Image-2.1 the cleaner defaults to, so it needs its own text
encoder (Qwen2.5-VL-7B, not Qwen3-VL-8B) and the original Qwen-Image VAE rather
than the 2.1 VAE. Three weights drive stable-diffusion.cpp: the diffusion
transformer, that VAE, and the text encoder plus its vision projector.

Qwen-Image-Edit 2511 also needs `--model-args qwen_image_zero_cond_t=true` at
launch; without it stable-diffusion.cpp degrades edits badly.
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
    "repo": "unsloth/Qwen-Image-Edit-2511-GGUF",
    "revision": "0d33d9692b4b26212297240d87b0d4719aa4fd06",
}
VAE = {
    "repo": "QuantStack/Qwen-Image-Edit-GGUF",
    "revision": "acab6f9f09973bc8a128a1e04e809acb65784e1c",
}
TEXT_ENCODER = {
    "repo": "mradermacher/Qwen2.5-VL-7B-Instruct-GGUF",
    "revision": "cfa2baa09946b211c107e6e104948987a64dd2c1",
}

# Quantizations of the 20B diffusion transformer. Q4_K_M is the usual pick for a
# 24 GiB card shared with the text encoder; Q4_K_S buys a little headroom.
QUANTS = {
    "q4_k_m": ("qwen-image-edit-2511-Q4_K_M.gguf", 13244758624,
               "8677bac90627adbbc11efab87b1870e701c4eb3689ee865a3de8ab81b705a723", 12.3),
    "q4_k_s": ("qwen-image-edit-2511-Q4_K_S.gguf", 12410747488,
               "df952ef0d2b46463bd95d9afbb78e045ec5412316f453a7ad5a3d7bcbb111b72", 11.6),
    "q4_0": ("qwen-image-edit-2511-Q4_0.gguf", 11852773984,
             "4b537c1e238f315fb4774e3ae677037b3d8bfde3e50a95d0b0a68dd9597b4f82", 11.0),
    "q5_k_s": ("qwen-image-edit-2511-Q5_K_S.gguf", 14325611104,
               "439a8da6093c338f52ff906058c35338989669922b9d69a9c3abd23f5a67551b", 13.3),
}
# The transformer is 20B and its text encoder is a separate 7B, so the encoder quant
# decides whether both fit a shared card. Q5 keeps edits accurate without crowding out
# the diffusion weights and their activations.
ENCODERS = {
    "q4": ("Qwen2.5-VL-7B-Instruct.Q4_K_M.gguf", 4683072512,
           "0f00a930ba3108b6861ddadf74d8ebbd82e257c63eba728e62c3e8970f5eed94", 4.4),
    "q5": ("Qwen2.5-VL-7B-Instruct.Q5_K_M.gguf", 5444830208,
           "993112f189a95ee82e01e993a3f1768c015d4fe70ec493ecf1b8f3f838a48b63", 5.1),
    "q6": ("Qwen2.5-VL-7B-Instruct.Q6_K.gguf", 6254197760,
           "931c299341eb3b720002dc6347ac76650eb19fd5628695b64df3997d3e21fcff", 5.8),
    "q8": ("Qwen2.5-VL-7B-Instruct.Q8_0.gguf", 8098524160,
           "577bfb3e41f93f00414e594c56a38bbe91207b3b636ab7faf343e34a20aa73ca", 8.2),
}
MMPROJ_FILE = ("Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf", 1354162912,
               "2f9b49529bf463c165223e21f10320655a74da61bb64bf7b9fa8b3892cc46926", 1.3)
# stored under this subdirectory of the model dir, as it is in the source repo
VAE_FILE = ("VAE/Qwen_Image-VAE.safetensors", 253806246,
            "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f", 0.3)


def default_dest():
    return Path(os.environ.get("SCAN_IMAGE_MODELS_DIR")
                or (ROOT / "data/models/image")) / "qwen-image-edit-2511"


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quant", choices=sorted(QUANTS), default="q4_k_m",
                        help="Diffusion transformer quantization (default q4_k_m).")
    parser.add_argument("--encoder", choices=sorted(ENCODERS), default="q5",
                        help="Qwen2.5-VL-7B text encoder quantization (default q5).")
    parser.add_argument("--dest", type=Path, default=default_dest())
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    dest = args.dest.expanduser().resolve()
    filename, size, sha256, gib = QUANTS[args.quant]
    encoder_file, encoder_size, encoder_sha, encoder_gib = ENCODERS[args.encoder]
    if args.verify_only:
        missing = [name for name, spec in (
            (filename, (size, sha256)),
            (VAE_FILE[0], (VAE_FILE[1], VAE_FILE[2])),
            (encoder_file, (encoder_size, encoder_sha)),
            (MMPROJ_FILE[0], (MMPROJ_FILE[1], MMPROJ_FILE[2])),
        ) if not verified(dest / name, *spec)]
        if missing:
            raise SystemExit("Not installed or checksum mismatch: " + ", ".join(missing))
        print(f"Verified {dest}", flush=True)
        return

    need = gib + VAE_FILE[3] + encoder_gib + MMPROJ_FILE[3]
    parent = dest.parent if dest.parent.is_dir() else dest.parent.parent
    if shutil.disk_usage(parent).free < need * 1024**3:
        raise SystemExit(f"At least {need:.1f} GiB free is required for Qwen-Image-Edit-2511 ({args.quant}).")

    install_file(dest, DIFFUSION["repo"], DIFFUSION["revision"], filename, size, sha256)
    install_file(dest, VAE["repo"], VAE["revision"], VAE_FILE[0], VAE_FILE[1], VAE_FILE[2])
    # Qwen2.5-VL is not shared with anything else in this app, so it lives here.
    install_file(dest, TEXT_ENCODER["repo"], TEXT_ENCODER["revision"],
                 encoder_file, encoder_size, encoder_sha)
    install_file(dest, TEXT_ENCODER["repo"], TEXT_ENCODER["revision"],
                 MMPROJ_FILE[0], MMPROJ_FILE[1], MMPROJ_FILE[2])

    (dest / "installed.json").write_text(json.dumps({
        "model": "Qwen-Image-Edit-2511",
        "quant": args.quant,
        "diffusion": {"repo": DIFFUSION["repo"], "revision": DIFFUSION["revision"],
                      "file": filename, "bytes": size, "sha256": sha256},
        "vae": {"repo": VAE["repo"], "revision": VAE["revision"],
                "file": VAE_FILE[0], "bytes": VAE_FILE[1], "sha256": VAE_FILE[2]},
        "textEncoder": {"repo": TEXT_ENCODER["repo"], "revision": TEXT_ENCODER["revision"],
                        "file": encoder_file, "bytes": encoder_size, "sha256": encoder_sha,
                        "vision": MMPROJ_FILE[0]},
    }, indent=2) + "\n")
    print(f"Installed and verified Qwen-Image-Edit-2511 {args.quant} in {dest}", flush=True)


if __name__ == "__main__":
    main()

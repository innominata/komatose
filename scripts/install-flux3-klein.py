#!/usr/bin/env python3
"""Install FLUX 3 Image Klein as a local artwork editor for stable-diffusion.cpp.

Downloads the Q8_0 FLUX.3 transformer, the FLUX.2 VAE and the Qwen3-VL 4B text encoder into
data/models/image/flux-3-image-klein, verifies each file, and writes installed.json. The
sd-server binary is the one the Qwen-Image-Edit installer builds (install it first).

The weights are under Black Forest Labs' FLUX Kommunity License. The VAE comes from
Comfy-Org/Flux-2-Klein-4B (Apache-2.0), byte-identical to FLUX 3 Klein's own ae.safetensors.
"""
import importlib.util
import json
import os
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("qwen_installer", HERE / "install-image-edit-model.py")
qwen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qwen)

DIFFUSION = ("leejet/flux-3-image-klein-GGUF", "1c2ad2f9b9247ccca6506a23bdb033fdb0873321",
             "flux3-image-klein-Q8_0.gguf", 6151716032,
             "8b71ffd749bcacbd50cc0acca4f2d31a044c94412743e1e780db99bf13f89752")
VAE = ("Comfy-Org/Flux-2-Klein-4B", "5b3abca5c0dc1ecd4eaf3340868d09063fc1c965",
       "split_files/vae/flux2-vae.safetensors", 336211292,
       "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3")
TEXT_ENCODER = ("Qwen/Qwen3-VL-4B-Instruct-GGUF", "1cd86afb9a95c410a6038ab3b40d8b578c892266",
                "Qwen3VL-4B-Instruct-Q8_0.gguf", 4280406144,
                "054721f478bc5fa6beffb7f38eae575d45298f88cbb8d2f83ef675a727863eb1")


def dest_dir():
    return Path(os.environ.get("SCAN_IMAGE_MODELS_DIR") or (qwen.ROOT / "data/models/image")) / "flux-3-image-klein"


def main():
    dest = dest_dir()
    dest.mkdir(parents=True, exist_ok=True)
    qwen.install_file(dest, *DIFFUSION)
    # The VAE sits in a subdirectory of its repo; keep it beside the other files.
    vae_name = Path(VAE[2]).name
    if qwen.verified(dest / vae_name, VAE[3], VAE[4]):
        print(f"Already verified {vae_name}", flush=True)
    else:
        qwen.install_file(dest, *VAE)
        shutil.move(str(dest / VAE[2]), str(dest / vae_name))
        shutil.rmtree(dest / "split_files", ignore_errors=True)
    qwen.install_file(dest, *TEXT_ENCODER)
    marker = {
        "model": "FLUX-3-Image-Klein",
        "quant": "q8_0",
        "diffusion": {"repo": DIFFUSION[0], "revision": DIFFUSION[1], "file": DIFFUSION[2], "bytes": DIFFUSION[3], "sha256": DIFFUSION[4]},
        "vae": {"repo": VAE[0], "revision": VAE[1], "file": vae_name, "bytes": VAE[3], "sha256": VAE[4]},
        "textEncoder": {"repo": TEXT_ENCODER[0], "revision": TEXT_ENCODER[1], "file": TEXT_ENCODER[2], "bytes": TEXT_ENCODER[3], "sha256": TEXT_ENCODER[4], "vision": ""},
        "license": "FLUX Kommunity License (weights); Apache-2.0 (VAE, encoder)",
    }
    (dest / "installed.json").write_text(json.dumps(marker, indent=2) + "\n")
    print(f"FLUX 3 Image Klein installed in {dest}", flush=True)


if __name__ == "__main__":
    main()

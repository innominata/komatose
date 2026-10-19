#!/usr/bin/env python3
"""Install the Qwen-Image-Edit-2511 GGUF used as the local artwork editor.

Qwen-Image-Edit is an instruction editor trained on the Qwen-Image family rather
than the 7B Qwen-Image-2.1 the cleaner defaults to, so it needs its own text
encoder (Qwen2.5-VL-7B, not Qwen3-VL-8B) and the original Qwen-Image VAE rather
than the 2.1 VAE. Three weights drive stable-diffusion.cpp: the diffusion
transformer, that VAE, and the text encoder plus its vision projector.

Qwen-Image-Edit 2511 also needs `--model-args qwen_image_zero_cond_t=true` at
launch; without it stable-diffusion.cpp degrades edits badly.

The weights are useless without `sd-server`, so this also builds a pinned
stable-diffusion.cpp into data/tools/stable-diffusion.cpp unless
SCAN_IMAGE_SD_SERVER already names a working binary.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
from model_download_deps import require_hub

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
# Q3_K_M and Q2_K install beside it as separate editors (see COMPARE_QUANTS).
QUANTS = {
    "q4_k_m": ("qwen-image-edit-2511-Q4_K_M.gguf", 13244758624,
               "8677bac90627adbbc11efab87b1870e701c4eb3689ee865a3de8ab81b705a723", 12.3),
    "q4_k_s": ("qwen-image-edit-2511-Q4_K_S.gguf", 12410747488,
               "df952ef0d2b46463bd95d9afbb78e045ec5412316f453a7ad5a3d7bcbb111b72", 11.6),
    "q4_0": ("qwen-image-edit-2511-Q4_0.gguf", 11852773984,
             "4b537c1e238f315fb4774e3ae677037b3d8bfde3e50a95d0b0a68dd9597b4f82", 11.0),
    "q3_k_m": ("qwen-image-edit-2511-Q3_K_M.gguf", 9920805472,
               "5631fd3a407880e1fb541dc47696628633c898565136c128d5a2741d4b84e9e9", 9.2),
    "q2_k": ("qwen-image-edit-2511-Q2_K.gguf", 7468022368,
             "a3d09042b64657970654941aa08d895de29b4d98edf3632a89e70d4d6e23c47c", 7.0),
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
# Quants the app lists as their own editors. Each writes its own marker so it can sit
# next to the Q4_K_M install, which keeps installed.json.
COMPARE_QUANTS = {"q3_k_m", "q2_k"}
MMPROJ_FILE = ("Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf", 1354162912,
               "2f9b49529bf463c165223e21f10320655a74da61bb64bf7b9fa8b3892cc46926", 1.3)
# stored under this subdirectory of the model dir, as it is in the source repo
VAE_FILE = ("VAE/Qwen_Image-VAE.safetensors", 253806246,
            "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f", 0.3)
# 8-step distillation. It sits in the LoRA directory and is loaded per request.
LIGHTNING = {
    "repo": "lightx2v/Qwen-Image-Edit-2511-Lightning",
    "revision": "d74eba145674fd7e31b949324e148e21e7118abd",
    "file": "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors",
    "size": 849608296,
    "sha256": "a9e81a58a78f260f67b337a6f615e8fa4cd3bc79847c77b7d61a581b789b1ba8",
}

# Upstream stable-diffusion.cpp with --max-vram, --backend, --model-args and
# Qwen-Image-Edit 2511 support. Bump deliberately; the server flags must still match.
SD_CPP = {
    "repo": "https://github.com/leejet/stable-diffusion.cpp",
    "commit": "b13a48219d5cdf408edcb93da6cd69b612ed03d3",
}
SD_BACKENDS = {
    "vulkan": ["-DSD_VULKAN=ON"],
    "cuda": ["-DSD_CUDA=ON"],
    "rocm": ["-DSD_HIPBLAS=ON"],
    "cpu": [],
}
# Flags src/lib/server/imageEdit.ts passes. A build that lacks one cannot run the editor.
SD_REQUIRED_FLAGS = ("--diffusion-model", "--llm_vision", "--listen-port", "--backend",
                     "--max-vram", "--model-args", "--vae-tiling", "--lora-model-dir")
# Build tools and the Vulkan SDK headers, per package manager.
SD_PACKAGES = {
    "pacman": ["git", "cmake", "make", "gcc", "vulkan-headers", "spirv-headers", "shaderc"],
    "apt-get": ["git", "cmake", "make", "g++", "libvulkan-dev", "spirv-headers", "glslc"],
    "dnf": ["git", "cmake", "make", "gcc-c++", "vulkan-headers", "vulkan-loader-devel",
            "spirv-headers-devel", "glslc"],
}


def sd_dir():
    return ROOT / "data/tools/stable-diffusion.cpp"


def sd_build_dir(backend):
    return sd_dir() / f"build-{backend}"


def sd_supports_editor(binary):
    try:
        result = subprocess.run([str(binary), "--help"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    text = result.stdout + result.stderr
    return all(flag in text for flag in SD_REQUIRED_FLAGS)


def sd_built(backend):
    binary = sd_build_dir(backend) / "bin/sd-server"
    marker = sd_dir() / "installed.json"
    try:
        stamp = json.loads(marker.read_text())
    except (OSError, ValueError):
        return False
    return (stamp.get("commit") == SD_CPP["commit"] and stamp.get("backend") == backend
            and binary.is_file() and sd_supports_editor(binary))


def missing_packages(manager):
    wanted = SD_PACKAGES[manager]
    if manager == "pacman":
        # pacman -T lists only what is absent, so installed packages are never re-resolved
        # against newer repos (a partial upgrade on Arch).
        result = subprocess.run(["pacman", "-T", *wanted], capture_output=True, text=True)
        return result.stdout.split() if result.returncode else []
    if manager == "apt-get":
        return [name for name in wanted
                if subprocess.run(["dpkg", "-s", name], capture_output=True).returncode]
    return [name for name in wanted
            if subprocess.run(["rpm", "-q", name], capture_output=True).returncode]


def install_build_packages(backend):
    manager = next((name for name in SD_PACKAGES if shutil.which(name)), None)
    if not manager:
        if not (shutil.which("git") and shutil.which("cmake")):
            raise SystemExit("Install git, cmake, a C++ compiler and the Vulkan headers, then run this again.")
        return
    missing = missing_packages(manager)
    if backend != "vulkan":
        vulkan = {"vulkan-headers", "spirv-headers", "shaderc", "libvulkan-dev", "glslc",
                  "vulkan-loader-devel", "spirv-headers-devel"}
        missing = [name for name in missing if name not in vulkan]
    if not missing:
        return
    command = {
        "pacman": ["pacman", "-S", "--noconfirm", "--needed", *missing],
        "apt-get": ["apt-get", "install", "-y", *missing],
        "dnf": ["dnf", "install", "-y", *missing],
    }[manager]
    prefix = [] if os.geteuid() == 0 else ["sudo", "-n"]
    print(f"Installing build packages: {' '.join(missing)}", flush=True)
    if prefix and subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode:
        raise SystemExit("Building sd-server needs these packages. Run this, then install again:\n"
                         f"sudo {' '.join(command)}")
    subprocess.run([*prefix, *command], check=True)


def build_sd_server(backend):
    """Clone and build the pinned stable-diffusion.cpp sd-server. Returns its path."""
    configured = os.environ.get("SCAN_IMAGE_SD_SERVER")
    if configured:
        if not sd_supports_editor(configured):
            raise SystemExit(f"SCAN_IMAGE_SD_SERVER={configured} is missing or too old for Qwen-Image-Edit 2511.")
        print(f"Using SCAN_IMAGE_SD_SERVER={configured}", flush=True)
        return Path(configured)
    binary = sd_build_dir(backend) / "bin/sd-server"
    if sd_built(backend):
        print(f"Already built {binary}", flush=True)
        return binary
    install_build_packages(backend)
    src = sd_dir()
    run = lambda *cmd, cwd=src: subprocess.run(list(cmd), cwd=cwd, check=True)
    if not (src / ".git").is_dir():
        src.mkdir(parents=True, exist_ok=True)
        run("git", "init", "-q")
        run("git", "remote", "add", "origin", SD_CPP["repo"])
    print(f"Fetching stable-diffusion.cpp {SD_CPP['commit'][:7]}", flush=True)
    retry(lambda: run("git", "fetch", "-q", "--depth", "1", "origin", SD_CPP["commit"]))
    run("git", "checkout", "-q", "--force", SD_CPP["commit"])
    retry(lambda: run("git", "submodule", "update", "-q", "--init", "--recursive", "--depth", "1"))
    build = sd_build_dir(backend)
    shutil.rmtree(build, ignore_errors=True)
    print(f"Building sd-server ({backend})", flush=True)
    run("cmake", "-S", str(src), "-B", str(build), "-DCMAKE_BUILD_TYPE=Release", *SD_BACKENDS[backend])
    run("cmake", "--build", str(build), "--target", "sd-server", "--parallel", str(os.cpu_count() or 4))
    if not sd_supports_editor(binary):
        raise SystemExit(f"{binary} was built but does not accept the flags the editor needs.")
    (src / "installed.json").write_text(json.dumps(
        {"commit": SD_CPP["commit"], "backend": backend, "binary": str(binary)}, indent=2) + "\n")
    print(f"Built {binary}", flush=True)
    return binary


def lora_dest():
    return Path(os.environ.get("SCAN_IMAGE_LORAS_DIR") or (default_dest().parent / "loras"))


def marker_name(quant):
    return f"installed-{quant}.json" if quant in COMPARE_QUANTS else "installed.json"


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
    retry(lambda: require_hub().hf_hub_download(repo_id=repo, filename=filename, revision=revision,
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
    parser.add_argument("--lightning", action="store_true",
                        help="Also install the 8-step Lightning LoRA (downloads the base weights when they are missing).")
    parser.add_argument("--sd-backend", choices=sorted(SD_BACKENDS), default="vulkan",
                        help="ggml backend to build sd-server with (default vulkan).")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    dest = args.dest.expanduser().resolve()
    filename, size, sha256, gib = QUANTS[args.quant]
    encoder_file, encoder_size, encoder_sha, encoder_gib = ENCODERS[args.encoder]
    base_files = (
        (filename, (size, sha256)),
        (VAE_FILE[0], (VAE_FILE[1], VAE_FILE[2])),
        (encoder_file, (encoder_size, encoder_sha)),
        (MMPROJ_FILE[0], (MMPROJ_FILE[1], MMPROJ_FILE[2])),
    )
    if args.verify_only:
        missing = [name for name, spec in base_files if not verified(dest / name, *spec)]
        if args.lightning and not verified(
            lora_dest() / LIGHTNING["file"], LIGHTNING["size"], LIGHTNING["sha256"],
        ):
            missing.append(LIGHTNING["file"])
        configured = os.environ.get("SCAN_IMAGE_SD_SERVER")
        if not (sd_supports_editor(configured) if configured else sd_built(args.sd_backend)):
            missing.append("sd-server")
        if missing:
            raise SystemExit("Not installed or checksum mismatch: " + ", ".join(missing))
        print(f"Verified {dest}", flush=True)
        return

    base_ready = all(verified(dest / name, *spec) for name, spec in base_files)
    if not base_ready:
        need = gib + VAE_FILE[3] + encoder_gib + MMPROJ_FILE[3]
        parent = dest.parent if dest.parent.is_dir() else dest.parent.parent
        if shutil.disk_usage(parent).free < need * 1024**3:
            raise SystemExit(f"At least {need:.1f} GiB free is required for Qwen-Image-Edit-2511 ({args.quant}).")

    # Build first: it is quick to fail on missing packages, and the weights cannot run without it.
    build_sd_server(args.sd_backend)
    install_file(dest, DIFFUSION["repo"], DIFFUSION["revision"], filename, size, sha256)
    install_file(dest, VAE["repo"], VAE["revision"], VAE_FILE[0], VAE_FILE[1], VAE_FILE[2])
    # Qwen2.5-VL is not shared with anything else in this app, so it lives here.
    install_file(dest, TEXT_ENCODER["repo"], TEXT_ENCODER["revision"],
                 encoder_file, encoder_size, encoder_sha)
    install_file(dest, TEXT_ENCODER["repo"], TEXT_ENCODER["revision"],
                 MMPROJ_FILE[0], MMPROJ_FILE[1], MMPROJ_FILE[2])

    (dest / marker_name(args.quant)).write_text(json.dumps({
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
    if args.lightning:
        install_file(lora_dest(), LIGHTNING["repo"], LIGHTNING["revision"],
                     LIGHTNING["file"], LIGHTNING["size"], LIGHTNING["sha256"])
        print(f"Installed Lightning LoRA in {lora_dest()}", flush=True)


if __name__ == "__main__":
    main()

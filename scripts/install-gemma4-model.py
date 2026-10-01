#!/usr/bin/env python3
"""Install Unsloth Gemma 4 GGUF packs (UD-Q4_K_XL + mmproj + MTP drafter)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]

PACKS = {
    "e2b": {
        "repo": "unsloth/gemma-4-E2B-it-GGUF",
        "revision": "0314792d7f1f7e229411f620751375812bb9faf2",
        "dir": "gemma-4-E2B-it-GGUF",
        "files": [
            {
                "filename": "gemma-4-E2B-it-UD-Q4_K_XL.gguf",
                "bytes": 3184496736,
                "sha256": "b52f438017efaec5debf1c0d8be690571e212a07c312f1102bbce927258cfc32",
            },
            {
                "filename": "mmproj-BF16.gguf",
                "bytes": 986833728,
                "sha256": "a402f10fb5780bf91d03a10cd89061139f522bee2e679b1291bbfdcd71d9547d",
            },
            {
                "filename": "mtp-gemma-4-E2B-it.gguf",
                "bytes": 97817664,
                "sha256": "9eba819938efccfd6044f8af84e3bbfddc639a2bcf32ebc36420e6a649191919",
            },
        ],
    },
    "e4b": {
        "repo": "unsloth/gemma-4-E4B-it-GGUF",
        "revision": "bfc15c382204943c3a8fff0c750b94ae2364d7a3",
        "dir": "gemma-4-E4B-it-GGUF",
        "files": [
            {
                "filename": "gemma-4-E4B-it-UD-Q4_K_XL.gguf",
                "bytes": 5126306944,
                "sha256": "3cf61de12daa015ee0f7b68e7b7c541405bf220e1e942bad8b47cab827d7df80",
            },
            {
                "filename": "mmproj-BF16.gguf",
                "bytes": 991552320,
                "sha256": "ee01cba03fd9c71ea2ea722225d24a84f72e7197714367e550ef705ef8851bc6",
            },
            {
                "filename": "mtp-gemma-4-E4B-it.gguf",
                "bytes": 98653248,
                "sha256": "b6a723115efa510d3b3215db1e26790dae84cd08c2134a764f3d194f1f0c3376",
            },
        ],
    },
    "12b": {
        "repo": "unsloth/gemma-4-12b-it-GGUF",
        "revision": "fc034cfff751157913579611efad8462ac1be606",
        "dir": "gemma-4-12b-it-GGUF",
        "files": [
            {
                "filename": "gemma-4-12b-it-UD-Q4_K_XL.gguf",
                "bytes": 7366423360,
                "sha256": "90fd944d227e9d9b68e7e2c7d5b57b79d4c66ed521b0919fbbd932cf834f6f8e",
            },
            {
                "filename": "mmproj-BF16.gguf",
                "bytes": 175115840,
                "sha256": "2e269f906eb15169ee9ce880ea649bd6d42d4964c21f8ede10d0d0efc738bcbb",
            },
            {
                "filename": "mtp-gemma-4-12b-it.gguf",
                "bytes": 465109248,
                "sha256": "145db9094bc0f85f1701e255a2ed216dcc9800fc8bc8631ad00905b456bd451b",
            },
        ],
    },
    "26b": {
        "repo": "unsloth/gemma-4-26B-A4B-it-GGUF",
        "revision": "c099eb48e663fd284577b04978a94ffccb261841",
        "dir": "gemma-4-26B-A4B-it-GGUF",
        "files": [
            {
                "filename": "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf",
                "bytes": 17010980576,
                "sha256": "ef728c8e0c337fd1067b947af006e38a9ef2419e56feced4fd29b4bf0636e30c",
            },
            {
                "filename": "mmproj-BF16.gguf",
                "bytes": 1194828256,
                "sha256": "41926ed5f1403cf5add23b0684992805ea6f97253096132e769e65646b8cef9d",
            },
            {
                "filename": "mtp-gemma-4-26B-A4B-it.gguf",
                "bytes": 461766816,
                "sha256": "6326fb9f5e487aa8dcdd313a091e3c67724cb2a666ec3b7d2895b5b26d93ed1b",
            },
        ],
    },
}


def default_root():
    return Path(os.environ.get("SCAN_GEMMA4_MODELS_ROOT") or Path.home() / "models/unsloth")


def verified(path, spec):
    if not path.is_file() or path.stat().st_size != spec["bytes"]:
        return False
    digest = spec.get("sha256")
    if not digest or digest == "placeholder":
        return True
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == digest


def install_file(dest, repo, revision, spec):
    path = dest / spec["filename"]
    if verified(path, spec):
        print(f"Already verified {path}", flush=True)
        return
    dest.mkdir(parents=True, exist_ok=True)
    needed = spec["bytes"] + 128 * 1024**2
    if shutil.disk_usage(dest).free < needed:
        raise RuntimeError(f"Insufficient disk space for {path.name}")
    from huggingface_hub import hf_hub_download

    print(f"Downloading {repo}/{spec['filename']}@{revision}", flush=True)
    hf_hub_download(
        repo_id=repo,
        filename=spec["filename"],
        revision=revision,
        local_dir=str(dest),
    )
    if not verified(path, spec):
        raise RuntimeError(f"Size or SHA256 verification failed for {path.name}")
    print(f"Verified {path}", flush=True)


def install_pack(name, root, no_mtp=False):
    pack = PACKS[name]
    dest = root / pack["dir"]
    files = pack["files"] if not no_mtp else pack["files"][:2]
    for spec in files:
        install_file(dest, pack["repo"], pack["revision"], spec)
    marker = dest / "installed.json"
    marker.write_text(
        json.dumps(
            {"pack": name, "repository": pack["repo"], "revision": pack["revision"], "files": files},
            indent=2,
        )
        + "\n",
    )
    print(f"Installed {name} -> {dest}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        action="append",
        dest="models",
        choices=["e2b", "e4b", "12b", "26b", "small", "all"],
        help="e2b (~2B), e4b (~4B), 12b (no 8B pack exists), 26b, small (=e2b+e4b+12b), all",
    )
    parser.add_argument("--root", type=Path, default=default_root())
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--no-mtp", action="store_true")
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    selected = []
    for value in args.models or ["26b"]:
        if value == "all":
            selected.extend(["e2b", "e4b", "12b", "26b"])
        elif value == "small":
            selected.extend(["e2b", "e4b", "12b"])
        elif value not in selected:
            selected.append(value)
    if args.verify_only:
        missing = []
        for name in selected:
            pack = PACKS[name]
            dest = root / pack["dir"]
            files = pack["files"] if not args.no_mtp else pack["files"][:2]
            for spec in files:
                if not verified(dest / spec["filename"], spec):
                    missing.append(f"{name}:{spec['filename']}")
        if missing:
            raise SystemExit("Not installed or checksum mismatch: " + ", ".join(missing))
        print(f"Verified {', '.join(selected)} under {root}", flush=True)
        return
    for name in selected:
        install_pack(name, root, args.no_mtp)


if __name__ == "__main__":
    main()

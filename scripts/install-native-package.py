#!/usr/bin/env python3
"""Explicit installation for native packages not covered by the legacy catalog."""
import argparse
import json
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=['sam', 'paddle'], required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if args.model == 'sam':
        from huggingface_hub import hf_hub_download
        import sam2  # Verify the runtime dependency without loading a model.
        path = os.environ.get('SCAN_SAM_CHECKPOINT') or hf_hub_download(
            'facebook/sam2.1-hiera-small', 'sam2.1_hiera_small.pt')
        artifacts = [Path(path)]
    else:
        # This explicit installer fetches precisely the pipelines used by the adapter.
        sys.path.insert(0, str(root / 'ocr'))
        import worker
        for lang in ('japan', 'korean'):
            worker._get_ocr(lang)
        cache = Path(os.environ.get('PADDLE_PDX_CACHE_HOME', str(Path.home() / '.paddlex')))
        artifacts = [p for p in (cache / 'official_models').rglob('*') if p.is_file()]
    if not artifacts or any(not p.is_file() or p.stat().st_size == 0 for p in artifacts):
        raise SystemExit('Model artifacts are missing or empty')
    data = Path(os.environ.get('SCAN_DATA_DIR', str(root / 'data')))
    receipt = data / 'models' / 'package-installations' / f'{args.model}.json'
    receipt.parent.mkdir(parents=True, exist_ok=True)
    temporary = receipt.with_suffix('.tmp')
    temporary.write_text(json.dumps({'artifacts': [str(p.resolve()) for p in artifacts]}))
    temporary.replace(receipt)
    print(f'Installed {args.model}: verified {len(artifacts)} artifacts', flush=True)


if __name__ == '__main__':
    main()

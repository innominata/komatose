"""Eager PyTorch detectors. ONNX is reserved for the CPU fallback.

The CTD architecture is fetched unchanged from a pinned GPL-3.0 upstream,
with its license, by install-detect-models.py. Only SafeTensors are loaded.
"""
import hashlib
import importlib
import importlib.util
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
RTDETR_REPO = 'ogkalu/comic-text-and-bubble-detector'
RTDETR_REVISION = '16e8a622f91fabc6b5b65c96d32d1183f8843546'
CTD_REPO = 'mayocream/comic-text-detector'
CTD_REVISION = '15ade029f4dabd502bc97af6051c8b9f2bec24d5'
CTD_SOURCE_REVISION = 'a9fca9d0e8ecec081d3cd817efb98f2f863e262c'
CTD_SOURCE_FILES = {
    'ctd/basemodel.py': '459815d9b1cec8f6b3a2f19475ab0cbef5fcf913a7d2b8ff2d8fb483baee02c8',
    'yolov5/yolo.py': 'ad0f577367a2e5072790ab4d5459a7b8df5dec3e62738cfd9a5720ff84af8480',
    'yolov5/common.py': '4a03af17a5795579dab11b5f346f0d69789de78159863297116a2173c3453544',
    'yolov5/yolov5_utils.py': '62c72d7fa1529b8259cac5a21b93ba43a4c9fd32071f735678f8a95ee012571e',
    'LICENSE': '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
}


def ctd_source_root():
    return Path(os.environ.get('SCAN_CTD_SOURCE_DIR') or
                ROOT / 'data/models' / f'ctd-native-{CTD_SOURCE_REVISION}')


def gpu_device(choice=None):
    """ROCm uses PyTorch's cuda API; CPU choices never initialize a GPU model."""
    choice = str(choice or os.environ.get('SCAN_DETECT_DEVICE', 'auto')).lower()
    if choice == 'cpu':
        return None
    try:
        import torch
    except ImportError:
        if choice != 'auto':
            raise RuntimeError('Native detector GPU requested but PyTorch is not installed')
        return None
    if not torch.cuda.is_available():
        if choice != 'auto':
            raise RuntimeError('Native detector GPU requested but PyTorch cannot execute on a GPU')
        return None
    device = 'cuda:0' if choice in ('auto', 'cuda', 'rocm') else choice
    if not device.startswith('cuda:'):
        raise ValueError(f'Invalid detector device: {choice}')
    return device


def _ctd_modules():
    root = ctd_source_root()
    for name, digest in CTD_SOURCE_FILES.items():
        path = root / name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError('CTD native source missing or checksum mismatch; run scripts/install-detect-models.py --model ctd')
    # Isolate upstream relative imports from the application's Python modules.
    name = 'komatose_ctd_native'
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, root / '__init__.py',
                                                     submodule_search_locations=[str(root)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return (importlib.import_module(name + '.ctd.basemodel'),
            importlib.import_module(name + '.yolov5.yolo'))


def _yolo_config():
    # YOLOv5s v6, two text classes. Strict loading below checks every tensor.
    return {
        'nc': 2, 'depth_multiple': .33, 'width_multiple': .5,
        'anchors': [[10,13,16,30,33,23], [30,61,62,45,59,119], [116,90,156,198,373,326]],
        'backbone': [
            [-1,1,'Conv',[64,6,2,2]], [-1,1,'Conv',[128,3,2]], [-1,3,'C3',[128]],
            [-1,1,'Conv',[256,3,2]], [-1,6,'C3',[256]], [-1,1,'Conv',[512,3,2]],
            [-1,9,'C3',[512]], [-1,1,'Conv',[1024,3,2]], [-1,3,'C3',[1024]],
            [-1,1,'SPPF',[1024,5]],
        ],
        'head': [
            [-1,1,'Conv',[512,1,1]], [-1,1,'nn.Upsample',[None,2,'nearest']],
            [[-1,6],1,'Concat',[1]], [-1,3,'C3',[512,False]],
            [-1,1,'Conv',[256,1,1]], [-1,1,'nn.Upsample',[None,2,'nearest']],
            [[-1,4],1,'Concat',[1]], [-1,3,'C3',[256,False]],
            [-1,1,'Conv',[256,3,2]], [[-1,14],1,'Concat',[1]], [-1,3,'C3',[512,False]],
            [-1,1,'Conv',[512,3,2]], [[-1,10],1,'Concat',[1]], [-1,3,'C3',[1024,False]],
            [[17,20,23],1,'Detect',['nc','anchors']],
        ],
    }


class CtdSession:
    def __init__(self, device):
        import torch
        from huggingface_hub import hf_hub_download
        from safetensors.torch import load_file
        base, yolo = _ctd_modules()
        # Construct on CPU, fuse batch norms once, then retain on the GPU.
        backbone = yolo.Model(_yolo_config())
        backbone.load_state_dict(load_file(hf_hub_download(CTD_REPO, 'yolo-v5.safetensors', revision=CTD_REVISION)), strict=True)
        backbone = backbone.requires_grad_(False).float().eval().fuse()
        backbone.out_indices = [1, 3, 5, 7, 9]
        seg, lines = base.UnetHead(act='leaky'), base.DBHead(64, act='leaky')
        for model, filename in [(seg, 'unet.safetensors'), (lines, 'dbnet.safetensors')]:
            model.load_state_dict(load_file(hf_hub_download(CTD_REPO, filename, revision=CTD_REVISION)), strict=True)
        self.models = [m.requires_grad_(False).eval().to(device) for m in (backbone, seg, lines)]
        self.device = device

    def run(self, _outputs, inputs):
        import torch
        with torch.inference_mode():
            tensor = torch.from_numpy(inputs['images']).to(self.device)
            backbone, seg, lines = self.models
            blocks, features = backbone(tensor, detect=True)
            mask, features = seg(*features, forward_mode=2)
            line_map = lines(*features, step_eval=False)
            return [value.float().cpu().numpy() for value in (blocks[0], mask, line_map)]


class RtdetrSession:
    def __init__(self, device):
        from huggingface_hub import snapshot_download
        from transformers import RTDetrV2ForObjectDetection, RTDetrImageProcessor
        # Load the pinned local snapshot so Transformers does not probe remote
        # adapter files and rewrite HF's negative cache on every worker start.
        # Those cache mutations would immediately stale the recorded pass.
        directory = snapshot_download(RTDETR_REPO, revision=RTDETR_REVISION,
                                      allow_patterns=['model.safetensors', 'config.json', 'preprocessor_config.json'])
        self.model = RTDetrV2ForObjectDetection.from_pretrained(
            directory, local_files_only=True, use_safetensors=True).eval().to(device)
        self.processor = RTDetrImageProcessor.from_pretrained(directory, local_files_only=True)
        self.device = device

    def run(self, _outputs, inputs):
        import torch
        with torch.inference_mode():
            outputs = self.model(pixel_values=torch.from_numpy(inputs['images']).to(self.device))
            # The ONNX export takes (width,height); HF postprocessing takes
            # (height,width). Keep the caller's ONNX-compatible interface.
            sizes = torch.from_numpy(inputs['orig_target_sizes'][:, ::-1].copy()).to(self.device)
            result = self.processor.post_process_object_detection(outputs, threshold=0, target_sizes=sizes)[0]
            return [result[key].cpu().numpy()[None] for key in ('labels', 'boxes', 'scores')]

#!/usr/bin/env python3
"""Export real checkpoints, save references, and record each failure honestly."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import sys
import time
import traceback

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
os.environ.setdefault('SAM2_BUILD_CUDA', '0')
from models import MODEL_IDS, GENERATIVE, Stage, stages, model_directory


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def save_tensor(value, directory, name):
    import numpy as np
    array = np.ascontiguousarray(value.detach().cpu().numpy())
    path = directory / f'{name}.bin'
    array.tofile(path)
    return {'file': path.name, 'dtype': str(array.dtype), 'shape': list(array.shape),
            'bytes': path.stat().st_size, 'sha256': sha256(path)}


def tensor_outputs(values):
    import torch
    if isinstance(values, torch.Tensor):
        return [values]
    if isinstance(values, (tuple, list)):
        return [tensor for value in values for tensor in tensor_outputs(value)]
    raise TypeError(f'Non-tensor output: {type(values).__name__}')


def operators(program):
    return sorted({str(node.target) for node in program.graph.nodes if node.op == 'call_function'})


def lower(program, backend):
    from executorch.exir import to_edge_transform_and_lower, EdgeCompileConfig
    if backend == 'portable':
        partitioners = []
    elif backend == 'xnnpack':
        from executorch.backends.xnnpack.partition.xnnpack_partitioner import XnnpackPartitioner
        partitioners = [XnnpackPartitioner()]
    elif backend == 'vulkan':
        from executorch.backends.vulkan.partitioner.vulkan_partitioner import VulkanPartitioner
        partitioners = [VulkanPartitioner()]
    elif backend in ('cuda', 'rocm'):
        from executorch.backends.cuda.cuda_partitioner import CudaPartitioner
        from executorch.backends.cuda.cuda_backend import CudaBackend
        partitioners = [CudaPartitioner([CudaBackend.generate_method_name_compile_spec('komatose')])]
    elif backend == 'openvino':
        from executorch.backends.openvino.partitioner import OpenvinoPartitioner
        partitioners = [OpenvinoPartitioner()]
    else:
        raise ValueError(backend)
    # The documented non-Core ATen route permits a genuine lowering attempt.
    # Runtime operator registration must still pass native validation; disabling
    # this verifier never turns a serialized graph into a compatibility pass.
    return to_edge_transform_and_lower(program, partitioner=partitioners,
                                      compile_config=EdgeCompileConfig(_check_ir_validity=False))


def export_stage(stage, args, out):
    import torch
    directory = out / stage.name
    directory.mkdir(parents=True, exist_ok=True)
    result = {'stage': stage.name, 'backend': args.backend, 'dynamic': args.dynamic,
              'contract': stage.contract, 'status': 'requires changes', 'phase': 'reference'}
    start = time.perf_counter()
    try:
        inputs = stage.inputs
        # torch.export deliberately specializes dimensions of size 0/1. Probe
        # full-prefix decoders with 3 tokens before testing min/max at runtime.
        if args.dynamic and stage.name == 'decoder' and stage.dynamic_shapes:
            values = list(inputs)
            for index, spec in enumerate(stage.dynamic_shapes):
                for axis in spec:
                    if values[index].shape[axis] == 1:
                        values[index] = torch.repeat_interleave(values[index], 3, dim=axis)
            inputs = tuple(values)
        with torch.no_grad():
            reference = tensor_outputs(stage.module(*inputs))
        # Reference costs are separate from exporter/import overhead.
        if args.device.startswith('cuda'):
            torch.cuda.synchronize()
        reference_start = time.perf_counter()
        with torch.no_grad():
            stage.module(*inputs)
        if args.device.startswith('cuda'):
            torch.cuda.synchronize()
        result['referenceMs'] = (time.perf_counter() - reference_start) * 1000
        case = {'schemaVersion': 1, 'method': 'forward',
                'inputs': [save_tensor(value, directory, f'input-{index}') for index, value in enumerate(inputs)],
                'reference': [save_tensor(value, directory, f'reference-{index}') for index, value in enumerate(reference)]}
        (directory / 'case.json').write_text(json.dumps(case, indent=2) + '\n')
        result['phase'] = 'torch.export'
        module = stage.module
        if isinstance(module, torch.jit.ScriptModule):
            from torch._export.converter import TS2EPConverter
            if args.dynamic:
                raise RuntimeError('TS2EPConverter does not preserve dynamic shapes; an eager upstream AOT architecture is required')
            program = TS2EPConverter(module, inputs).convert()
        else:
            dynamic = stage.dynamic_shapes if args.dynamic else None
            if dynamic and getattr(module, '_feasibility_varargs', False):
                dynamic = {'args': dynamic}
            program = torch.export.export(module, inputs, dynamic_shapes=dynamic, strict=False)
        if args.decompose_complex:
            from torch._decomp import get_decompositions
            program = program.run_decompositions(get_decompositions([torch.ops.aten.complex.default]))
        result['atenOperators'] = operators(program)
        (directory / 'graph.py.txt').write_text(program.graph_module.code)
        if args.keep_program:
            torch.export.save(program, directory / 'model.pt2')
        result['phase'] = 'lower'
        edge = lower(program, args.backend)
        edge_program = edge.exported_program()
        result['edgeOperators'] = operators(edge_program)
        result['delegateCalls'] = sum('executorch_call_delegate' in str(node.target)
                                      for node in edge_program.graph.nodes)
        result['phase'] = 'serialize'
        executable = edge.to_executorch()
        result['requiredOperators'] = [{'name': op.name, 'overload': op.overload}
                                       for plan in executable.executorch_program.execution_plan for op in plan.operators]
        with (directory / 'model.pte').open('wb') as stream:
            executable.write_to_file(stream)
        if getattr(executable, '_tensor_data', None):
            executable.write_tensor_data_to_file(str(directory))
        result.update(phase='native-validation-pending', artifact='model.pte',
                      artifactBytes=(directory / 'model.pte').stat().st_size,
                      artifactSha256=sha256(directory / 'model.pte'))
    except Exception as exc:
        result.update(status='blocked', errorType=type(exc).__name__, error=str(exc)[:6000])
        (directory / 'error.log').write_text(traceback.format_exc())
    result['elapsedSeconds'] = time.perf_counter() - start
    result['exporterPeakRssBytes'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
    (directory / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'stage': stage.name, 'status': result['status'], 'phase': result['phase'],
                      'error': result.get('error', '')[:240]}), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=[*MODEL_IDS, 'smoke'], required=True)
    parser.add_argument('--backend', choices=['portable', 'xnnpack', 'vulkan', 'cuda', 'rocm', 'openvino'], default='portable')
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--dynamic', action='store_true')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--stage', help='Test a particular encoder/decoder stage')
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--keep-program', action='store_true',
                        help='Retain duplicate .pt2 weight archives for compiler debugging')
    parser.add_argument('--decompose-complex', action='store_true',
                        help='Explicit upstream decomposition probe for LaMa complex construction')
    args = parser.parse_args()
    if args.model in ('hayai-ocr-v2', 'manga-ocr'):
        os.environ['HF_HOME'] = str(model_directory(args.model).parent / 'hf-cache')
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = {'model': args.model, 'backend': args.backend, 'device': args.device,
                'dynamic': args.dynamic, 'stages': [], 'completeOperationValidated': False,
                'versions': {name: importlib.metadata.version(name) for name in ('torch', 'executorch', 'torchvision', 'transformers', 'spandrel')},
                'generative': args.model in GENERATIVE}
    try:
        import torch
        torch.set_num_threads(args.threads)
        torch.set_num_interop_threads(1)
        torch.manual_seed(42)
        if args.model == 'smoke':
            class Smoke(torch.nn.Module):
                def forward(self, x):
                    return torch.relu(x * 2 + 1)
            items = [Stage('forward', Smoke(), (torch.arange(-12, 12, dtype=torch.float32).reshape(1, 3, 2, 4),), ('image',))]
        else:
            items = stages(args.model, args.device)
        for stage in items:
            if not args.stage or args.stage == stage.name:
                manifest['stages'].append(export_stage(stage, args, args.out))
        if not manifest['stages']:
            raise RuntimeError('No stages selected')
    except Exception as exc:
        manifest['loadError'] = f'{type(exc).__name__}: {exc}'
        (args.out / 'load-error.log').write_text(traceback.format_exc())
        print(manifest['loadError'], flush=True)
    (args.out / 'export.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return 1 if manifest.get('loadError') or any(s['status'] == 'blocked' for s in manifest['stages']) else 0


if __name__ == '__main__':
    sys.exit(main())

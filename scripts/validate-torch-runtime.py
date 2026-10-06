#!/usr/bin/env python3
"""Exercise the operators used by Komatose, without downloading any models."""
import argparse
import importlib.metadata
import json
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--variant', required=True, choices=['cpu', 'cuda', 'rocm'])
    parser.add_argument('--architectures', default='')
    args = parser.parse_args()
    import torch
    import torchvision
    torch.set_num_threads(4)
    actual = 'rocm' if torch.version.hip else 'cuda' if torch.version.cuda else 'cpu'
    if actual != args.variant:
        raise RuntimeError(f'Expected {args.variant}, got {actual}')
    targets = []
    if actual != 'cpu':
        expected = set(filter(None, args.architectures.split(',')))
        for i in range(torch.cuda.device_count()):
            p = torch.cuda.get_device_properties(i)
            arch = getattr(p, 'gcnArchName', '').split(':')[0]
            if (not expected or arch in expected) and (actual != 'rocm' or p.total_memory > 2 * 1024**3):
                targets.append((f'cuda:{i}', arch))
        if not targets:
            raise RuntimeError('No selected GPU is usable by this runtime')
        if expected - {arch for _, arch in targets}:
            raise RuntimeError('Not all requested architecture packs can be validated on this hardware')
    else:
        targets = [('cpu', '')]
    measurements = []
    for device, arch in targets:
        torch.manual_seed(17)
        a = torch.randn(1, 8, 32, 48)
        w = torch.randn(8, 8, 3, 3)
        q = torch.randn(1, 2, 16, 8)
        boxes = torch.tensor([[0., 0., 10., 10.], [1., 1., 9., 9.], [20., 20., 30., 30.]])
        scores = torch.tensor([.9, .8, .7])
        def operations(d):
            x = a.to(d)
            return [torch.nn.functional.conv2d(x, w.to(d), padding=1),
                    torch.fft.irfft2(torch.fft.rfft2(x), s=x.shape[-2:]),
                    torch.nn.functional.scaled_dot_product_attention(q.to(d), q.to(d), q.to(d)),
                    torchvision.ops.nms(boxes.to(d), scores.to(d), .5),
                    torchvision.ops.deform_conv2d(x, torch.zeros(1, 18, 32, 48, device=d), w.to(d), padding=(1, 1))]
        expected = operations('cpu')
        start = time.perf_counter()
        values = operations(device)
        if device != 'cpu':
            torch.cuda.synchronize(device)
        first = (time.perf_counter() - start) * 1000
        for ref, val in zip(expected, values):
            torch.testing.assert_close(val.cpu(), ref, atol=2e-4, rtol=2e-3)
        samples = []
        for _ in range(5):
            start = time.perf_counter()
            operations(device)
            if device != 'cpu':
                torch.cuda.synchronize(device)
            samples.append((time.perf_counter() - start) * 1000)
        measurements.append({'device': device, 'architecture': arch, 'firstMs': first, 'warmedMs': samples})
    versions = {d.metadata['Name']: d.version for d in importlib.metadata.distributions()}
    print(json.dumps({'passed': True, 'variant': actual, 'torch': torch.__version__,
                      'torchvision': torchvision.__version__, 'operations': ['convolution', 'FFT', 'attention', 'NMS', 'deformable convolution'],
                      'devices': measurements, 'versions': versions, 'completeModelsValidated': False}))


if __name__ == '__main__':
    main()

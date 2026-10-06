# Plan B: ExecuTorch feasibility

Evaluate all retained bundled PyTorch models using isolated export tooling and a native C++ runtime. Keep production runtime installation unchanged until evidence supports migration.

## Scope and defaults

- LaMa Manga, BigLaMa, AOT, SAM2, Koharu, RT-DETR, CTD, COO, Hayai OCR, Manga OCR, Opus-MT, and Imsbee Ko→En.
- MI-GAN and Manga Inpainting are removed from Komatose at the user's request; existing downloaded artifacts remain untouched.
- Exclude existing Paddle, ONNX, CTranslate2, llama.cpp, and image-edit server paths. Count dependencies that prevent removing a Python environment.
- Linux x86-64, Python 3.12 exporter, ExecuTorch 1.5.1, locked compatible dependencies, existing checkpoints and preprocessing, no quantization or custom kernels initially.

## Experiment

- Inventory/checksum checkpoints, revisions, licenses, tensor contracts, preprocessing, and generation settings.
- Test CPU portable/XNNPACK and AMD Vulkan, including dynamic dimensions. Probe the release's experimental ROCm AOTInductor path where compatible with the installed exporter.
- Export separate encoder, prompt, mask, decoder, and state stages as needed. Partial graph export does not qualify a complete operation as migrated.
- Build a persistent C++ runner with explicit device selection, input/output tensors, repeated runs, and JSON measurements. Verify deployment without torch/libtorch and selectively build required kernels.
- Prepare CUDA and OpenVINO profiles, marked unverified until run on real NVIDIA/Intel hardware.
- Record unsupported operators, export restrictions, host-runtime requirements, and CPU fallback costs. Upstream support first; custom kernels remain a documented follow-up.

## Acceptance and output

- Use licensed fixtures, deterministic masks, square/rectangular/boundary/minimum/maximum inputs, alternating dimensions, prompts, generation, and state resets.
- Preserve dimensions and all pixels outside cleaning masks exactly. Cleaning masked mean error <=1/255 and maximum <=8/255; mask IoU >=0.99; matched boxes IoU >=0.99; deterministic OCR/translation text identical.
- Three fresh-process runs, ten warmed runs, 100-request stability, peak RAM/VRAM when measurable, tensor and complete-operation timing. Compare same-hardware PyTorch and the existing LaMa ONNX/WebGPU path.
- Separate runtime, weights, exporter, and caches. Measure a combined runtime for passing models.
- Classify each model/backend as ready, requires changes, blocked, or unverified hardware. Recommend migration only with correctness, no PyTorch deployment dependency, smaller disk use, improved first-result latency, and warmed latency within 25% of the current path.
- Deliver reproducible commands, locked versions, logs, raw results, and a human-readable report. Identify every remaining dependency which prevents deleting PyTorch.

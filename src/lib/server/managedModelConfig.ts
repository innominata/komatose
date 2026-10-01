import type { ManagedLaunch } from "../managedModels";
import {
  gemma4PackPaths,
  type Gemma4Pack,
  llamaServerBin,
  llmListenPort,
  qwen38ModelPath,
  qwen38MmprojPath,
  qwen38ChatTemplatePath,
} from "./gpuMode";

const GEMMA4_PORTS: Record<Gemma4Pack, number> = {
  e2b: 18087,
  e4b: 18089,
  "12b": 18088,
  "26b": 18086,
};

export function gemma4LaunchPreset(pack: Gemma4Pack = "26b"): ManagedLaunch {
  const paths = gemma4PackPaths(pack);
  return {
    preset: "gemma4",
    executable: llamaServerBin(),
    modelPath: paths.model,
    projectorPath: paths.mmproj,
    templatePath: "",
    port: GEMMA4_PORTS[pack],
    device: process.env.SCAN_GEMMA4_DEVICE || process.env.SCAN_LLM_DEVICE || "auto",
    contextSize: Number(process.env.SCAN_GEMMA4_CONTEXT) || 131072,
    gpuLayers: 999,
    slots: 1,
    startOnBoot: false,
    extraArgs: [],
  };
}

export function launchPreset(preset: "generic" | "qwen38" | "gemma4"): ManagedLaunch {
  if (preset === "qwen38") {
    return {
      preset,
      executable: llamaServerBin(),
      modelPath: qwen38ModelPath(),
      projectorPath: qwen38MmprojPath(),
      templatePath: qwen38ChatTemplatePath(),
      port: llmListenPort(),
      device: process.env.SCAN_LLM_DEVICE || "auto",
      contextSize: Number(process.env.SCAN_LLM_CONTEXT) || 131072,
      gpuLayers: 999,
      slots: 1,
      startOnBoot: true,
      extraArgs: [],
    };
  }
  if (preset === "gemma4") {
    const port = Math.max(1, Number(process.env.SCAN_GEMMA4_PORT) || GEMMA4_PORTS["26b"]);
    return { ...gemma4LaunchPreset("26b"), port };
  }
  return {
    preset: "generic",
    executable: llamaServerBin(),
    modelPath: "",
    projectorPath: "",
    templatePath: "",
    port: 18090,
    device: "auto",
    contextSize: 8192,
    gpuLayers: 999,
    slots: 1,
    startOnBoot: false,
    extraArgs: [],
  };
}

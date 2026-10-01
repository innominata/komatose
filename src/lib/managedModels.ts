/** Portable types only. Launch recipes remain local to an installation. */
export type RequestPreset = "generic" | "qwen-thinking";

/** Shape `/api/admin/managed-models` serves for one managed row. */
export type ManagedStatus = {
  id: string;
  state: string;
  operationId?: string;
  error?: string;
  activeUses: number;
  pendingChanges: boolean;
  /** Device the running process uses, else the saved choice. */
  device?: string;
  /** Saved choice: `auto`, `cpu`, or a ggml device name. */
  deviceChoice?: string;
  port?: number;
  pid?: number;
};
export type ManagedLaunch = {
  preset: "generic" | "qwen38" | "gemma4";
  executable: string;
  modelPath: string;
  projectorPath?: string;
  templatePath?: string;
  port: number;
  device: string;
  contextSize: number;
  gpuLayers: number;
  slots: number;
  startOnBoot: boolean;
  extraArgs: string[];
};

export function validateManagedLaunch(raw: unknown): ManagedLaunch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Choose a launch recipe");
  const r = raw as Record<string, unknown>;
  const str = (key: string, required = false) => {
    const value = typeof r[key] === "string" ? r[key].trim() : "";
    if ((required && !value) || /[\0\r\n]/.test(value))
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const int = (key: string, min: number, max: number) => {
    const n = Number(r[key]);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`Invalid ${key}`);
    return n;
  };
  if (r.preset !== "generic" && r.preset !== "qwen38" && r.preset !== "gemma4")
    throw new Error("Unknown launch preset");
  if (typeof r.startOnBoot !== "boolean")
    throw new Error("Choose whether to start with the app");
  if (
    !Array.isArray(r.extraArgs) ||
    r.extraArgs.some((v) => typeof v !== "string" || /[\0\r\n]/.test(v))
  )
    throw new Error("Advanced arguments must be a list of tokens");
  // Only tuning flags are accepted: alternative model/download, listener and auth flags
  // cannot bypass the typed configuration, including aliases and --flag=value forms.
  const flags = new Set([
    "--temp",
    "--top-p",
    "--top-k",
    "--min-p",
    "--repeat-penalty",
    "--presence-penalty",
    "--flash-attn",
    "-fa",
    "--cache-type-k",
    "-ctk",
    "--cache-type-v",
    "-ctv",
    "--batch-size",
    "-b",
    "--ubatch-size",
    "-ub",
    "--threads",
    "-t",
    "--threads-batch",
    "-tb",
    "--n-predict",
    "-n",
    "--fit",
    "-fit",
    "--split-mode",
    "-sm",
    "--tensor-split",
    "-ts",
    "--reasoning-format",
    "--reasoning",
    "--reasoning-budget",
    "--reasoning-effort",
  ]);
  for (let i = 0; i < r.extraArgs.length; i++) {
    const token = String(r.extraArgs[i]);
    const [flag] = token.split("=");
    if (!flags.has(flag))
      throw new Error(`Unsupported advanced argument: ${flag}`);
    if (!token.includes("=")) {
      if (
        ++i >= r.extraArgs.length ||
        /^--?[a-z]/i.test(String(r.extraArgs[i]))
      )
        throw new Error(`Missing value for ${flag}`);
    }
  }
  return {
    preset: r.preset,
    executable: str("executable", true),
    modelPath: str("modelPath", true),
    projectorPath: str("projectorPath"),
    templatePath: str("templatePath"),
    port: int("port", 1, 65535),
    device: str("device", true),
    contextSize: int("contextSize", 512, 2097152),
    gpuLayers: int("gpuLayers", 0, 999),
    slots: int("slots", 1, 128),
    startOnBoot: r.startOnBoot,
    extraArgs: [...r.extraArgs] as string[],
  };
}

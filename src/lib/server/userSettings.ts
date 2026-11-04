import { parseColorMap } from "../regionCatalog";
import { isProofreaderId, PROOFREADER_IDS, type ProofreaderId } from "../proofreaders";
import { sqlite } from "./db";

export type UserSettings = {
  regionColors: Record<string, string>;
  /**
   * Proofreaders this user may use. Empty by default: the feature is opt-in and
   * granted per user from Admin -> Users. Ids are validated against the known set.
   */
  proofreaders: ProofreaderId[];
  /** Cleaning methods whose result is applied as soon as it finishes, as Keep result would. */
  autoApplyClean: string[];
};

/** Method ids are short tokens (flat, lama, qwen-image-edit, a model id); anything else is dropped. */
export function parseAutoApplyClean(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const id = String(item ?? "").trim();
    if (/^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,120}$/.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= 100) break;
  }
  return out;
}

function parseProofreaders(raw: unknown): ProofreaderId[] {
  if (!Array.isArray(raw)) return [];
  const out: ProofreaderId[] = [];
  for (const item of raw) {
    const id = String(item || "");
    if (isProofreaderId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function readRaw(userId: string): Record<string, unknown> {
  const row = sqlite.prepare("SELECT settings FROM users WHERE id=?").get(userId) as
    | { settings?: string }
    | undefined;
  if (!row?.settings) return {};
  try {
    const value = JSON.parse(row.settings);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function readUserSettings(userId: string): UserSettings {
  const raw = readRaw(userId);
  return {
    regionColors: parseColorMap(raw.regionColors),
    proofreaders: parseProofreaders(raw.proofreaders),
    autoApplyClean: parseAutoApplyClean(raw.autoApplyClean),
  };
}

export function saveUserRegionColors(userId: string, colors: unknown): UserSettings {
  const current = readRaw(userId);
  const regionColors = parseColorMap(colors);
  sqlite.prepare("UPDATE users SET settings=? WHERE id=?").run(
    JSON.stringify({ ...current, regionColors }),
    userId,
  );
  return readUserSettings(userId);
}

export function saveUserAutoApplyClean(userId: string, methods: unknown): UserSettings {
  const current = readRaw(userId);
  sqlite.prepare("UPDATE users SET settings=? WHERE id=?").run(
    JSON.stringify({ ...current, autoApplyClean: parseAutoApplyClean(methods) }),
    userId,
  );
  return readUserSettings(userId);
}

/** Admin action: replace the set of proofreaders a user may use. */
export function saveUserProofreaders(userId: string, ids: unknown): UserSettings {
  const current = readRaw(userId);
  const proofreaders = parseProofreaders(ids);
  sqlite.prepare("UPDATE users SET settings=? WHERE id=?").run(
    JSON.stringify({ ...current, proofreaders }),
    userId,
  );
  return readUserSettings(userId);
}

/** True when the user may use any proofreader at all. */
export function hasAnyProofreader(userId: string): boolean {
  return readUserSettings(userId).proofreaders.length > 0;
}

/** Every proofreader id, in contract order, for admin pickers. */
export const ALL_PROOFREADER_IDS = PROOFREADER_IDS;


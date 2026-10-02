import {
  DEFAULT_CODEX_CLEAN_INSTRUCTIONS,
  MAX_CODEX_CLEAN_PROMPT,
  composeCodexCleanInstructions,
} from "./codexCleanPrompt";
import {
  DEFAULT_IMAGE_EDIT_INSTRUCTIONS,
  IMAGE_EDIT_MODELS,
  MAX_IMAGE_EDIT_PROMPT,
  composeImageEditInstructions,
} from "./imageEdit";

/**
 * Both cleaning methods that reconstruct artwork run as crop + prompt, so they share one
 * dialog: notes for the page at hand, plus the reusable instruction text behind a disclosure.
 */
export type CleanPromptDialogConfig = {
  /** Suffix of the dialog title, e.g. "Codex reconstruction". */
  title: string;
  hint: string;
  defaultInstructions: string;
  maxPrompt: number;
  /** localStorage key holding this method's instruction/notes draft. */
  storageKey: string;
  blankLabel: string;
  compose: (instructions: unknown, notes: unknown) => string;
};

export const CODEX_CLEAN_DIALOG: CleanPromptDialogConfig = {
  title: "Codex reconstruction",
  hint: "Add specifics before Codex runs, for example redraw the missing finger properly. Mask, crop, and output-file instructions stay attached.",
  defaultInstructions: DEFAULT_CODEX_CLEAN_INSTRUCTIONS,
  maxPrompt: MAX_CODEX_CLEAN_PROMPT,
  storageKey: "scan.codexCleanPrompt",
  blankLabel: "Prompt",
  compose: composeCodexCleanInstructions,
};

export const IMAGE_EDIT_DIALOG: CleanPromptDialogConfig = {
  title: "Qwen-Image-Edit 2511 edit",
  hint: "Describe the edit for the instruction editor, for example remove the sign and continue the brick wall behind it. Mask and crop stay attached.",
  defaultInstructions: DEFAULT_IMAGE_EDIT_INSTRUCTIONS,
  maxPrompt: MAX_IMAGE_EDIT_PROMPT,
  storageKey: "scan.imageEditPrompt",
  blankLabel: "Instructions",
  compose: composeImageEditInstructions,
};

export const IMAGE_EDIT_2511_DIALOG: CleanPromptDialogConfig = {
  title: "Qwen-Image-Edit 2511 edit",
  hint: "Describe the edit for the instruction editor, for example remove the sign and continue the brick wall behind it. Mask and crop stay attached.",
  defaultInstructions: DEFAULT_IMAGE_EDIT_INSTRUCTIONS,
  maxPrompt: MAX_IMAGE_EDIT_PROMPT,
  storageKey: "scan.imageEdit2511Prompt",
  blankLabel: "Instructions",
  compose: composeImageEditInstructions,
};

export function imageEditDialog(method: unknown): CleanPromptDialogConfig | undefined {
  if (method === IMAGE_EDIT_MODELS[0]?.method) return IMAGE_EDIT_2511_DIALOG;
  return undefined;
}

export function modelImageEditDialog(id: string, label: string): CleanPromptDialogConfig {
  return { ...IMAGE_EDIT_DIALOG, title: `${label} · edit image`,
    hint: 'Describe the edit. The image and removal mask are included.',
    storageKey: `scan.modelImageEditPrompt.${id}` };
}

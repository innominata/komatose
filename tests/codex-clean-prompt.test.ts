import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CODEX_CLEAN_INSTRUCTIONS,
  MAX_CODEX_CLEAN_PROMPT,
  buildCodexCleanPrompt,
  composeCodexCleanInstructions,
  normalizeCodexCleanPrompt,
} from "../src/lib/codexCleanPrompt";

test("empty Codex prompt falls back to the default reconstruction instructions", () => {
  assert.equal(normalizeCodexCleanPrompt(undefined), DEFAULT_CODEX_CLEAN_INSTRUCTIONS);
  assert.equal(normalizeCodexCleanPrompt("  "), DEFAULT_CODEX_CLEAN_INSTRUCTIONS);
  assert.equal(composeCodexCleanInstructions("", ""), DEFAULT_CODEX_CLEAN_INSTRUCTIONS);
});

test("extra notes append without replacing the reconstruction prompt", () => {
  const composed = composeCodexCleanInstructions("", "redraw the missing finger properly");
  assert.match(composed, /Reconstruct the artwork hidden behind the marked lettering/);
  assert.match(composed, /Additional direction from the letterer:\nredraw the missing finger properly/);
});

test("an edited prompt is kept and wrapped with mask and output-file instructions", () => {
  const prompt = composeCodexCleanInstructions(
    "Keep the sleeve folds. Redraw the missing finger properly.",
    "",
  );
  const wrapped = buildCodexCleanPrompt({
    imagePath: "/tmp/artwork.png",
    maskPath: "/tmp/mask.png",
    outputPath: "/tmp/cleaned.png",
    prompt,
  });
  assert.match(wrapped, /Keep the sleeve folds\. Redraw the missing finger properly\./);
  assert.match(wrapped, /Image 1 \(\/tmp\/artwork\.png\)/);
  assert.match(wrapped, /Image 2 \(\/tmp\/mask\.png\)/);
  assert.match(wrapped, /copy the generated image file to \/tmp\/cleaned\.png/);
  assert.doesNotMatch(wrapped, /Additional direction from the letterer/);
});

test("overlong Codex prompts are rejected", () => {
  assert.throws(() => normalizeCodexCleanPrompt("x".repeat(MAX_CODEX_CLEAN_PROMPT + 1)), /4000 characters/);
  assert.throws(
    () => composeCodexCleanInstructions(DEFAULT_CODEX_CLEAN_INSTRUCTIONS, "y".repeat(MAX_CODEX_CLEAN_PROMPT)),
    /4000 characters/,
  );
});

# Acceptance record — 6 September 2026

## Automated and local execution

- Core TypeScript suite: 13 tests passed, including failed-save retries, inflight edits, draft restoration, conflicts, migration preservation, restart recovery, idempotent page results, suggestions, numbering, TTF/OTF, irregular geometry, minimum-size overflow, dictionary fragment isolation, DPI, snapshot consistency, and PNG/PSD pixel and editable-text round-trips.
- Python cleaning suite: 4 tests passed in the workflow environment. Exact unmasked pixels, mask dimensions, brush/erase, uncertain enclosed geometry, and clone source validation are covered.
- Svelte/TypeScript check: zero errors, 30 warnings (existing editor/accessibility warnings and intentional initial prop captures). Production build passed.
- Browser acceptance: independent bilingual saves/reload, failed request retained across reload and retried, concurrent collaborator preserved on conflict, foreign-page reference rejected, mask and flat cleaning jobs, persistent undo/redo, renumbering, font upload, fitting, and labelled PNG export. It uses a temporary fixture database and no translation service.
- SAM 2.1 Small ran on CPU against an enclosed ellipse with box and point prompts: 36 polygon vertices, model confidence 0.866, `sam2._C` not loaded. Confidence is an indication from the model; output still requires review.

`npm test` writes PNG/PSD/ZIP examples to the temporary directory printed as **Export acceptance fixtures**. `npm run test:browser` prints its temporary fixture directory and writes screenshots to `/tmp/scan-acceptance`. These are review artifacts, not live chapter data. Run browser tests after check/build: those commands regenerate SvelteKit files and can cause a running Vite test browser to reload.

## Cleaning comparison

All measurements used the same native-resolution central 690 × 1800 crops from the available Korean color strips (`07/01.jpg` and `07/02.jpg`), CTD masks expanded by one pixel, CPU execution, one cold subprocess per method, and four PyTorch threads. Weights were cached. The reported worker time includes model initialization; peak resident memory includes libraries and loaded models. This is one run per crop/model, not a statistically stable speed ranking.

| Crop | Model               | Worker seconds | Peak RSS MiB | Changed channel values outside mask |
| ---- | ------------------- | -------------: | -----------: | ----------------------------------: |
| 01   | Existing LaMa ONNX  |          5.963 |       1023.6 |                                   0 |
| 01   | AnimeManga Big-LaMa |          4.710 |        991.4 |                                   0 |
| 01   | AOT ONNX            |          1.975 |        570.3 |                                   0 |
| 02   | Existing LaMa ONNX  |          4.538 |       1005.1 |                                   0 |
| 02   | AnimeManga Big-LaMa |          2.928 |       1002.8 |                                   0 |
| 02   | AOT ONNX            |          1.317 |        564.1 |                                   0 |

Visual inspection found that all three remove the main lettering but leave faint traces in white bubbles and some edges around lettering on dark textured narration. Mask review/expansion is still necessary. Small decorative detail intersecting the mask was disturbed in the first crop; unmasked bubble borders and artwork were unchanged by exact comparison. The second crop includes spiky bubble edges: they remain intact outside the mask, with visible faint residue inside. These are color webtoon examples, so manga screentone continuity and dense monochrome line art remain unassessed. No replacement default was promoted.

Reproduce on authorized local pages:

```bash
.venv-workflow/bin/python scripts/bench-cleaning.py --out /tmp/scan-cleaning-review page1.png page2.png
.venv-workflow/bin/python scripts/check-sam.py
```

The benchmark writes source crops, masks, each cleaned image, amplified differences, timing/memory JSON, and blank fields for a human quality score. For a curated full-size image, supply its approved mask with `--mask mask.png`; this disables automatic cropping. Inspect lettering edges, bubble borders and tails, lines passing through the masked area, and screentone phase/continuity at native scale. Keep original LaMa as default until a representative set passes without quality regressions.

## External checks still required

**Both AMD GPUs:** `/opt/rocm/bin/rocminfo` reports ROCk loaded, but opening `/dev/kfd` fails with `Invalid argument`. The installed PyTorch is 2.14.0+cpu, so the working environment establishes CPU execution only. The RX 7900 XTX support listing does not verify this Nobara installation. After fixing device access and installing matching ROCm PyTorch, run a tensor and the same benchmark separately with `--device cuda:0` and `--device cuda:1`, record `peakGPUBytes`, then submit two page jobs together and verify one executes on each card within its memory limit. No GPU performance or acceleration claim has been made.

**Photoshop editable reflow:** Photoshop is unavailable in this session. Fixture round-trips prove stored editable metadata and raster composites, not Photoshop's subsequent text recomposition. On the target editor:

1. Install the exact font versions identified by the exported manifest (FreeSans for the generated fixtures).
2. Open `1.psd` and the rotated/outlined PSD examples. Confirm hidden references, visible artwork, and exactly one editable text layer per bubble.
3. Compare the initial merged appearance against each corresponding PNG, then select the text tool. Check font identity, pt size at 72 and non-72 DPI, manual line breaks and chosen hyphens, leading, paragraph alignment/indents, rotation, and a single outline.
4. Edit a word, undo it, save, close, and reopen. Confirm no unexpected reflow, duplicate outline, glyph substitution, auto-hyphenation, or raster change. Record editor version and any mismatch before accepting PSD editing as production-verified.

The implementation provides explicit layer pixels and composite pixels so the initial raster appearance survives even where editable fonts or application layout differ. It does not claim identical reflow across applications.


## Automatic translation — 8 September 2026

The automatic flow now gathers context, reads bubble text with OCR and other text with vision, translates, and proofreads before publishing new English. Low-confidence bubble OCR automatically retries through vision. Repeated runs preserve approved human wording and ignored regions. New drafts still require human review.

Validation: 37 Node tests passed, including an isolated worker/model simulation of the complete sequence and repeated-run preservation; Svelte/TypeScript check passed with zero errors and 39 warnings; production build passed. Isolated browser acceptance covered the single automatic entry point, collapsed optional actions, approve-and-next in page/region order, durable saves/conflicts, cleaning, fonts, fitting, and draft export. Browser selectors were updated for the current unnumbered tabs, series font library, automatic style saving, and collapsed downloads panel. No live translation service was invoked; translation accuracy and detector coverage on representative real chapters remain to be assessed.

## Source review and Enquire — 9 September 2026

Separate chapter model settings now cover description, AI Vision, translation, text-only proofreading, Enquire, and up to four independent source reviewers. Automatic proofreading preserves translation drafts and publishes model-attributed suggestions. AI Review and Enquire can propose revision-protected source replacements as well as English changes.

Validation: 45 Node tests passed; Svelte/TypeScript reported zero errors and 47 existing warnings; the production build passed. Tests cover task-specific model routing, context exclusions and image attachments, malformed advisory responses, source punctuation, reviewer attribution, and preservation of English when accepting source. Isolated browser acceptance passed model settings persistence, multiple reviewers with a partial failure, raw crop preview, default context checkboxes, source/English action cards, stale-revision replacement, multi-turn chat and reopening a conversation, alongside the existing workflow suite. The chat screenshot is `/tmp/scan-acceptance/region-enquire.png`.

Tests used fixture AI responses and an isolated database. Live model compatibility and transcription/translation quality were not tested. Chat history lasts for the current editor session; accepted and pending suggestions persist across reloads.

### Grok acknowledgment fix

Grok's recorded response ended normally with an acknowledgment and no reading. Source review now uses its own required `status`, `source`, and `answer` schema and a completion-focused prompt. Empty readable results and acknowledgment-only replies are rejected, with one retry on the same crop; concrete unreadability explanations remain valid. Regression coverage includes the exact reported acknowledgment, retry limits, uncertainty, and cancellation. All 47 Node tests and the production build pass. A live Grok 4.6 test using synthetic lettering returned `そ〜！` with a completed explanation; the private original crop was not resent.

## Corrected Enquire context and source retranslation — 9 September 2026

Enquire now excludes legacy Source/Literal/Note annotations from attached region context and treats saved source/English as authoritative over older chat suggestions. Accepting a changed source from AI Review or Enquire starts a persisted translation job using the chapter translation model, without OCR or image rereading. Successful English becomes a reviewable draft; concurrent edits retain the result as a stale, revision-protected suggestion. Empty model responses preserve previous English. Cancellation and revision-checked retry are available through Jobs & downloads, and the open dialog follows the current saved text and translation status.

Validation: all 49 Node tests passed, including corrected context, configured model routing, source punctuation, duplicate/unchanged/rejected acceptance, forced acceptance, concurrent source and English edits, empty responses, cancellation, and retry. Svelte/TypeScript reported zero errors and 47 existing warnings; the production build passed. The isolated browser acceptance suite passed, including source-triggered retranslation and live dialog updates. Browser translation calls use a local fixture model server; live model quality was not tested.

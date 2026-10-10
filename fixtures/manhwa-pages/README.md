# Synthetic Korean benchmark fixtures

These eight AI-generated comic images were supplied by the project owner in
`ManhwaFixture`, chapter 1, and explicitly approved for bundling in this repository.
They are synthetic test material, not pages from a published manhwa. Original
upload names and SHA-256 hashes are recorded in `manifest.json`; the PNG bytes are
unchanged. No live database IDs or private chapter assets are required at runtime.

`gold.json` is version 1 of the agent-prepared gold standard. Each page was
inspected, then every annotated text crop was inspected again at native or larger
resolution. The agent checked the Korean transcription, lettering bounds, natural
English, literal English and meaning alternatives separately before model evaluation.
This is agent review, not certification by a native Korean human reviewer.

## Annotation conventions

- Coordinates are `[x0, y0, x1, y1]` in the 941 × 1672 source image and surround
  lettering, not balloons. Lines are listed in panel reading order (top to bottom,
  then left to right within a panel). Optional background signs do not determine
  dialogue reading order.
- Speech includes thought balloons and unballooned dialogue. Captions include
  narration and the incoming phone message. Speech, captions and SFX are required
  detection targets; titles/signs are neutral when missed or detected.
- Transcription follows the visible lettering rather than correcting grammar or
  making the eight independent scenes into a continuous story. Whitespace and
  punctuation are preserved for display, but ignored in the inherited OCR score.
- Punctuation-only reactions remain detection targets, without OCR or translation
  scores. Numeric-only signs use the existing `latin` flag: they can account for
  OCR output noise but do not contribute to character accuracy or translation.
- Unreadable generated signs and ambiguous expressive marks have `ocr: false`, an
  empty source and an explanation. Their boxes still participate in detection.
  Gold crops omit them; detector crops predominantly inside these boxes are also
  omitted from OCR, so guessing excluded glyphs does not earn accuracy or noise.
  A merged crop spanning both excluded and readable lettering can still contribute
  unmatched output to the existing page-level noise metric.
- English references are text-only. They are agent-prepared natural renderings,
  not an official English edition. Literal references preserve source phrasing;
  meaning keys accept alternative words. chrF measures overlap, not correctness.
- Page 4's first caption is unusual Korean as printed; its natural reference makes
  the implied feeling explicit, while the literal reference keeps the wording.
  Page 7's phone message is a required caption, while the sender and timestamp are signs.
- Page 3's two tiny expressive marks, page 2's distant classroom sign and page 5's
  clipped bus heading/timetable are detection-only. Product icons, motion strokes,
  hearts and other decorative shapes are not lettering targets.

This small set exercises color artwork, clean and stylized lettering, dark scenes,
outlined/white SFX, phone text and background signs. It does not establish quality
on long strips, historical scripts, real-world scan damage, or manhwa generally.

Changes to image bytes, annotations or scoring policy require incrementing the
`manhwa-ko` dataset version in `src/lib/benchmarkDatasets.ts` so earlier scores
are not merged with new ones.

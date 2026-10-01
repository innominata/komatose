# Lettering regression annotations

These annotations correspond to the eight prepared pages in a disposable local test episode.

Source pages are private and remain under `data/bench-lettering/baseline`. SHA-256 hashes bind the annotations to those exact prepared images. The repository stores annotations and binary masks, not manga pages.

Text boxes are manually located lettering groups. Detection metrics use one-to-one IoU >= 0.5 matches against **raw backend text boxes**; balloon fallbacks and the application’s final suppression are not included in that metric. Broad model boxes and split groups can therefore be counted as misses even when they cover the text.

Required-pixel masks sample lettering in manually selected areas. On pages 3–8 they sample clean dialogue, not all decorative SFX. Protected-pixel masks sample nearby artwork, faces, and the known screentone artifacts. These are regression checks, not exhaustive page annotations or a claim of perfect lettering extraction.

Copy the annotation JSON and PNGs into a matching captured baseline to run `scripts/bench-lettering.py`. The runner verifies source hashes before scoring. Keep the JSON and masks together.

`sfx.json` contains six separate large-SFX box targets on pages 4, 5, 7 and 8, used by `scripts/bench-coo.py`. They test the follow-up failures specifically, rather than sampling only dialogue. Report this targeted score separately from full-page detection precision/recall and pixel mask quality.

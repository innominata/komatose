import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFECT_DEFAULTS, effectFilters, effectsFromPsd, normalizeEffects, psdEffects, psdPatternUuid } from "../src/lib/textEffects";

const id = "0123456789abcdef0123456789abcdef";
const rect = { x: 0, y: 0, width: 200, height: 100 };
const tile = { uri: "data:image/png;base64,AAAA", width: 40, height: 20 };

test("pattern overlay validates its pattern id and scale", () => {
  const fx = normalizeEffects({ patternOverlay: { patternId: id, scale: 5000, opacity: -3, blend: "multiply" } })!;
  assert.deepEqual(fx.patternOverlay, { enabled: true, opacity: 0, blend: "multiply", patternId: id, scale: 1000 });
  assert.equal(normalizeEffects({ patternOverlay: { patternId: "../../etc" } })!.patternOverlay!.patternId, "");
});

test("pattern overlay tiles from the page origin at its scale, masked to the glyphs", () => {
  const effects = { patternOverlay: { ...EFFECT_DEFAULTS.patternOverlay, patternId: id, scale: 50, blend: "multiply" as const } };
  const fx = effectFilters(effects, 1, rect, rect, "#tx-f", tile);
  assert.match(fx.defs, /<pattern id="fx-pat" patternUnits="userSpaceOnUse" x="0" y="0" width="20" height="10">/);
  assert.match(fx.defs, /href="data:image\/png;base64,AAAA"/);
  assert.match(fx.defs, /<mask id="fx-gmask"/);
  assert.match(fx.overlay, /fill="url\(#fx-pat\)"[^>]*mask="url\(#fx-gmask\)" style="mix-blend-mode:multiply"/);
  // Without the tile (pattern removed from the library) the overlay draws nothing.
  assert.equal(effectFilters(effects, 1, rect, rect).overlay, "");
});

test("pattern and gradient overlays share one glyph mask, pattern underneath", () => {
  const effects = {
    patternOverlay: { ...EFFECT_DEFAULTS.patternOverlay, patternId: id },
    gradientOverlay: EFFECT_DEFAULTS.gradientOverlay,
  };
  const fx = effectFilters(effects, 1, rect, rect, "#tx-f", tile);
  assert.equal(fx.defs.match(/id="fx-gmask"/g)?.length, 1);
  assert.ok(fx.overlay.indexOf("fx-pat") < fx.overlay.indexOf("fx-grad"));
});

test("pattern overlay round-trips through Photoshop's effect by pattern UUID", () => {
  const effects = normalizeEffects({ patternOverlay: { patternId: id, scale: 37, opacity: 60, blend: "screen" } })!;
  const psd = psdEffects(effects, 300, () => "Dots 60") as Record<string, any>;
  assert.equal(psd.patternOverlay.pattern.id, psdPatternUuid(id));
  assert.equal(psd.patternOverlay.pattern.name, "Dots 60");
  assert.match(psd.patternOverlay.pattern.id, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  assert.equal(psd.patternOverlay.align, false);
  assert.deepEqual(effectsFromPsd(psd, 300)!.patternOverlay, effects.patternOverlay);
  // No pattern chosen: nothing for Photoshop to point at.
  assert.equal(psdEffects({ patternOverlay: EFFECT_DEFAULTS.patternOverlay }, 300).patternOverlay, undefined);
});

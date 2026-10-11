import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STYLE, regionPanelStyle, type TextStyle } from "../src/lib/workflow";

const seriesStyle: TextStyle = { ...DEFAULT_STYLE, size: 30, fill: "#ff0000", fontId: "series-font" };
const fitted: TextStyle = { ...DEFAULT_STYLE, size: 18, fill: "#00ff00", fontId: "region-font" };

test("a fitted region's style panel ignores a later series style", () => {
  const panel = regionPanelStyle(seriesStyle, {
    style: { size: 18 },
    layout: { style: fitted },
  });
  assert.equal(panel.size, 18);
  assert.equal(panel.fill, "#00ff00");
  assert.equal(panel.fontId, "region-font");
});

test("a region with no layout still follows the series style", () => {
  const panel = regionPanelStyle(seriesStyle, { style: { leading: 1.4 } });
  assert.equal(panel.size, 30);
  assert.equal(panel.fill, "#ff0000");
  assert.equal(panel.leading, 1.4);
});

test("a region with its own saved style ignores a later series default", () => {
  const owned: TextStyle = { ...DEFAULT_STYLE, size: 18, fill: "#00ff00", fontId: "region-font" };
  const panel = regionPanelStyle(seriesStyle, { style: owned });
  assert.equal(panel.size, 18);
  assert.equal(panel.fill, "#00ff00");
  assert.equal(panel.fontId, "region-font");
});

import { PATH_TEXT_TXT2 } from "./psdTemplates/pathText";
import { E, clone, get, parseEngineData, serializeEngineData, set, type EValue } from "./engineData";

/**
 * The document `Txt2` block Photoshop keeps beside the type layers. Type on a path lives only
 * here: the layer's `TySh` says box text over the path's bounds, and its text object's frame
 * (`/0 /8 /0 [n]`) holds the path as cubic Bezier segments. Following PhotoCraft
 * (crates/text/src/psd_path.rs and psd/build.rs, MIT/Apache-2.0), every object is a copy of one
 * Photoshop wrote, refitted to the new text: Photoshop refuses or crashes on hand-made minimal
 * objects. The template is Photoshop's own block from photocraft-corpus's
 * `text/path-wave-open.psd` (Apache-2.0); see psdTemplates/NOTICE.txt.
 */

export type Txt2Run = {
  length: number;
  font: string;
  /** Text-space points, like the layer's EngineData. */
  size: number;
  leading: number;
  fauxBold: boolean;
  fauxItalic: boolean;
  horizontalScale: number;
  verticalScale: number;
  tracking: number;
  baselineShift: number;
  fill: { r: number; g: number; b: number };
  stroke: { r: number; g: number; b: number };
};

export type Txt2Layer = {
  /** The layer's text with `\r` paragraph breaks, without the trailing `\r` Photoshop adds. */
  text: string;
  runs: Txt2Run[];
  justification: "left" | "right" | "center";
  /** Text-space geometry: a path as cubic segments `[p0, c1, c2, p3]`, or a box `[l, t, r, b]`. */
  frame: { path: [number, number][][] } | { box: [number, number, number, number] };
};

let template: EValue | undefined;
function loadTemplate(): EValue {
  template ??= parseEngineData(Buffer.from(PATH_TEXT_TXT2, "base64"));
  return clone(template);
}

const JUSTIFY = { left: 0, right: 1, center: 2 } as const;
const paint = (c: { r: number; g: number; b: number }) =>
  E.dict([
    ["99", E.name("SimplePaint")],
    ["0", E.dict([["0", E.int(1)], ["1", E.array([1, c.r / 255, c.g / 255, c.b / 255].map(E.real))]])],
  ]);

/** A box frame as Photoshop writes one: the rectangle as four straight segments from its top left. */
function boxFrame([l, t, r, b]: [number, number, number, number]): EValue {
  const c: [number, number][] = [[l, t], [r, t], [r, b], [l, b], [l, t]];
  const pts: EValue[] = [];
  for (let i = 0; i < 4; i++) for (const p of [c[i], c[i], c[i + 1], c[i + 1]]) pts.push(E.real(p[0]), E.real(p[1]));
  return E.dict([
    ["0", E.dict([
      ["1", E.dict([["0", E.array(pts)]])],
      ["2", E.dict([
        ["0", E.int(1)],
        ["6", E.array([E.real(-2), E.real(-2)])],
        ["11", E.dict([["4", E.int(-2)], ["18", E.real(-2)], ["22", E.real(0.025)]])],
      ])],
    ])],
  ]);
}

function pathFrame(base: EValue, segments: [number, number][][]): EValue {
  const frame = clone(base);
  const inner = get(frame, "0")!;
  set(inner, "1", E.dict([["0", E.array(segments.flat().flatMap(([x, y]) => [E.real(x), E.real(y)]))]]));
  const data = get(inner, "2");
  set(data, "0", E.int(2));
  // The path is written in text space.
  set(data, "2", E.array([1, 0, 0, 1, 0, 0].map(E.real)));
  return frame;
}

const utf16 = (s: string) => s.length;

/** The `Txt2` block for the document's type layers, in `TextIndex` order. */
export function buildTxt2(layers: Txt2Layer[]): Uint8Array {
  const outer = loadTemplate();
  const objectTemplate = get(outer, "1", "1", "0")!;
  const frameTemplate = get(outer, "0", "8", "0", "0")!;

  // Fonts: the template's first entry is the shape for ours; Photoshop's invisible-glyph font stays.
  const fontList = get(outer, "0", "1", "0");
  const fontShape = clone(get(fontList, "0")!);
  const invisible = fontList?.t === "array" ? fontList.v.find((f) => get(f, "0", "0", "0")?.t === "string" && (get(f, "0", "0", "0") as { v: string }).v === "AdobeInvisFont") : undefined;
  const fonts: string[] = [];
  const fontIndex = (name: string) => {
    let i = fonts.indexOf(name);
    if (i < 0) i = fonts.push(name) - 1;
    return i;
  };

  const frames: EValue[] = [];
  const objects: EValue[] = [];
  for (const [index, layer] of layers.entries()) {
    const text = `${layer.text}\r`;
    const paragraphs = text.split(/(?<=\r)/).map(utf16);
    const object = clone(objectTemplate);
    const model = get(object, "0")!;
    set(model, "0", E.string(text));

    const paragraphRun = get(model, "5", "0", "0")!;
    set(get(model, "5"), "0", E.array(paragraphs.map((length) => {
      const run = clone(paragraphRun);
      set(get(run, "0", "0", "5"), "0", E.int(JUSTIFY[layer.justification]));
      set(run, "1", E.int(length));
      return run;
    })));

    const styleRun = get(model, "6", "0", "0")!;
    const runs = layer.runs.map((r, i) => {
      const run = clone(styleRun);
      const s = get(run, "0", "0", "6")!;
      set(s, "0", E.int(fontIndex(r.font)));
      set(s, "1", E.real(r.size));
      set(s, "2", E.bool(r.fauxBold));
      set(s, "3", E.bool(r.fauxItalic));
      set(s, "4", E.bool(false));
      set(s, "5", E.real(r.leading));
      set(s, "6", E.real(r.horizontalScale));
      set(s, "7", E.real(r.verticalScale));
      set(s, "8", E.int(r.tracking));
      if (r.baselineShift) set(s, "9", E.real(r.baselineShift));
      set(s, "53", paint(r.fill));
      set(s, "54", paint(r.stroke));
      // The trailing paragraph mark takes the last run's style.
      set(run, "1", E.int(r.length + (i === layer.runs.length - 1 ? 1 : 0)));
      return run;
    });
    set(get(model, "6"), "0", E.array(runs));

    const view = get(object, "1")!;
    set(view, "0", E.array([E.dict([["0", E.int(index)]])]));
    const viewRun = get(view, "1", "0", "0")!;
    set(get(view, "1"), "0", E.array(paragraphs.map((length) => {
      const run = clone(viewRun);
      set(run, "1", E.int(length));
      return run;
    })));
    objects.push(object);
    frames.push("path" in layer.frame ? pathFrame(frameTemplate, layer.frame.path) : boxFrame(layer.frame.box));
  }

  set(get(outer, "0", "1"), "0", E.array([
    ...fonts.map((name) => {
      const entry = clone(fontShape);
      const font = get(entry, "0", "0")!;
      if (font.t === "dict") font.e = font.e.filter(([k]) => k !== "5");
      set(font, "0", E.string(name));
      set(font, "2", E.int(0));
      return entry;
    }),
    ...(invisible ? [clone(invisible)] : []),
  ]));
  set(get(outer, "0", "8"), "0", E.array(frames));
  set(get(outer, "1"), "1", E.array(objects));
  return serializeEngineData(outer);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  cleaningResidueInspector,
  outlineResidueInspector,
  cleaningDetailCrop,
  cleaningBoundaryInspector,
  cleaningSeamInspector,
  cleaningArtworkBounds,
  featherCleaningMask,
  type CleaningRegion,
} from "../src/lib/server/directorCleaningResidue";

const regions: CleaningRegion[] = [
  { id: "left", box: [0.17, 0.36, 0.22, 0.16] },
  { id: "right", box: [0.53, 0.36, 0.22, 0.16] },
];

test("outside-lettering review rejects erased neighbouring borders independently of a visual verdict", async () => {
  const render = (content: string) => sharp(Buffer.from(`<svg width="400" height="300"><rect width="400" height="300" fill="#aaccdd"/><path d="M190 0 V300 M0 170 H400" stroke="black" stroke-width="3"/>${content}</svg>`)).png().toBuffer();
  const region: CleaningRegion = { id: "aside", box: [.275,.3,.1875,.25] };
  const raw = await render('<text x="115" y="130" font-size="24">HEY</text>');
  const inspect = cleaningBoundaryInspector(raw, [region]);
  assert.deepEqual(await inspect(await render(''), ['aside']), [], 'Removed lettering with intact borders passes');
  for (const patch of ['<rect x="188" y="90" width="5" height="75" fill="#aaccdd"/>', '<rect x="110" y="168" width="75" height="5" fill="#aaccdd"/>']) {
    const result = await inspect(await render(patch), ['aside']);
    assert.equal(result.length, 1); assert.equal(result[0].lineId, 'aside');assert.ok(result[0].pixels > 20);
  }
  assert.deepEqual(await inspect(await render('<rect x="188" y="100" width="5" height="1" fill="#aaccdd"/>'), ['aside']), [], 'An isolated pixel seam is not a missing border');
});

test("full-region repairs erase outlined lettering while blending a rectangular background seam", async () => {
  const region:CleaningRegion={id:'aside',box:[.25,.3,.3,.2]};
  const b=cleaningArtworkBounds({x:.25,y:.3,w:.3,h:.2},{width:400,height:300});
  const svg=(body:string)=>Buffer.from(`<svg width="400" height="300"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#aaccdd"/><stop offset="1" stop-color="#d8e9ef"/></linearGradient></defs><rect width="400" height="300" fill="url(#sky)"/>${body}</svg>`);
  const raw=await sharp(svg('<text x="115" y="130" font-size="28" stroke="white" stroke-width="4" paint-order="stroke">HEY</text><path d="M223 112 L228 130" stroke="white" stroke-width="7"/><path d="M223 112 L228 130" stroke="black" stroke-width="3"/>')).png().toBuffer();
  const candidate=await sharp(svg(`<rect x="${b.x*400}" y="${b.y*300}" width="${b.w*400}" height="${b.h*300}" fill="#b5d5e1"/>`)).png().toBuffer();
  // cv2.fillPoly includes the final row/column of its rectangle.
  const mask=await sharp(Buffer.from(`<svg width="400" height="300"><rect width="400" height="300" fill="black"/><rect x="${b.x*400}" y="${b.y*300}" width="${b.w*400+1}" height="${b.h*300+1}" fill="white"/></svg>`)).png().toBuffer();
  const inspect=cleaningSeamInspector(raw,[region]);
  assert.equal((await inspect(candidate,['aside'])).length,1,'The original hard rectangle must fail');
  const feathered=await featherCleaningMask(mask,region);
  const alpha=await sharp(feathered).greyscale().raw().toBuffer();
  const rgb=await sharp(candidate).removeAlpha().raw().toBuffer();
  const rgba=Buffer.alloc(400*300*4);
  for(let p=0;p<alpha.length;p++){rgb.copy(rgba,p*4,p*3,p*3+3);rgba[p*4+3]=alpha[p];}
  const overlay=await sharp(rgba,{raw:{width:400,height:300,channels:4}}).png().toBuffer();
  const blended=await sharp(raw).composite([{input:overlay}]).png().toBuffer();
  assert.deepEqual(await inspect(blended,['aside']),[],'A blended join must pass');
  const pixels=await sharp(blended).removeAlpha().raw().toBuffer();
  for(let y=95;y<145;y++)for(let x=105;x<215;x++) {
    const p=(y*400+x)*3;assert.deepEqual([...pixels.subarray(p,p+3)],[181,213,225],'Text and outline inside the box are fully replaced');
  }
  for(let y=110;y<134;y++)for(let x=221;x<232;x++) {
    const p=(y*400+x)*3;assert.deepEqual([...pixels.subarray(p,p+3)],[181,213,225],'Outlined strokes just outside a tight OCR box must not fade back in from RAW');
  }
  const protectedMask=await sharp(mask).composite([{input:Buffer.from('<svg width="400" height="300"><rect x="140" y="90" width="5" height="60" fill="black"/></svg>')}]).png().toBuffer();
  const protectedPixels=await sharp(await featherCleaningMask(protectedMask,region)).greyscale().raw().toBuffer();
  assert.equal(protectedPixels[120*400+142],0,'Feathering cannot open a protected mask area');
});
const image = (content: string, background = "#fff") =>
  sharp(
    Buffer.from(
      `<svg width="500" height="360"><rect width="500" height="360" fill="#8099aa"/><path d="M 220 115 C 170 55 60 90 60 170 C 60 250 180 285 230 225 C 300 285 400 250 400 170 C 400 90 290 65 220 115 Z" fill="${background}" stroke="#000" stroke-width="4"/>${content}</svg>`,
    ),
  )
    .png()
    .toBuffer();
const letters =
  '<text x="90" y="180" font-size="28">HELLO</text><text x="270" y="180" font-size="28">OH</text>';

test("unreadable leftover strokes fail even when most original lettering is gone", async () => {
  const raw = await image(letters);
  const check = cleaningResidueInspector(raw, regions);
  const candidate = await image(
    '<path d="M 284 154 Q 307 153 306 172 M 279 178 Q 300 193 320 180" fill="none" stroke="#333" stroke-width="2"/>',
  );
  const found = await check(candidate);
  assert.equal(found.length, 1);
  assert.equal(found[0].lineId, "right");
  assert.ok(found[0].pixels > 20);
  assert.deepEqual(found[0].connectedRegionIds, ["left", "right"]);
  assert.ok(found[0].bounds.x > 0.53);
  assert.deepEqual(
    await check(await image("")),
    [],
    "A genuinely blank connected interior passes",
  );
});

test("a local check ignores source lettering in the neighbouring connected lobe", async () => {
  const raw = await image(letters);
  const check = cleaningResidueInspector(raw, regions);
  const candidate = await image(
    '<text x="270" y="180" font-size="28">OH</text>',
  );
  assert.deepEqual(await check(candidate, ["left"]), []);
  assert.equal((await check(candidate))[0].lineId, "right");
});

test("plain dark balloons also reject white character fragments", async () => {
  const raw = await image(
    '<text x="90" y="180" font-size="28" fill="white">HELLO</text><text x="270" y="180" font-size="28" fill="white">OH</text>',
    "#101010",
  );
  const check = cleaningResidueInspector(raw, regions);
  const bad = await image(
    '<path d="M 282 156 Q 304 153 305 176" fill="none" stroke="white" stroke-width="2"/>',
    "#101010",
  );
  assert.equal((await check(bad))[0].lineId, "right");
  assert.deepEqual(await check(await image("", "#101010")), []);
});

test("isolated compression specks and the real balloon outline do not fail a clean", async () => {
  const check = cleaningResidueInspector(await image(letters), regions);
  const candidate = await image(
    '<rect x="280" y="157" width="1" height="1" fill="#888"/><rect x="305" y="180" width="1" height="1" fill="#777"/>',
  );
  assert.deepEqual(await check(candidate), []);
  const thin = await image(
    '<rect x="285" y="155" width="1" height="12" fill="#555"/>',
  );
  assert.equal(
    (await check(thin))[0].lineId,
    "right",
    "A thin but sustained stroke is still a remnant",
  );
});

test("open backgrounds and text boxes touching the real outline defer to visual review", async () => {
  const open = await sharp(
    Buffer.from(
      '<svg width="500" height="360"><rect width="500" height="360" fill="white"/><text x="270" y="180" font-size="28">OH</text></svg>',
    ),
  )
    .png()
    .toBuffer();
  assert.deepEqual(await cleaningResidueInspector(open, regions)(open), []);
  const raw = await image(letters);
  const border: CleaningRegion[] = [
    { id: "border", box: [0.105, 0.4, 0.08, 0.16] },
  ];
  assert.deepEqual(
    await cleaningResidueInspector(raw, border)(await image("")),
    [],
    "The outer outline is not leftover ink",
  );
});

test("halftones and illustrated interiors retain visual review instead of being treated as empty bubbles", async () => {
  const pattern = Array.from({ length: 17 }, (_, y) =>
    Array.from(
      { length: 38 },
      (_, x) =>
        `<rect x="${90 + x * 7}" y="${125 + y * 7}" width="2" height="2" fill="#999"/>`,
    ).join(""),
  ).join("");
  const raw = await image(pattern + letters),
    candidate = await image(pattern);
  assert.deepEqual(await cleaningResidueInspector(raw, regions)(candidate), []);
  const decoration = '<circle cx="325" cy="211" r="10" fill="#555"/>';
  assert.deepEqual(
    await cleaningResidueInspector(
      await image(decoration + letters),
      regions,
    )(await image(decoration)),
    [],
  );
});

test("detail crops magnify only the candidate text area, including a small safety margin", async () => {
  const bytes = await image(
    '<path d="M 284 154 Q 307 153 306 172" fill="none" stroke="#333" stroke-width="2"/>',
  );
  const detail = await cleaningDetailCrop(bytes, regions[1]);
  const meta = await sharp(detail).metadata();
  assert.equal(meta.width, 700);
  assert.ok(meta.height! > 300);
  await assert.rejects(
    cleaningResidueInspector(
      bytes,
      regions,
    )(await sharp(bytes).resize(250).png().toBuffer()),
    /dimensions/,
  );
});

test("white outline residue counts islands left on dark art, not page gutter the lettering crossed", async () => {
  const W = 200, H = 120;
  // Grey art below y=40, white gutter above it.
  const page = () => {
    const px = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.fill(y < 40 ? 255 : 100, (y * W + x) * 3, (y * W + x) * 3 + 3);
    return px;
  };
  const png = (px: Buffer) => sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const paint = (px: Buffer, x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3);
  };
  const raw = page();
  // A black letter poking into the gutter, and one on the dark art with a white outline.
  paint(raw, 40, 30, 50, 55, 0);
  paint(raw, 116, 66, 134, 94, 255); paint(raw, 120, 70, 130, 90, 0);
  const regions: CleaningRegion[] = [
    { id: "gutter", box: [30 / W, 26 / H, 30 / W, 34 / H] },
    { id: "island", box: [112 / W, 62 / H, 26 / W, 36 / H] },
  ];
  const inspect = outlineResidueInspector(await png(raw), regions);
  const cleaned = page();
  assert.deepEqual(await inspect(await png(cleaned), ["gutter", "island"]), [], "A full clean passes");
  paint(cleaned, 116, 66, 134, 94, 255); paint(cleaned, 120, 70, 130, 90, 100);
  assert.deepEqual((await inspect(await png(cleaned), ["gutter", "island"])).map((f) => f.lineId), ["island"]);
});

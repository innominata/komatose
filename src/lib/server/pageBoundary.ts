import sharp from "sharp";
import {
  captureReframe,
  executeReframe,
  validateReframe,
  type ReframeOutput,
} from "./pageReframe";
import type { PageEditCtx } from "./reslice";
import { WorkflowError } from "./workflowStore";
import { isCreditsPage } from "../credits";
import { listImages } from "./queries";

export async function boundaryPlan(
  ctx: PageEditCtx,
  imageId: string,
  cutY: number,
) {
  const images = await listImages(ctx.episode.id),
    index = images.findIndex((i) => i.id === imageId),
    page = images[index];
  if (!page || isCreditsPage(page))
    throw new WorkflowError("Choose a story page");
  if (!Number.isInteger(cutY) || cutY <= 0 || cutY >= page.height)
    throw new WorkflowError(
      "Place the boundary inside the page at a whole pixel position",
    );
  const previous = cutY <= page.height / 2,
    neighbor = images[index + (previous ? -1 : 1)];
  if (!neighbor || isCreditsPage(neighbor))
    throw new WorkflowError(
      `There is no adjacent ${previous ? "previous" : "next"} story page. Move the line to the other half of this page.`,
    );
  const ids = previous ? [neighbor.id, page.id] : [page.id, neighbor.id],
    capture = await captureReframe(ctx, ids);
  const width = Math.max(page.width, neighbor.width),
    px = Math.floor((width - page.width) / 2),
    nx = Math.floor((width - neighbor.width) / 2);
  const own = (y: number, height: number, destY = 0) => ({
    imageId: page.id,
    rect: { x: 0, y, width: page.width, height },
    x: px,
    y: destY,
  });
  const other = (y = 0) => ({
    imageId: neighbor.id,
    rect: { x: 0, y: 0, width: neighbor.width, height: neighbor.height },
    x: nx,
    y,
  });
  const outputs: ReframeOutput[] = previous
    ? [
        {
          id: neighbor.id,
          width,
          height: neighbor.height + cutY,
          placements: [other(), own(0, cutY, neighbor.height)],
        },
        {
          id: page.id,
          width,
          height: page.height - cutY,
          placements: [own(cutY, page.height - cutY)],
        },
      ]
    : [
        { id: page.id, width, height: cutY, placements: [own(0, cutY)] },
        {
          id: neighbor.id,
          width,
          height: page.height - cutY + neighbor.height,
          placements: [
            own(cutY, page.height - cutY),
            other(page.height - cutY),
          ],
        },
      ];
  validateReframe(capture, outputs);
  return {
    capture,
    outputs,
    ids,
    direction: previous ? "previous" : "next",
    pixels: previous ? cutY : page.height - cutY,
    neighborId: neighbor.id,
    imageId,
    cutY,
  };
}
export async function previewBoundary(
  ctx: PageEditCtx,
  imageId: string,
  cutY: number,
) {
  const plan = await boundaryPlan(ctx, imageId, cutY),
    previews = [];
  for (const out of plan.outputs) {
    const overlays = [];
    for (const p of out.placements) {
      const s = plan.capture.sources.find((s) => s.image.id === p.imageId)!;
      overlays.push({
        input: await sharp(s.raw)
          .extract({
            left: p.rect.x,
            top: p.rect.y,
            width: p.rect.width,
            height: p.rect.height,
          })
          .png()
          .toBuffer(),
        left: p.x,
        top: p.y,
      });
    }
    const bytes = await sharp({
      create: {
        width: out.width,
        height: out.height,
        channels: 4,
        background: "#fff",
      },
    })
      .composite(overlays)
      .png()
      .toBuffer();
    const preview = await sharp(bytes)
      .resize({
        width: Math.min(600, out.width),
        height: 1600,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer();
    previews.push({
      id: out.id,
      width: out.width,
      height: out.height,
      preview: `data:image/jpeg;base64,${preview.toString("base64")}`,
    });
  }
  return {
    imageId,
    cutY,
    direction: plan.direction,
    pixels: plan.pixels,
    neighborId: plan.neighborId,
    revisionToken: plan.capture.token,
    pages: previews,
  };
}
export async function moveBoundary(
  ctx: PageEditCtx,
  imageId: string,
  cutY: number,
  revisionToken: string,
) {
  if (typeof revisionToken !== "string" || !revisionToken)
    throw new WorkflowError("Preview the boundary before applying it");
  const plan = await boundaryPlan(ctx, imageId, cutY);
  return executeReframe(
    ctx,
    plan.ids,
    plan.outputs,
    `Move ${plan.pixels}px to ${plan.direction} page`,
    revisionToken,
  );
}

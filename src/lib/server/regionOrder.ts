import { eq } from "drizzle-orm";
import { placeRegionAfter } from "../readingOrder";
import type { LineRow } from "../types";
import { db, sqlite } from "./db";
import { lines } from "./db/schema";
import { now } from "./ids";
import { listLines } from "./queries";
import { broadcast } from "./realtime";
import { WorkflowError } from "./workflowStore";

export async function reorderPageRegions(
  episodeId: string,
  imageId: string,
  afterId: string | null,
  movedId: string,
): Promise<LineRow[]> {
  const pageLines = (await listLines(episodeId)).filter((line) => line.imageId === imageId);
  const reordered = placeRegionAfter(pageLines, (line) => line.id, afterId, movedId);
  if (!reordered) {
    const moved = pageLines.find((line) => line.id === movedId);
    const after = afterId ? pageLines.find((line) => line.id === afterId) : true;
    if (!moved || !after) throw new WorkflowError("Both regions must be on this page", 400);
    throw new WorkflowError(
      afterId == null ? "That region is already first" : "That region is already next in reading order",
      400,
    );
  }
  sqlite.transaction(() => {
    for (const [i, line] of reordered.entries()) {
      db.update(lines)
        .set({ sortOrder: i + 1, updatedAt: now() })
        .where(eq(lines.id, line.id))
        .run();
    }
  })();
  const updated = (await listLines(episodeId)).filter((line) => line.imageId === imageId);
  for (const line of updated) broadcast(episodeId, { type: "line:upsert", line });
  return updated;
}

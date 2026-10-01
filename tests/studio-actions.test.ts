import { test } from "node:test";
import assert from "node:assert/strict";
import { STUDIO_ACTIONS, searchStudioActions } from "../src/lib/studioActions";

test("every studio action has a home, an old location, and a navigation target", () => {
  assert.ok(STUDIO_ACTIONS.length >= 100);
  const labels = STUDIO_ACTIONS.map((action) => action.label);
  assert.equal(new Set(labels).size, labels.length, "duplicate action label");
  for (const action of STUDIO_ACTIONS) {
    assert.ok(action.where.trim(), action.label);
    assert.ok(action.was.trim(), action.label);
    assert.equal(typeof action.go, "object");
  }
});

test("find-an-action matches each word, including old names", () => {
  const marked = searchStudioActions("clear history");
  assert.ok(marked.some((action) => action.label.includes("Mark page complete")));
  assert.equal(searchStudioActions("zzzz-no-such-action").length, 0);
  const detector = searchStudioActions("koharu detector");
  assert.ok(detector.some((action) => action.go.settings === "detection"));
});

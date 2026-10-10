<script lang="ts">
  import "./studio-controls.css";
  import type { RegionData, WorkflowDoc } from "$lib/workflow";

  let {
    regionDoc,
  }: {
    regionDoc: WorkflowDoc<RegionData>;
  } = $props();
</script>

<section class="geometry wf-ui">
  <h2>Bubble interior / text box</h2>
  <details>
    <summary>Editing the bubble boundary</summary>
    <p>
      Exclude tails and borders. Fit bubble uses SAM with the region box and an
      interior point (or your draft points). Draw polygon clears the current bubble and starts
      a new trace. Click the first point, or press Enter or Esc, to save it as
      approved geometry and auto-fit text. Shift-click a blue point to remove it.
      Saved polygons need at least three points.
    </p>
  </details>
  <p>
    {regionDoc.data.geometryApproved ? "Approved" : "Needs review"}{regionDoc.data
      .geometryConfidence != null
      ? ` · confidence ${Math.round(regionDoc.data.geometryConfidence * 100)}%`
      : ""}
  </p>
</section>

<style>
  .geometry {
    padding: 12px 14px;
    display: grid;
    gap: 8px;
    border-bottom: 1px solid var(--hud-line);
  }
  h2 {
    font:
      700 12px "Manrope", sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }
</style>

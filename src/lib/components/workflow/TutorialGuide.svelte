<script lang="ts" module>
  import type { StudioGo } from "$lib/studioActions";

  export type TutorialStep = { title: string; body: string; go?: StudioGo; find?: string };

  /** The basic path through a chapter, one task per card. */
  export const TUTORIAL_STEPS: TutorialStep[] = [
    {
      title: "Welcome to the chapter studio",
      body: "A chapter moves left to right through six steps along the top: Prepare, Translate, Review, Clean, Typeset and Export. This tour shows the one thing to do in each. Press Show me on any card and the studio jumps there and highlights the control.",
      find: "stepper-nav",
    },
    {
      title: "1 · Add your pages",
      body: "In Prepare, click the Add images tile, drop files onto it, or paste an image. A preview opens so you can check the reading order, remove strays, then Upload — or Cancel to back out.",
      go: { stage: "prepare", prepView: "grid" },
      find: "upload",
    },
    {
      title: "2 · Put them in order",
      body: "Drag thumbnails to reorder. Tick checkboxes (Shift-click for a range) to delete pages or extract them to a new chapter. If a banner says numbering is stale, Renumber before exporting.",
      go: { stage: "prepare", prepView: "grid" },
      find: "organize",
    },
    {
      title: "3 · Transcribe and translate",
      body: "In Translate, choose whether buttons run on this page or the whole chapter, then press Transcribe to find and read the lettering, and Translate to draft English.",
      go: { stage: "translate" },
      find: "transcribe",
    },
    {
      title: "4 · Add a region",
      body: "Transcribe finds most lettering, but you can add what it missed. Pick the Draw region tool on the left (or press R) and drag a box over the text. The new region gets read and appears in the list on the right.",
      go: { stage: "translate", tool: "region" },
      find: "tool-region",
    },
    {
      title: "5 · Change a region's type",
      body: "Each region has a type — dialogue, narration, sound effect and so on — which decides how it is translated and lettered. Select a region and pick its type from the menu at the top of its card.",
      go: { stage: "translate", tab: "regions" },
      find: "region-type",
    },
    {
      title: "6 · Delete a region",
      body: "Right-click a region on the page (or use ⋯ on its card) and choose Delete region. With a region selected you can also press Delete. Its text stays in the revision history.",
      go: { stage: "translate", tab: "regions", menu: "region" },
      find: "delete-region",
    },
    {
      title: "7 · Review every line",
      body: "Review walks the queue of lines. Edit the English, accept or reject suggestions, and approve each line so it counts as done.",
      go: { stage: "review", tab: "queue" },
      find: "tab-review-queue",
    },
    {
      title: "8 · Clean the original lettering",
      body: "Clean follows the pipeline left to right: build the mask over the original text, remove it, then touch up and approve the page.",
      go: { stage: "clean" },
      find: "clean-pipeline",
    },
    {
      title: "9 · Letter the English",
      body: "In Typeset, Auto-fit places the English into each bubble. Select a region to adjust its font, size or shape by hand.",
      go: { stage: "typeset" },
      find: "autofit-all",
    },
    {
      title: "10 · Export",
      body: "Export lists anything still unfinished. Resolve it, then download the chapter.",
      go: { stage: "export" },
      find: "download",
    },
    {
      title: "Lost? Find an action",
      body: "Press Ctrl K anywhere to search every action by name — it takes you to the right step and highlights the control. You can reopen this tour from the ⋯ menu.",
      find: "palette",
    },
  ];
</script>

<script lang="ts">
  let {
    open = $bindable(false),
    index = $bindable(0),
    onshow,
  }: {
    open?: boolean;
    index?: number;
    onshow: (step: TutorialStep) => void;
  } = $props();

  const step = $derived(TUTORIAL_STEPS[Math.min(index, TUTORIAL_STEPS.length - 1)]);
  const last = $derived(index >= TUTORIAL_STEPS.length - 1);

  function go(delta: number) {
    index = Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, index + delta));
    onshow(TUTORIAL_STEPS[index]);
  }
</script>

{#if open}
  <div class="tutorial" role="dialog" aria-label="Tutorial" aria-live="polite" data-find="tutorial">
    <header>
      <small>Tutorial · {index + 1} of {TUTORIAL_STEPS.length}</small>
      <button type="button" class="close" aria-label="Close tutorial" onclick={() => (open = false)}>×</button>
    </header>
    <h3>{step.title}</h3>
    <p>{step.body}</p>
    <div class="dots" aria-hidden="true">
      {#each TUTORIAL_STEPS as _, i}<button type="button" tabindex="-1" aria-label={`Go to tutorial step ${i + 1}`} class:on={i === index} onclick={() => go(i - index)}></button>{/each}
    </div>
    <footer>
      <button type="button" class="btn-hud-ghost" disabled={index === 0} onclick={() => go(-1)}>Back</button>
      {#if step.find}<button type="button" class="btn-hud-ghost" onclick={() => onshow(step)}>Show me</button>{/if}
      <span class="spacer"></span>
      {#if last}
        <button type="button" class="btn-hud" onclick={() => { open = false; index = 0; }}>Done</button>
      {:else}
        <button type="button" class="btn-hud" onclick={() => go(1)}>Next</button>
      {/if}
    </footer>
  </div>
{/if}

<style>
  .tutorial {
    position: fixed; z-index: 1010; right: 18px; bottom: 18px;
    width: min(360px, calc(100vw - 32px));
    padding: 12px 14px; background: var(--hud-bg); color: var(--hud-text);
    border: 1px solid var(--hud-teal-ink, var(--hud-line)); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    font-family: Inter, system-ui, sans-serif;
  }
  header { display: flex; justify-content: space-between; align-items: center; color: var(--hud-muted); }
  .close { background: none; border: 0; color: inherit; font-size: 18px; line-height: 1; cursor: pointer; }
  h3 { margin: 6px 0 4px; font-size: 15px; }
  p { margin: 0 0 10px; font-size: 13px; line-height: 1.45; }
  .dots { display: flex; gap: 5px; margin-bottom: 10px; }
  .dots button { width: 7px; height: 7px; padding: 0; border-radius: 50%; border: 0; background: var(--hud-line); cursor: pointer; }
  .dots button.on { background: var(--hud-teal, var(--hud-text)); }
  footer { display: flex; gap: 6px; align-items: center; }
  .spacer { flex: 1; }
</style>

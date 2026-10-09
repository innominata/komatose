<script lang="ts">
  import AiModelPicker from "./AiModelPicker.svelte";
  import type { TaskEngine } from "$lib/aiTasks";
  import { providerRunGate, selectProvidersForOperation, type LiveProviderEngine } from "$lib/providerCatalog";

  let { engines, chapterTitle, onrun, onopensettings }: {
    engines: LiveProviderEngine[];
    chapterTitle: string;
    onrun: (model: TaskEngine) => Promise<void>;
    onopensettings: () => void;
  } = $props();

  let dialog: HTMLDialogElement;
  let model = $state<TaskEngine>({ engine: "", model: "" });
  let starting = $state(false);
  let error = $state("");
  const options = $derived(selectProvidersForOperation(engines, "proofreadEnglish")
    .filter(row => !row.pageImageOnly && row.access !== "proofreader"));
  const gate = $derived(providerRunGate(model.engine, "proofreadEnglish", engines));
  const available = $derived(options.some(row => row.id === model.engine && row.available));

  export function open(preferred: TaskEngine[]) {
    error = "";
    const choices = [model, ...preferred];
    const chosen = choices.find(choice => options.some(row => row.id === choice.engine && row.available));
    model = chosen ? { ...chosen } : { engine: options.find(row => row.available)?.id || "", model: "" };
    if (!dialog.open) dialog.showModal();
  }

  async function run() {
    if (starting || !gate.ok || !available) return;
    starting = true;
    error = "";
    try {
      await onrun({ ...model });
      dialog.close();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally { starting = false; }
  }
</script>

<dialog class="hud-dialog-controls script-proofread" bind:this={dialog} aria-labelledby="script-proofread-title">
  <header class="hud-window-bar"><h3 id="script-proofread-title">Proofread entire script</h3></header>
  <form onsubmit={(event) => { event.preventDefault(); void run(); }}>
    <p>Proofread the original text and current English across every page in <strong>{chapterTitle}</strong>,
      with saved page descriptions, series notes and glossary for context. This is a text-only review; no images are sent.
      Corrections appear as suggestions beside the English for you to accept or reject.</p>
    <AiModelPicker bind:value={model} engines={options} label="Script proofreading model" disabled={starting} />
    <p class="muted">This model is used for this script run. Your saved page proofreader stays selected.</p>
    {#if !options.some(row => row.available)}
      <p role="status">No text proofreading model is available. Configure one in AI model settings.</p>
    {:else if !gate.ok}<p role="status">{gate.reason}</p>{/if}
    {#if error}<p class="failure" role="alert">{error}</p>{/if}
    <div class="hud-modal-actions">
      <button type="button" class="btn-hud-ghost" disabled={starting} onclick={() => { dialog.close(); onopensettings(); }}>AI model settings</button>
      <button type="button" class="btn-hud-ghost" onclick={() => dialog.close()}>Cancel</button>
      <button type="submit" class="btn-hud" disabled={starting || !gate.ok || !available}>{starting ? "Starting…" : "Proofread entire script"}</button>
    </div>
  </form>
</dialog>

<style>
  dialog { width: min(560px, calc(100vw - 2rem)); padding: 0; }
  form { display: grid; gap: 1rem; padding: 1.15rem; }
  p { margin: 0; line-height: 1.5; }
  .muted { color: var(--hud-muted); font-size: .85rem; }
  .failure { color: var(--hud-danger); }
  .hud-modal-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .5rem; }
</style>

<script lang="ts">
  import { tick } from "svelte";
  import type { CleanPromptDialogConfig } from "$lib/cleanPromptDialog";

  let dialog = $state<HTMLDialogElement | undefined>();
  let notesEl = $state<HTMLTextAreaElement | undefined>();
  let config = $state<CleanPromptDialogConfig | null>(null);
  let instructions = $state("");
  let notes = $state("");
  let error = $state("");
  let resolveOpen: ((prompt: string | null) => void) | null = null;

  const remaining = $derived(
    (config?.maxPrompt ?? 0) -
      (notes.trim()
        ? `${instructions.trim() || config?.defaultInstructions || ""}\n\nAdditional direction from the letterer:\n${notes.trim()}`
            .length
        : (instructions.trim() || config?.defaultInstructions || "").length),
  );

  function loadDraft(next: CleanPromptDialogConfig) {
    instructions = next.defaultInstructions;
    notes = "";
    error = "";
    try {
      const saved = JSON.parse(localStorage.getItem(next.storageKey) || "{}") as {
        instructions?: string;
        notes?: string;
      };
      if (typeof saved.instructions === "string" && saved.instructions.trim())
        instructions = saved.instructions;
      if (typeof saved.notes === "string") notes = saved.notes;
    } catch {
      /* ignore */
    }
  }

  function persist() {
    if (!config) return;
    try {
      localStorage.setItem(config.storageKey, JSON.stringify({ instructions, notes }));
    } catch {
      /* ignore */
    }
  }

  function finish(prompt: string | null) {
    resolveOpen?.(prompt);
    resolveOpen = null;
    if (dialog?.open) dialog.close();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  export async function open(next: CleanPromptDialogConfig): Promise<string | null> {
    config = next;
    loadDraft(next);
    if (!dialog) return null;
    try {
      if (!dialog.open) dialog.showModal();
    } catch {
      dialog.setAttribute("open", "");
    }
    await tick();
    notesEl?.focus();
    return new Promise((resolve) => {
      resolveOpen = resolve;
    });
  }

  function reconstruct() {
    if (!config) return;
    error = "";
    try {
      const prompt = config.compose(instructions, notes);
      persist();
      finish(prompt);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function cancel() {
    finish(null);
  }

  function resetPrompt() {
    instructions = config?.defaultInstructions || "";
    error = "";
  }
</script>

<dialog
  class="hud-modal hud-dialog-controls clean-prompt"
  bind:this={dialog}
  aria-labelledby="clean-prompt-title"
  oncancel={(e) => {
    e.preventDefault();
    cancel();
  }}
  onclose={() => {
    if (resolveOpen) finish(null);
  }}
>
  <header class="hud-window-bar">
    <h3 id="clean-prompt-title">{config?.title || "Reconstruction"}</h3>
  </header>
  <form
    class="clean-prompt-body"
    onsubmit={(e) => {
      e.preventDefault();
      reconstruct();
    }}
  >
    <p class="hud-option-hint" style="padding-left:0">
      {config?.hint}
    </p>
    <label>
      Extra notes
      <textarea
        bind:this={notesEl}
        bind:value={notes}
        rows="4"
        maxlength={config?.maxPrompt}
        placeholder="e.g. redraw the missing finger properly"
        onkeydown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            reconstruct();
          }
        }}
      ></textarea>
    </label>
    <details>
      <summary>Edit reconstruction prompt</summary>
      <label>
        {config?.blankLabel || "Prompt"}
        <textarea bind:value={instructions} rows="8" maxlength={config?.maxPrompt}></textarea>
      </label>
      <button class="btn-hud-ghost" type="button" onclick={resetPrompt}>Reset prompt</button>
    </details>
    <p class="count" class:over={remaining < 0}>{remaining} characters left</p>
    {#if error}<p class="failure" role="alert">{error}</p>{/if}
    <div class="hud-modal-actions">
      <button class="btn-hud-ghost" type="button" onclick={cancel}>Cancel</button>
      <button class="btn-hud" type="submit" disabled={remaining < 0}>Reconstruct</button>
    </div>
  </form>
</dialog>

<style>
  dialog.clean-prompt {
    width: min(640px, calc(100vw - 2rem));
    padding: 0;
    border-color: var(--hud-teal-ink);
  }
  .clean-prompt-body {
    display: grid;
    gap: 0.75rem;
    padding: 1rem 1.15rem 1.1rem;
  }
  label {
    display: grid;
    gap: 0.35rem;
    color: var(--hud-text);
    font-size: 0.82rem;
  }
  textarea {
    width: 100%;
    resize: vertical;
    min-height: 4.5rem;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--hud-line);
    border-radius: 2px;
    background: var(--hud-bg);
    color: var(--hud-text);
    font: 0.88rem/1.45 ui-sans-serif, system-ui, sans-serif;
    text-transform: none;
    letter-spacing: 0;
  }
  details {
    border: 1px solid var(--hud-line);
    padding: 0.55rem 0.7rem 0.7rem;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 0.82rem;
  }
  details[open] summary {
    margin-bottom: 0.55rem;
  }
  .count {
    margin: 0;
    color: var(--hud-muted);
    font-size: 0.75rem;
  }
  .count.over {
    color: var(--hud-danger);
  }
  .failure {
    margin: 0;
    color: #ffc283;
  }
  .hud-option-hint {
    margin: 0;
  }
</style>

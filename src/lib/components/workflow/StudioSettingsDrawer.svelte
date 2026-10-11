<script lang="ts">
  import type { Snippet } from "svelte";

  const SECTIONS: [string, string, string][] = [
    ["series", "Series", "Language & reading"],
    ["chapter", "Chapter", "This chapter"],
    ["detection", "Text detection", "This chapter"],
    ["models", "AI models", "Series"],
    ["guide", "Translation guide", "Chapter + series"],
    ["typography", "Typography", "Series"],
    ["colors", "Region types & colours", "Series + just you"],
    ["credits", "Series credits", "Series"],
  ];

  let {
    section = $bindable<string | null>(null),
    body,
  }: {
    section?: string | null;
    body?: Snippet<[string]>;
  } = $props();
</script>

{#if section}
  <div class="drawer-backdrop" role="presentation" onclick={() => (section = null)}></div>
  <aside class="drawer" aria-label="Settings" data-find="settings-drawer">
    <header>
      <strong>Chapter settings</strong>
      <span>Settings for this chapter and its series</span>
      <button type="button" aria-label="Close settings" onclick={() => (section = null)}>×</button>
    </header>
    <div class="drawer-body">
      <label class="mobile-section-picker">Settings section
        <select value={section} onchange={(event) => (section = event.currentTarget.value)}>
          {#each SECTIONS as [id, label] (id)}<option value={id}>{label}</option>{/each}
        </select>
      </label>
      <nav aria-label="Settings sections">
        {#each SECTIONS as [id, label, scope] (id)}
          <button type="button" class:on={section === id} aria-label={label} data-find={`set-${id}`} onclick={() => (section = id)}>
            <span>{label}</span>
            <small>{scope}</small>
          </button>
        {/each}
      </nav>
      <div class="drawer-panel" class:models={section === "models"}>
        {@render body?.(section)}
      </div>
    </div>
  </aside>
{/if}

<style>
  .drawer-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.35); }
  .drawer {
    position: fixed;
    z-index: 61;
    top: 0;
    right: 0;
    height: 100vh;
    height: 100dvh;
    width: 100vw;
    background: var(--hud-bg);
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--hud-line);
  }
  header span { color: var(--hud-muted); font-size: 13px; flex: 1; }
  header button { border: 0; background: transparent; color: inherit; font-size: 24px; width: 32px; height: 32px; cursor: pointer; }
  .drawer-body { display: flex; min-height: 0; flex: 1; }
  .mobile-section-picker { display: none; }
  nav {
    width: 210px;
    flex: 0 0 210px;
    border-right: 1px solid var(--hud-line);
    overflow: auto;
    padding: 16px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  nav button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    text-align: left;
    border: 0;
    background: transparent;
    color: inherit;
    padding: 10px 12px;
    border-radius: 6px;
    cursor: pointer;
  }
  nav button:hover { background: var(--hud-bg-2); }
  nav button.on { background: var(--hud-teal-dim); color: var(--hud-teal-ink); }
  nav small { color: var(--hud-muted); font-size: 11px; }
  .drawer-panel { flex: 1; min-width: 0; overflow: auto; padding: clamp(16px, 2vw, 32px); }
  .drawer-panel.models { overflow: hidden; padding: 0; }
  @media (max-width: 760px) {
    header { padding: 10px 14px; }
    header span { display: none; }
    header button { margin-left: auto; }
    .drawer-body { flex-direction: column; }
    nav { display: none; }
    .mobile-section-picker { display: grid; gap: 4px; padding: 10px 16px; border-bottom: 1px solid var(--hud-line); color: var(--hud-muted); font-size: 12px; }
    .mobile-section-picker select { width: 100%; padding: 8px; color: var(--hud-text); background: var(--hud-input-bg); border: 1px solid var(--hud-line); border-radius: 6px; }
  }
</style>

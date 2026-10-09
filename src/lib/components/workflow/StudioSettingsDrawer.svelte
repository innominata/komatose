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
      <strong>Settings</strong>
      <span>Series and chapter settings, in one place.</span>
      <button type="button" aria-label="Close settings" onclick={() => (section = null)}>×</button>
    </header>
    <div class="drawer-body">
      <nav>
        {#each SECTIONS as [id, label, scope] (id)}
          <button type="button" class:on={section === id} aria-label={label} data-find={`set-${id}`} onclick={() => (section = id)}>
            <span>{label}</span>
            <small>{scope}</small>
          </button>
        {/each}
      </nav>
      <div class="drawer-panel">
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
    width: min(920px, 100vw);
    background: var(--hud-bg);
    border-left: 1px solid var(--hud-line);
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--hud-line);
  }
  header span { color: var(--hud-muted); font-size: 13px; flex: 1; }
  header button { border: 0; background: transparent; color: inherit; font-size: 20px; }
  .drawer-body { display: flex; min-height: 0; flex: 1; }
  nav {
    width: 220px;
    flex: 0 0 220px;
    border-right: 1px solid var(--hud-line);
    overflow: auto;
    padding: 8px;
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
    padding: 8px;
    border-radius: 6px;
  }
  nav button.on { background: var(--hud-teal-dim); color: var(--hud-teal); }
  nav small { color: var(--hud-muted); font-size: 11px; }
  .drawer-panel { flex: 1; min-width: 0; overflow: auto; padding: 16px; }
</style>

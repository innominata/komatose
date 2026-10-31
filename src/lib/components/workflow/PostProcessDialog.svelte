<script lang="ts">
  import { POSTPROCESS_METHODS, postprocessLabel, type PostprocessMethod } from "$lib/postprocess";
  import type { ImageRow } from "$lib/types";
  import type { PageData } from "$lib/workflow";

  /**
   * Change how the page's last image-editor clean was matched to the page. One preview per
   * method, made from the saved answer (no model run); the method under the pointer shows
   * large. Applying rewrites the cleaned artwork as one undoable edit.
   */
  type Preview = { method: PostprocessMethod; asset?: string; error?: string; ms?: number };

  let {
    apiBase,
    asset,
    page,
    pageData,
    onclose,
    onapplied,
  }: {
    apiBase: string;
    asset: (hash?: string) => string;
    page: ImageRow;
    pageData: PageData;
    onclose: () => void;
    onapplied: () => void | Promise<void>;
  } = $props();

  const finish = $derived(pageData.cleanFinish && pageData.cleanFinish.result === pageData.cleaned ? pageData.cleanFinish : undefined);
  const current = $derived(finish?.method);
  let previews = $state<Preview[]>([]);
  let before = $state("");
  let loading = $state(false);
  let error = $state("");
  let hover = $state<PostprocessMethod | "">("");
  let pick = $state<PostprocessMethod | "">("");
  let applying = $state(false);
  let defaultMethod = $state<PostprocessMethod | "">("");
  let dialog = $state<HTMLDialogElement>();

  const shown = $derived(hover || pick || current || "");
  const large = $derived(previews.find((p) => p.method === shown));

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`${apiBase}/workflow`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function load() {
    if (!finish) return;
    loading = true;
    error = "";
    try {
      const data = await post({ action: "postprocess-previews", imageId: page.id });
      previews = data.previews;
      before = data.before;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    dialog?.showModal();
    pick = current ?? "";
    void load();
    void fetch(`${apiBase}/workflow?postprocess=1`).then((r) => r.json()).then((d) => (defaultMethod = d.method)).catch(() => {});
  });

  async function apply() {
    if (!pick || pick === current || applying) return;
    applying = true;
    error = "";
    try {
      await post({ action: "apply-postprocess", imageId: page.id, method: pick });
      await onapplied();
      close();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      applying = false;
    }
  }

  async function setDefault(method: PostprocessMethod) {
    try {
      defaultMethod = (await post({ action: "postprocess-default", method })).method;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function close() {
    if (dialog?.open) dialog.close();
    onclose();
  }
  const secs = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
</script>

<dialog class="hud-modal pp" bind:this={dialog} aria-labelledby="pp-title" onclose={onclose}>
  <header class="hud-window-bar"><h3 id="pp-title">Post-processing</h3></header>
  <div class="pp-body">
    {#if !finish}
      <p class="muted">This page's cleaning has no saved image-editor result. Post-processing applies to Qwen and FLUX cleans; clean the page again with one to change it.</p>
    {:else}
      <section class="pp-large">
        {#if large?.asset}
          <img src={asset(large.asset)} alt={`Result with ${postprocessLabel(large.method)}`} />
        {:else if before}
          <img src={asset(before)} alt="The page before cleaning" />
        {:else}
          <span class="muted">{loading ? "Making previews…" : ""}</span>
        {/if}
        <p class="muted">
          {#if shown}<b>{postprocessLabel(shown)}</b>{#if shown === current} · current{/if} · {POSTPROCESS_METHODS.find((m) => m.id === shown)?.hint}{/if}
        </p>
      </section>
      <div class="pp-grid" role="radiogroup" aria-label="Post-processing method">
        {#each POSTPROCESS_METHODS as m (m.id)}
          {@const p = previews.find((x) => x.method === m.id)}
          <label class="pp-card" class:picked={pick === m.id} class:current={current === m.id}
            onpointerenter={() => (hover = m.id)} onpointerleave={() => (hover = "")}>
            <input type="radio" name="pp-pick" value={m.id} bind:group={pick} />
            <div class="pp-img">
              {#if p?.asset}<img src={asset(p.asset)} alt="" />{:else if p?.error}<span>Failed</span>{:else}<span>{loading ? "…" : ""}</span>{/if}
            </div>
            <span class="pp-name"><b>{m.label}</b>{#if current === m.id} <small>current</small>{/if} <small>{p?.error ?? secs(p?.ms)}</small></span>
          </label>
        {/each}
      </div>
    {/if}
    {#if error}<p class="alert-hud" role="alert">{error}</p>{/if}
    <label class="pp-default">New image-editor cleans use
      <select value={defaultMethod} onchange={(e) => setDefault(e.currentTarget.value as PostprocessMethod)}>
        {#each POSTPROCESS_METHODS as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
      </select>
    </label>
  </div>
  <footer class="pp-foot">
    <button type="button" onclick={close}>Close</button>
    {#if finish}
      <button type="button" class="primary" disabled={!pick || pick === current || applying} onclick={apply}>
        {applying ? "Applying…" : pick && pick !== current ? `Use ${postprocessLabel(pick)}` : "Pick a method"}
      </button>
    {/if}
  </footer>
</dialog>

<style>
  .pp { width: min(1100px, 95vw); max-height: 92vh; padding: 0; }
  .pp[open] { display: flex; flex-direction: column; }
  .pp-body { padding: 12px 16px; overflow: auto; display: grid; gap: 12px; }
  .pp-large { display: grid; gap: 4px; }
  .pp-large img { width: 100%; max-height: 46vh; object-fit: contain; background: #fff; border: 1px solid var(--hud-line); border-radius: 4px; }
  .pp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
  .pp-card { display: grid; gap: 4px; padding: 6px; border: 1px solid var(--hud-line); border-radius: 5px; cursor: pointer; margin: 0; position: relative; }
  .pp-card.picked { border-color: var(--hud-teal-ink); box-shadow: inset 0 0 0 1px var(--hud-teal-ink); }
  .pp-card input { position: absolute; top: 8px; left: 8px; z-index: 1; }
  .pp-img { background: #fff; border-radius: 3px; display: grid; place-items: center; min-height: 100px; overflow: hidden; }
  .pp-img img { width: 100%; height: auto; display: block; }
  .pp-img span { color: #666; font-size: 12px; }
  .pp-name { font-size: 12px; }
  .pp-name small { color: var(--hud-muted); }
  .muted { font-size: 11.5px; color: var(--hud-muted); margin: 0; }
  .pp-default { display: flex; gap: 8px; align-items: center; font-size: 12px; }
  .pp-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--hud-line); }
</style>

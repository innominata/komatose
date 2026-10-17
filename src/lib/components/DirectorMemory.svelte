<script lang="ts">
  import { onMount } from "svelte";
  let {
    apiBase,
    models,
    disabled = false,
  }: {
    apiBase: string;
    models: { id: string; name: string; model: string }[];
    disabled?: boolean;
  } = $props();
  let memory = $state<any>(null),
    error = $state(""),
    saving = $state(false),
    notice = $state("");
  async function load() {
    try {
      const response = await fetch(`${apiBase}/director?memory=1`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      memory = result;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  function toggle(key: "episodeIds" | "imageIds" | "disabled", id: string) {
    memory.data[key] = memory.data[key].includes(id)
      ? memory.data[key].filter((value: string) => value !== id)
      : [...memory.data[key], id];
  }
  function fallback(id: string) {
    const model = models.find((item) => item.id === id)!;
    const current = memory.data.policy.fallbacks;
    memory.data.policy.fallbacks = current.some(
      (item: any) => item.engine === id,
    )
      ? current.filter((item: any) => item.engine !== id)
      : [...current, { engine: id, model: model.model }].slice(0, 3);
  }
  async function save(rebuild = false) {
    saving = true;
    error = "";
    notice = "";
    try {
      const response = await fetch(`${apiBase}/director`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "memory",
          revision: memory.revision,
          data: memory.data,
          rebuild,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      notice = rebuild
        ? "Memory cleared. The next run will relearn eligible examples."
        : "Series memory settings saved.";
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
  onMount(() => {
    void load();
  });
</script>

<section class="memory" aria-label="Series memory">
  <h3>Series memory</h3>
  <p>
    Director learns compact type descriptions from human-finished pages and
    references you select. Classification uses these descriptions and the
    current page. New categories stay provisional until you finish their pages
    or select them as references.
  </p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if memory}
    <p>
      {memory.examples.length} saved examples · {memory.eligibleExamples} eligible
      regions · revision {memory.revision}
    </p>
    <fieldset disabled={disabled || saving}>
      <legend>Reference chapters</legend>
      {#each memory.chapters as chapter}
        <label
          ><input
            type="checkbox"
            checked={memory.data.episodeIds.includes(chapter.id)}
            onchange={() => toggle("episodeIds", chapter.id)}
          />
          {chapter.title}
          {chapter.status === "done" ? "· human-finished" : ""}</label
        >
      {/each}
      <details>
        <summary>Select individual reference pages</summary>
        {#each memory.pages as page}
          <label
            ><input
              type="checkbox"
              checked={memory.data.imageIds.includes(page.id)}
              onchange={() => toggle("imageIds", page.id)}
            />
            {memory.chapters.find(
              (chapter: any) => chapter.id === page.episode_id,
            )?.title} · Page {page.page_number ?? page.original_name}</label
          >
        {/each}
      </details>
      <details>
        <summary>Typing rules and learned descriptions</summary>
        {#each memory.types as type}
          <div class="type">
            <label
              >{type.label}
              <textarea
                rows="2"
                placeholder="Optional rule that overrides inferred conventions"
                value={memory.data.rules[type.id] || ""}
                oninput={(event) =>
                  (memory.data.rules[type.id] = event.currentTarget.value)}
              ></textarea></label
            >
            {#each (memory.descriptions || []).filter((item: any) => item.typeId === type.id) as description}
              <p>
                <strong>Learned description:</strong>
                {description.description}
              </p>
              {#if description.conflicts}<p>
                  Ambiguity: {description.conflicts}
                </p>{/if}
              <small
                >{description.exampleIds.length} references · {description.stale
                  ? "needs refresh"
                  : "cached"}</small
              >
            {/each}
            <details>
              <summary>Reference examples</summary>
              {#each memory.examples.filter((example: any) => example.typeId === type.id) as example}
                <div class="example">
                  <img
                    src={`${apiBase}/workflow/assets/${example.crop}`}
                    alt={`Source example of ${type.label}`}
                    loading="lazy"
                  />
                  <img
                    src={`${apiBase}/workflow/assets/${example.rendered}`}
                    alt={`Lettering example of ${type.label}`}
                    loading="lazy"
                  />
                  <div>
                    <p>{example.cues}</p>
                    {#if example.conflicts}<p>
                        Ambiguity: {example.conflicts}
                      </p>{/if}
                    <small
                      >{memory.chapters.find(
                        (chapter: any) => chapter.id === example.episodeId,
                      )?.title} · Page {memory.pages.find(
                        (page: any) => page.id === example.imageId,
                      )?.page_number ?? example.imageId} · {example.stale
                        ? "needs refresh"
                        : "cached"}</small
                    >
                    <label
                      ><input
                        type="checkbox"
                        checked={memory.data.disabled.includes(example.id)}
                        onchange={() => toggle("disabled", example.id)}
                      /> Exclude this example</label
                    >
                  </div>
                </div>
              {/each}
            </details>
          </div>
        {/each}
      </details>
      {#if memory.provisionalTypes.length}<details>
          <summary
            >New provisional types ({memory.provisionalTypes.length})</summary
          >
          {#each memory.provisionalTypes as type}<p>
              <strong>{type.kind.label}</strong> · {type.reason}
            </p>{/each}
        </details>{/if}
      <details>
        <summary>Unattended run defaults</summary>
        <p>Fallback models (up to three, in selection order)</p>
        {#each models as model}<label
            ><input
              type="checkbox"
              checked={memory.data.policy.fallbacks.some(
                (item: any) => item.engine === model.id,
              )}
              onchange={() => fallback(model.id)}
            />
            {model.name}</label
          >{/each}
        <label
          >Cleaning method <select bind:value={memory.data.policy.cleanMethod}>
            <option value="auto">Automatic · configured default</option><option
              value="flat">Flat balloon fill</option
            ><option value="telea">Local inpainting</option>
            {#each (memory.imageChoices || []).filter((item: any) => item.tasks.includes("inpaint") || item.tasks.includes("cleaning")) as choice}<option
                value={choice.id}>{choice.label}</option
              >{/each}
          </select></label
        >
        <label
          >Cleaning fallback model <select
            aria-label="Cleaning fallback model"
            bind:value={memory.data.policy.cleanFallbackModel}
          >
            <option value="">None</option>
            {#each (memory.imageChoices || []).filter( (item: any) => item.tasks.includes("cleaning") ) as choice}<option
                value={choice.id}>{choice.label}</option
              >{/each}
          </select></label
        >
        <p>
          Try this image editor when the mask includes extra artwork or the
          normal cleaning fails. Director checks the result before saving it.
        </p>
        <label
          >Mask model <select bind:value={memory.data.policy.maskEngine}>
            <option value="auto">Configured default</option>
            {#each (memory.imageChoices || []).filter( (item: any) => item.tasks.includes("textMask") ) as choice}<option
                value={choice.id}>{choice.label}</option
              >{/each}
          </select></label
        >
        <label
          >Repair cycles per stage <input
            type="number"
            min="1"
            max="3"
            bind:value={memory.data.policy.repairCycles}
          /></label
        >
        <p>
          Temporary request failures receive up to two retries. Only configured
          models are used.
        </p>
      </details>
      <div class="buttons">
        <button type="button" onclick={() => save()}
          >Save memory settings</button
        ><button type="button" onclick={() => save(true)}
          >Rebuild learned memory</button
        >
      </div>
    </fieldset>
  {:else}<p>Loading series memory…</p>{/if}
</section>

<style>
  .memory {
    padding: 12px 0;
    font-size: 0.85rem;
  }
  .memory p {
    margin: 6px 0;
    line-height: 1.5;
  }
  .memory fieldset {
    border: 1px solid #8885;
    border-radius: 6px;
    padding: 12px;
  }
  .memory label {
    display: flex;
    gap: 7px;
    align-items: center;
    margin: 7px 0;
  }
  .memory details {
    margin: 12px 0;
  }
  .memory summary {
    cursor: pointer;
    font-weight: 600;
  }
  .type {
    border-top: 1px solid #8885;
    padding: 8px 0;
  }
  .type > label {
    display: grid;
  }
  .memory select,
  .memory textarea,
  .memory input:not([type="checkbox"]) {
    background: var(--hud-bg, #222);
    color: inherit;
    border: 1px solid #888;
    border-radius: 4px;
    padding: 6px;
  }
  .example {
    display: flex;
    gap: 10px;
    padding: 8px 0;
    flex-wrap: wrap;
  }
  .example img {
    max-width: 130px;
    max-height: 130px;
    object-fit: contain;
  }
  .example > div {
    flex: 1;
    min-width: 180px;
  }
  .buttons {
    display: flex;
    gap: 10px;
  }
  .buttons button {
    padding: 6px 10px;
    background: #334b5e;
    color: white;
    border: 1px solid #8093a2;
    border-radius: 4px;
  }
  small {
    color: var(--hud-muted, #aaa);
  }
</style>

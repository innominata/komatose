<script lang="ts">
  import { renderSafeMarkdown } from '$lib/safeMarkdown';
  import { unwrapProofreadCritique, type PageProofreadJob, type ProofreadFollowUpImage } from '$lib/pageProofread';

  let {
    job,
    asset,
    onclose,
    onfollowup,
    onattachpage,
  }: {
    job?: PageProofreadJob;
    asset: (hash?: string) => string;
    onclose: () => void;
    onfollowup?: (prompt: string, images: ProofreadFollowUpImage[]) => Promise<void>;
    onattachpage?: (variant: 'raw' | 'typeset') => Promise<Blob>;
  } = $props();

  let dialog: HTMLDialogElement;
  let prompt = $state('');
  let pasted = $state<{ mime: string; data: string; preview: string; label?: string }[]>([]);
  let sending = $state(false);
  let attaching = $state<'raw' | 'typeset' | null>(null);
  let followError = $state('');

  const pending = $derived(job && ['running', 'queued', 'cancelling'].includes(job.state));
  const canFollow = $derived(!!onfollowup && !!job && !pending && !sending && !attaching);
  const canAttach = $derived(canFollow && !!onattachpage && pasted.length < 8);
  const followUp = $derived(Boolean(job?.payload?.followUpOf || job?.progress?.prompt));
  const followImages = $derived(job?.progress?.snapshot?.followUpImages ?? []);
  const engineLabel = $derived(String(job?.payload?.engine ?? ''));
  const modelLabel = $derived(String(job?.payload?.model || 'default model'));
  const critiqueHtml = $derived(renderCritique(job?.progress?.critique || ''));

  let lastJobId = $state<string | undefined>(undefined);
  let imagesOpen = $state(false);

  $effect(() => {
    if (job && !dialog.open) {
      imagesOpen = false;
      dialog.showModal();
    }
  });

  $effect(() => {
    const id = job?.id;
    if (id === lastJobId) return;
    lastJobId = id;
    imagesOpen = false;
    prompt = '';
    followError = '';
    for (const item of pasted) URL.revokeObjectURL(item.preview);
    pasted = [];
  });

  function renderCritique(text: string) {
    const body = unwrapProofreadCritique(text);
    if (!body.trim()) return '';
    return renderSafeMarkdown(body, { breaks: true });
  }

  function blobToBase64(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.replace(/^data:[^;]+;base64,/, ''));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function filesToPastes(files: File[]) {
    const next = [...pasted];
    for (const file of files.slice(0, 8 - next.length)) {
      if (!file.type.startsWith('image/')) continue;
      const data = await blobToBase64(file);
      next.push({ mime: file.type || 'image/png', data, preview: URL.createObjectURL(file) });
    }
    pasted = next;
  }

  async function attachPage(variant: 'raw' | 'typeset') {
    if (!canAttach || !onattachpage) return;
    attaching = variant;
    followError = '';
    try {
      const blob = await onattachpage(variant);
      if (!blob.type.startsWith('image/') || pasted.length >= 8) return;
      const data = await blobToBase64(blob);
      pasted = [...pasted, {
        mime: blob.type || 'image/png',
        data,
        preview: URL.createObjectURL(blob),
        label: variant === 'typeset' ? 'Working draft' : 'Raw source',
      }];
    } catch (error) {
      followError = error instanceof Error ? error.message : String(error);
    } finally {
      attaching = null;
    }
  }

  function clipboardImages(event: ClipboardEvent | DragEvent) {
    const data = 'clipboardData' in event ? event.clipboardData : event.dataTransfer;
    const fromFiles = [...(data?.files || [])].filter((file) => file.type.startsWith('image/'));
    if (fromFiles.length) return fromFiles;
    return [...(data?.items || [])]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
  }

  function onPaste(event: ClipboardEvent) {
    const files = clipboardImages(event);
    if (!files.length) return;
    event.preventDefault();
    void filesToPastes(files);
  }

  function onDrop(event: DragEvent) {
    const files = clipboardImages(event);
    if (!files.length) return;
    event.preventDefault();
    void filesToPastes(files);
  }

  function removePaste(index: number) {
    const next = [...pasted];
    const [removed] = next.splice(index, 1);
    if (removed) URL.revokeObjectURL(removed.preview);
    pasted = next;
  }

  async function sendFollowUp() {
    if (!canFollow || !onfollowup) return;
    const text = prompt.trim();
    if (!text && !pasted.length) return;
    sending = true;
    followError = '';
    try {
      await onfollowup(text, pasted.map(({ mime, data }) => ({ mime, data })));
    } catch (error) {
      followError = error instanceof Error ? error.message : String(error);
    } finally {
      sending = false;
    }
  }

  function onComposerKey(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void sendFollowUp();
    }
  }
</script>

<dialog class="hud-dialog-controls page-proofread" bind:this={dialog} aria-labelledby="page-proofread-title" onclose={onclose}>
  <header>
    <div>
      <h2 id="page-proofread-title">{followUp ? 'Proofreader follow-up' : 'Page proofreader'}</h2>
      <p>{job?.progress?.snapshot?.pageLabel ?? 'Page'} · {engineLabel} / {modelLabel}</p>
    </div>
    <button type="button" aria-label="Close proofreader" onclick={() => dialog.close()}>Close</button>
  </header>
  <div class="report-scroll">
    <p class="hint">This critique is saved in Jobs. Close it to edit, then choose “Open critique” to return. Follow-ups reuse the same model conversation.</p>
    {#if followUp && job?.progress?.prompt}
      <section class="turn user-turn">
        <h3>You</h3>
        <p class="prompt">{job.progress.prompt}</p>
      </section>
    {/if}
    {#if followImages.length}
      <details bind:open={imagesOpen}>
        <summary>Images submitted · {new Date(job?.progress?.snapshot?.capturedAt ?? Date.now()).toLocaleString()}</summary>
        <div class="submitted-images follow-images">
          {#each followImages as hash, i}
            <figure>
              <figcaption>Pasted image {i + 1}</figcaption>
              <a href={asset(hash)} target="_blank" rel="noreferrer"><img src={asset(hash)} alt={`Image ${i + 1} sent with the follow-up`} /></a>
            </figure>
          {/each}
        </div>
      </details>
    {/if}
    {#if job?.progress?.snapshot && !followUp}
      <details bind:open={imagesOpen}>
        <summary>Images submitted · {new Date(job.progress.snapshot.capturedAt).toLocaleString()}</summary>
        <div class="submitted-images">
          <figure><figcaption>Raw source</figcaption><a href={asset(job.progress.snapshot.raw)} target="_blank" rel="noreferrer"><img src={asset(job.progress.snapshot.raw)} alt="Raw page submitted to the proofreader" /></a></figure>
          <figure><figcaption>Working typeset version</figcaption><a href={asset(job.progress.snapshot.typeset)} target="_blank" rel="noreferrer"><img src={asset(job.progress.snapshot.typeset)} alt="Typeset page submitted to the proofreader" /></a></figure>
        </div>
      </details>
    {/if}
    {#if pending}<p role="status">{job?.progress?.message || 'Proofreading…'} You can close this window while the job runs.</p>{/if}
    {#if job?.error}<p class="failure" role="alert">{job.error}</p>{/if}
    {#if job?.progress?.critique}
      <section class="turn assistant-turn">
        <h3>Critique</h3>
        <div class="critique">{@html critiqueHtml}</div>
      </section>
    {:else if !pending && !job?.error}
      <p>No saved critique for this job.</p>
    {/if}
  </div>
  <footer class="composer">
    <label class="composer-label" for="page-proofread-followup">Follow-up</label>
    <div
      class="composer-box"
      onpaste={onPaste}
      ondragover={(event) => { if (clipboardImages(event).length) event.preventDefault(); }}
      ondrop={onDrop}
    >
      {#if pasted.length}
        <div class="paste-thumbs">
          {#each pasted as image, i}
            <figure>
              <img src={image.preview} alt={image.label || `Pasted follow-up ${i + 1}`} />
              {#if image.label}<figcaption>{image.label}</figcaption>{/if}
              <button type="button" aria-label="Remove {image.label || `pasted image ${i + 1}`}" onclick={() => removePaste(i)}>Remove</button>
            </figure>
          {/each}
        </div>
      {/if}
      <textarea
        id="page-proofread-followup"
        bind:value={prompt}
        rows="3"
        placeholder="Ask a follow-up, or paste an image from the clipboard…"
        disabled={!canFollow}
        onkeydown={onComposerKey}
      ></textarea>
    </div>
    {#if followError}<p class="failure" role="alert">{followError}</p>{/if}
    <div class="composer-actions">
      <div class="attach-actions">
        <button type="button" disabled={!canAttach} onclick={() => void attachPage('typeset')}
          >{attaching === 'typeset' ? 'Attaching…' : 'Attach working draft'}</button>
        <button type="button" disabled={!canAttach} onclick={() => void attachPage('raw')}
          >{attaching === 'raw' ? 'Attaching…' : 'Attach raw source'}</button>
        <p class="hint">Working draft is the current typeset page. Paste or drop more images if needed. Ctrl+Enter sends.</p>
      </div>
      <button type="button" class="primary" disabled={!canFollow || (!prompt.trim() && !pasted.length)} onclick={() => void sendFollowUp()}
        >{sending ? 'Sending…' : 'Send follow-up'}</button>
    </div>
  </footer>
</dialog>

<style>
  dialog { width: min(1100px, 96vw); max-height: 92vh; padding: 0; color: var(--hud-text); background: var(--hud-bg-2); border: 1px solid var(--hud-line); border-radius: 2px; }
  dialog[open] { display: flex; flex-direction: column; }
  dialog::backdrop { background: #0009; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 16px 22px; border-bottom: 1px solid var(--hud-line); }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0 0 8px; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--hud-muted); }
  header p { margin: 6px 0 0; font-size: 12px; color: var(--hud-muted); }
  button { padding: 6px 12px; }
  .report-scroll { flex: 1; min-height: 0; overflow: auto; padding: 18px 22px; }
  .hint { color: var(--hud-muted); font-size: 13px; }
  .turn { margin: 16px 0; }
  .prompt { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
  .critique { overflow-wrap: anywhere; line-height: 1.65; }
  .critique :global(p) { margin: 0 0 12px; }
  .critique :global(ul), .critique :global(ol) { margin: 0 0 12px; padding-left: 1.4em; }
  .critique :global(code) { font-size: 0.92em; }
  .failure { color: #ffc283; white-space: pre-wrap; }
  .submitted-images { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .follow-images { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); margin: 12px 0; }
  figure { margin: 12px 0; }
  figcaption { margin-bottom: 8px; }
  img { width: 100%; height: auto; }
  summary { cursor: pointer; }
  .composer { border-top: 1px solid var(--hud-line); padding: 14px 22px 18px; background: var(--hud-bg); }
  .composer-label { display: block; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--hud-muted); margin-bottom: 8px; }
  .composer-box { border: 1px solid var(--hud-line); background: var(--hud-input-bg, var(--hud-bg-2)); padding: 8px; }
  .composer-box textarea { width: 100%; border: 0; background: transparent; color: inherit; resize: vertical; min-height: 4.5rem; }
  .composer-actions { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-top: 10px; }
  .attach-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
  .composer-actions .hint { margin: 0; flex: 1 1 12rem; }
  .paste-thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .paste-thumbs figure { margin: 0; width: 88px; position: relative; }
  .paste-thumbs img { display: block; width: 88px; height: 88px; object-fit: cover; }
  .paste-thumbs figcaption { position: absolute; left: 0; right: 0; bottom: 0; margin: 0; padding: 2px 4px; font-size: 10px; background: #000a; }
  .paste-thumbs button { position: absolute; right: 2px; top: 2px; padding: 2px 6px; font-size: 11px; }
  button.primary { border-color: var(--hud-teal); color: var(--hud-teal); }
</style>

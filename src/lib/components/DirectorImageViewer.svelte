<script lang="ts">
  let {src,label,onclose}:{src:string;label:string;onclose:()=>void}=$props();
  let dialog=$state<HTMLDialogElement>();
  let actualSize=$state(false);
  let dimensions=$state('');
  $effect(()=>{if(dialog && !dialog.open) dialog.showModal();});
</script>

<dialog bind:this={dialog} aria-label="Director log image" onclose={onclose} onclick={event=>{if(event.target===dialog) dialog?.close();}}>
  <header>
    <span>{label}{dimensions ? ` · ${dimensions}` : ''}</span>
    <div>
      <button type="button" aria-pressed={actualSize} onclick={()=>actualSize=!actualSize}>{actualSize?'Fit page':'Actual size'}</button>
      <a href={src} target="_blank" rel="noopener noreferrer">Open image in new tab ↗</a>
      <button type="button" aria-label="Close image preview" onclick={()=>dialog?.close()}>✕</button>
    </div>
  </header>
  <div class="image-scroll" class:actual={actualSize}>
    <img {src} alt={label} onload={event=>{const image=event.currentTarget as HTMLImageElement;dimensions=`${image.naturalWidth} × ${image.naturalHeight}`;}}>
  </div>
</dialog>

<style>
  dialog{width:96vw;height:94vh;max-width:none;max-height:none;margin:auto;padding:0;border:1px solid #666;border-radius:8px;background:var(--hud-bg,#1b2029);color:var(--hud-text,#eee)}
  dialog::backdrop{background:#000c}
  dialog[open]{display:flex;flex-direction:column}
  header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid #6665;flex-shrink:0;flex-wrap:wrap}
  header div{display:flex;align-items:center;gap:14px}button,a{color:inherit;font:inherit}button{background:#334b5e;border:1px solid #8093a2;border-radius:4px;padding:5px 9px;cursor:pointer}a{font-size:.85rem}
  .image-scroll{flex:1;min-height:0;overflow:auto;padding:12px;text-align:center;overscroll-behavior:contain}
  img{max-width:100%;max-height:100%;object-fit:contain;vertical-align:top;background:white}
  .actual{text-align:left}.actual img{max-width:none;max-height:none}
</style>

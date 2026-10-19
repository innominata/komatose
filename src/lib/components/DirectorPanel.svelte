<script lang="ts">
  import { onMount } from 'svelte';
  import DirectorImageViewer from './DirectorImageViewer.svelte';
  import { ALL_DIRECTOR_TASKS, DIRECTOR_TASKS, directorStatusLabel, type DirectorFinding, type DirectorTask } from '$lib/director';
  let { apiBase, scope, pageId, canEdit, busy, onnavigate, onsettings, models = $bindable([]), locked = $bindable(false), open = $bindable(false) }:
    {apiBase:string;scope:'page'|'chapter';pageId:string|null;canEdit:boolean;busy:boolean;onnavigate?:(pageId:string,lineId:string|undefined,stage:string)=>void;onsettings?:()=>void;models?:{id:string;name:string;model:string}[];locked?:boolean;open?:boolean}=$props();
  type Run = {id:string;scope:string;state:string;message:string;current_index:number;pageIds:string[];
    model:{engine:string;model:string};policy?:string;created_at:number};
  type Page = {id:string;pageNumber:number|null;clean:boolean;state:string;stage:string|null;findings:DirectorFinding[];detail:string;runId:string|null};
  type Event = {id:number;run_id:string;image_id:string|null;kind:string;detail:any;created_at:number};
  type Change = {id:number;image_id:string|null;label:string;undone:number;created_at:number};
  let pages=$state<Page[]>([]),runs=$state<Run[]>([]);
  let events=$state<Event[]>([]),changes=$state<Change[]>([]),selectedRun=$state(''),selectedModel=$state('');
  let recheckAll=$state(false),working=$state(false),error=$state('');
  const TASKS_KEY='komatose.director.tasks';
  function savedTasks():DirectorTask[] {
    try {
      const saved=JSON.parse(localStorage.getItem(TASKS_KEY)||'null');
      if (Array.isArray(saved)) return ALL_DIRECTOR_TASKS.filter(task=>saved.includes(task));
    } catch { /* Storage may be unavailable. */ }
    return [...ALL_DIRECTOR_TASKS];
  }
  let tasks=$state<DirectorTask[]>(savedTasks());
  $effect(()=>{ try { localStorage.setItem(TASKS_KEY,JSON.stringify(tasks)); } catch { /* Per-browser convenience only. */ } });
  const presets:{label:string;tasks:DirectorTask[]}[]=[
    {label:'All',tasks:[...ALL_DIRECTOR_TASKS]},
    {label:'Text',tasks:['prepare','proofread-raw']},
    {label:'Clean',tasks:['clean-bubbles','clean-hard','clean-sfx']},
    {label:'Finish',tasks:['typeset','proof']},
    {label:'None',tasks:[]},
  ];
  const samePreset=(list:DirectorTask[])=>list.length===tasks.length&&list.every(task=>tasks.includes(task));
  function toggleTask(task:DirectorTask,on:boolean) {
    tasks=ALL_DIRECTOR_TASKS.filter(item=>item===task?on:tasks.includes(item));
  }
  function runTasks(item:Run|undefined):DirectorTask[] {
    try { const saved=JSON.parse(item?.policy||'{}').tasks; return Array.isArray(saved)?saved:[...ALL_DIRECTOR_TASKS]; }
    catch { return [...ALL_DIRECTOR_TASKS]; }
  }
  const run=$derived(runs.find(item=>item.id===selectedRun));
  const page=$derived(pages.find(item=>item.id===pageId));
  let selectedPageId=$state<string|null>(null),selectedEventId=$state<number|null>(null);
  const logPage=$derived(pages.find(item=>item.id===(selectedPageId??pageId))??pages[0]);
  let eventContext='';
  $effect(()=>{
    const context=`${selectedRun}:${logPage?.id??''}`;
    if(context!==eventContext) {eventContext=context;selectedEventId=null;}
  });
  let expandedImage=$state<{hash:string;label:string}|null>(null);
  $effect(()=>{if(!open) expandedImage=null;});
  let preflight=$state<{stage:string;message:string}[]>([]),loading=false,loadedRun='';
  const eligible=$derived(scope==='page' ? !!logPage : pages.length>0);
  const canStart=$derived(canEdit && !busy && !working && !locked && eligible && !!selectedModel && tasks.length>0);
  const auditEvents=$derived(events.filter(event=> event.run_id===selectedRun && event.image_id===logPage?.id &&
    ['run','page','request','critique:reused','proofreader:question','proofreader:images','critique','director:request',
      'transcription:attempt','transcription:fallback','text:correlate','translation:review','stage','stage:error','stage:reused','stage:skipped','clean:fallback','clean:retry','clean:request','clean:result','clean:residue','clean:waiting','repair:stalled','lettering:changed','region:created','region:rendering','region:excluded','region:removed','region:extended','region:relocated','region:read','type:changed','type:created','findings','retry','automation:error','automation:request','automation:response','automation:fallback','memory:warning','director:response','edit','typeset:result','page:empty','undo','model:error','director:correction'].includes(event.kind)
    && (event.kind!=='run' || event.detail?.state!=='running' || event.detail?.message==='Starting Director')));

  const selectedEvent=$derived(auditEvents.find(event=>event.id===selectedEventId)??auditEvents.at(-1));
  const pageChanges=$derived(changes.filter(change=>change.image_id===logPage?.id));

  function quote(value:unknown):string {
    const text=String(value??'').replaceAll('\n','\\n');
    return JSON.stringify(text.length>90?`${text.slice(0,87)}…`:text);
  }
  function regionNumber(id:string):string {
    for (const event of events) {
      if (event.kind!=='director:request') continue;
      try {
        const region=JSON.parse(event.detail?.prompt||'{}').regions?.find((item:any)=>item.id===id);
        if (region) return String(region.number);
      } catch { /* Older audit entries may have a different prompt. */ }
    }
    return id;
  }
  function eventSummary(event:Event):string {
    const detail=event.detail||{};
    if(event.kind==='transcription:attempt') return `Trying normal transcription for region ${detail.lineId}`;
    if(event.kind==='transcription:fallback') return `Region ${detail.lineId} transcription failed; using saved proofreader text: ${detail.message}`;
    if(event.kind==='text:correlate') return `Correlating ${detail.lineIds?.length??0} unresolved regions with the saved page transcript`;
    if(event.kind==='translation:review') return `Translation concern passed to proofreading: ${detail.reason}`;
    if(event.kind==='stage') return `${detail.stage} · attempt ${detail.attempt}`;
    if(event.kind==='stage:reused') return `Reused verified ${detail.stage} result`;
    if(event.kind==='stage:error') return `${detail.stage}: ${detail.error}`;
    if(event.kind==='clean:request') return `Cleaning ${detail.regionIds?.length??0} regions with ${detail.method}`;
    if(event.kind==='clean:result') return detail.regionIds?.length ? `Saved cleaned region (${detail.method}); ${detail.remainingRegionIds?.length??0} regions remaining` : `Cleaned artwork verified (${detail.method})`;
    if(event.kind==='clean:residue') return `Cleaning rejected: leftover strokes or smudges in ${detail.findings?.length??0} regions`;
    if(event.kind==='clean:waiting') return detail.reason;
    if(event.kind==='clean:fallback') return `Cleaning fallback ${detail.method}: ${detail.reason}`;
    if(event.kind==='clean:retry') return detail.expansion == null ? `${detail.method||'Cleaning'}: ${detail.reason}` : `Cleaning repair (${detail.problem}), mask expansion ${detail.expansion}px: ${detail.reason}`;
    if(event.kind==='stage:skipped') return `${detail.stage}: ${detail.reason}`;
    if(event.kind==='repair:stalled') return detail.message;
    if(event.kind==='lettering:changed') return `Lettering style corrected: ${detail.reason}`;
    if(event.kind==='region:created') return `Created missing text region ${detail.lineId}`;
    if(event.kind==='region:rendering') return detail.renderEnabled === true ? `Rendering restored for ${detail.lineId}` : `Rendering off for duplicate ${detail.lineId}; retained for human review`;
    if(event.kind==='region:excluded') return `Excluded ${detail.verdict} region ${detail.lineId}: ${detail.evidence}`;
    if(event.kind==='region:removed') return `Removed region ${detail.lineId} ("${detail.source}"): ${detail.reason}`;
    if(event.kind==='region:extended') return `Refit region ${detail.lineId} to its lettering`;
    if(event.kind==='region:relocated') return `Moved region ${detail.lineId}: ${detail.reason}`;
    if(event.kind==='region:read') return `Read source in region ${detail.lineId}: ${detail.evidence}`;
    if(event.kind==='type:changed') return `Region ${detail.lineId}: ${detail.before} → ${detail.after}`;
    if(event.kind==='type:created') return `Created provisional type ${detail.kind?.label}`;
    if(event.kind==='findings') return `${detail.findings?.length||0} issues to resolve`;
    if(event.kind==='retry') return `Retrying ${detail.purpose} (${detail.attempt})`;
    if(event.kind==='automation:fallback') return `${detail.purpose}: fallback from ${detail.from?.engine} to ${detail.to?.engine}: ${detail.reason}`;
    if(event.kind==='automation:request') return `${detail.purpose}: requested ${detail.model?.engine||'Director'}${detail.candidate>0?' (fallback)':''}`;
    if(event.kind.startsWith('automation:')) return `${detail.purpose}: ${event.kind.split(':')[1]}`;
    if(event.kind==='memory:warning') return detail.message;
    const pageNumber=pages.find(page=>page.id===event.image_id)?.pageNumber??'?';
    if (event.kind==='run') return detail.state==='completed'?'Director finished':
      detail.state==='running'?'Started Director':`Director ${detail.state}: ${detail.message||''}`;
    if (event.kind==='page') return detail.state==='working'?`Started page ${pageNumber}`:
      `Made final determination ${quote(String(detail.state||'').replace(/^./, (letter:string)=>letter.toUpperCase()))} for page ${pageNumber}${detail.state==='unresolved'?`: ${detail.detail||''}`:''}`;
    if (event.kind==='request') return detail.task==='describe'?'Asked model to describe the page':
      detail.task==='transcribe'?'Asked model to transcribe the page':`Requested ${detail.task}`;
    if (event.kind==='critique:reused') return 'Reused saved proofreader critique';
    if (event.kind==='proofreader:question') return `Asked Proofreader about region ${detail.lineId}`;
    if (event.kind==='proofreader:images') return detail.mode==='raw'?'Asked Proofreader to read Raw Image':detail.mode==='raw-follow-up'?'Sent region question to Proofreader':'Asked Proofreader to check my work';
    if (event.kind==='critique') return 'Received Proofreader critique';
    if (event.kind==='director:request') {
      if (detail.round>0) {
        try {
          const missing=JSON.parse(detail.prompt).requiredMissing?.length||0;
          return `Asked Director to fill ${missing} remaining ${missing===1?'region':'regions'}`;
        } catch { /* Keep the generic summary for older events. */ }
      }
      return 'Sent Director current page state';
    }
    if (event.kind==='director:response') return detail.edits?.length
      ? `Director proposed ${detail.edits.length} text ${detail.edits.length===1?'change':'changes'}`
      : detail.textComplete===false?'Director found source or English incomplete':
        'Director found source and English complete';
    if (event.kind==='edit') {
      const region=detail.regionIndex??regionNumber(detail.lineId);
      const changes:string[]=[];
      if (detail.before?.source!==detail.after?.source) changes.push(`source to ${quote(detail.after?.source)}`);
      if (detail.before?.english!==detail.after?.english) changes.push(`English to ${quote(detail.after?.english)}`);
      return `Changed Region ${region} ${changes.join(' and ')}`;
    }
    if (event.kind==='typeset:result') {
      const ids=detail.regionIds||[];
      return detail.errors?.length?`Could not refit page ${pageNumber}`:
        detail.completed===0&&detail.skipped?`Kept ${detail.skipped} locked ${detail.skipped===1?'layout':'layouts'} on page ${pageNumber}`:
        ids.length===1?`Refit Region ${regionNumber(ids[0])}`:
        detail.completed?`Refit ${detail.completed} regions on page ${pageNumber}`:`Checked text fit on page ${pageNumber}`;
    }
    if (event.kind==='page:empty') return `Page ${pageNumber} has no text to proofread`;
    if (event.kind==='undo') return `Undid ${detail.label||'Director change'}`;
    if (event.kind==='model:error') return `Model request failed: ${detail.error||'unknown error'}`;
    if (event.kind==='director:correction') return `Director needs correction: ${detail.feedback||''}`;
    return event.kind;
  }

  function expandLogJson(value:unknown, depth=0):unknown {
    if (depth>12) return value;
    if (typeof value==='string') {
      const trimmed=value.trim();
      if ((trimmed.startsWith('{')&&trimmed.endsWith('}')) ||
          (trimmed.startsWith('[')&&trimmed.endsWith(']'))) {
        try { return expandLogJson(JSON.parse(trimmed),depth+1); } catch { /* Keep non-JSON text verbatim. */ }
      }
    }
    if (Array.isArray(value)) return value.map(item=>expandLogJson(item,depth+1));
    if (value && typeof value==='object') return Object.fromEntries(
      Object.entries(value).map(([key,item])=>[key,expandLogJson(item,depth+1)]));
    return value;
  }
  function logFields(detail:unknown):{label:string;value:unknown}[] {
    if (detail && typeof detail==='object' && !Array.isArray(detail))
      return Object.entries(detail).map(([label,value])=>({label,value}));
    return [{label:'Detail',value:detail}];
  }
  function logView(value:unknown):{text:string;json:boolean} {
    const expanded=expandLogJson(value);
    return expanded && typeof expanded==='object'
      ? {text:JSON.stringify(expanded,null,2),json:true}
      : {text:expanded==null?'':String(expanded),json:false};
  }

  async function refresh() {
    if(loading) return;
    loading=true;
    const requestedRun=selectedRun;
    try {
      const after=loadedRun===selectedRun?events.at(-1)?.id||0:0;
      const url=`${apiBase}/director?after=${after}${selectedRun?`&runId=${encodeURIComponent(selectedRun)}`:''}`;
      const response=await fetch(url,{cache:'no-store'});
      const data=await response.json();
      if (!response.ok) throw new Error(data.error||'Could not load Director');
      pages=data.pages; runs=data.runs; models=data.models; locked=data.locked; changes=data.changes;
      if (!selectedRun && runs.length) selectedRun=runs[0].id;
      if (!models.some(m=>m.id===selectedModel)) selectedModel=models[0]?.id||'';
      if(requestedRun!==selectedRun && requestedRun) return;
      const all:Event[]=after?[...events,...data.events]:[...data.events];
      loadedRun=selectedRun;
      let last=all.at(-1)?.id||0;
      while (data.events.length===500 && all.length && all.length%500===0) {
        const more=await fetch(`${apiBase}/director?runId=${encodeURIComponent(selectedRun)}&after=${last}`,{cache:'no-store'});
        if (!more.ok) break;
        const batch=(await more.json()).events as Event[];
        all.push(...batch); if (batch.length<500) break;
        last=all.at(-1)?.id||last;
      }
      events=all;
      error='';
    } catch(e) { error=e instanceof Error?e.message:String(e); } finally {loading=false;}
  }
  async function act(body:Record<string,unknown>) {
    working=true; error='';
    try {
      const response=await fetch(`${apiBase}/director`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const result=await response.json();
      if (!response.ok) throw new Error(result.error||'Director action failed');
      if (result.runId) selectedRun=result.runId;
      await refresh();
    } catch(e) { error=e instanceof Error?e.message:String(e); }
    finally { working=false; }
  }
  async function start(retryBlocked=false) {
    const model=models.find(item=>item.id===selectedModel);
    if (!model) return;
    void act({action:retryBlocked?'retry-blocked':'start',scope,imageId:scope==='page'?logPage?.id:undefined,
      model:{engine:model.id,model:model.model||''},recheckAll,tasks});
  }
  async function checkSetup() {
    const model=models.find(item=>item.id===selectedModel);
    working=true;
    try {
      const response=await fetch(`${apiBase}/director`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'preflight',model:model?{engine:model.id,model:model.model}:undefined})});
      const result=await response.json();if(!response.ok) throw new Error(result.error);
      preflight=result.issues;
      if(!preflight.length) preflight=[{stage:'ready',message:'Prerequisites available. Pages will be checked individually.'}];
    } catch(e) {error=e instanceof Error?e.message:String(e);} finally {working=false;}
  }
  function inspect(item:Page,finding?:DirectorFinding) {open=false;onnavigate?.(item.id,finding?.lineId,finding?.stage||item.stage||'check');}
  onMount(()=>{ 
    let shownPageId=pageId;
    void refresh();
    const timer=setInterval(()=>{
      const pageChanged=pageId!==shownPageId;
      shownPageId=pageId;
      if(open||locked||pageChanged) void refresh();
    },1500);
    return ()=>clearInterval(timer);
  });
</script>

{#snippet logImage(hash:string,label:string)}
  <button type="button" class="director-image-button" aria-haspopup="dialog" aria-label={`Expand ${label}`} title="Click to expand saved image" onclick={()=>expandedImage={hash,label}}><img src={`${apiBase}/workflow/assets/${hash}`} alt={label}></button>
{/snippet}

<button type="button" class="ed-btn" data-find="director" onclick={()=>{selectedPageId=pageId;open=true;void refresh();}}>
  <i class="bi bi-stars" aria-hidden="true"></i> Director
  {#if page?.state==='passed' && scope==='page'}<span class="director-check" title="Automated checks passed; human approval remains" aria-label="Automated checks passed; human approval remains"><i class="bi bi-check-circle-fill" aria-hidden="true"></i></span>{/if}
</button>
{#if open}
  <div class="director-backdrop" role="presentation" onclick={()=>open=false}></div>
  <div class="director-panel" role="dialog" aria-modal="true" aria-label="Director mode">
    <header><div><h2>Director</h2><p>Unattended work · human completion stays under your control</p></div>
      <button type="button" aria-label="Close Director" onclick={()=>open=false}>✕</button></header>
    {#if error}<p class="director-error" role="alert">{error}</p>{/if}
    <div class="director-controls">
      <section class="director-tasks" aria-label="Director tasks">
        <div class="director-tasks-head"><h3>Tasks</h3>
          <div class="director-presets" role="group" aria-label="Task presets">
            {#each presets as preset}<button type="button" class:active={samePreset(preset.tasks)} aria-pressed={samePreset(preset.tasks)} disabled={working||locked} onclick={()=>tasks=[...preset.tasks]}>{preset.label}</button>{/each}
          </div></div>
        <ol>
          {#each DIRECTOR_TASKS as task, index}
            <li><label class="director-task" class:on={tasks.includes(task.id)}>
              <input type="checkbox" checked={tasks.includes(task.id)} disabled={working||locked} onchange={(e)=>toggleTask(task.id,e.currentTarget.checked)}>
              <span class="step">{index+1}</span>
              <span><strong>{task.label}</strong><small>{task.description}</small></span>
            </label></li>
          {/each}
        </ol>
        {#if !tasks.length}<p class="director-hint warn">Choose at least one task.</p>
        {:else if tasks.length<ALL_DIRECTOR_TASKS.length}<p class="director-hint">Unselected tasks are skipped. Later tasks use whatever earlier work is already on the page, and pages are only marked “Checks passed” when every task runs.</p>{/if}
      </section>
      <section class="director-launch">
        <label>Chat and vision model
          <select bind:value={selectedModel} disabled={working||locked}>
            {#each models as model}<option value={model.id}>{model.name}</option>{/each}
          </select>
        </label>
        <p class="director-scope">{scope==='page' ? `Page ${logPage?.pageNumber??'—'} · ${directorStatusLabel(logPage?.state??'pending')}` :
          `Whole chapter · ${pages.filter(p=>p.state==='passed').length} of ${pages.length} passed`}</p>
        {#if !eligible}<p class="director-error">Choose a story page first.</p>{/if}
        {#if scope==='chapter'}<label class="inline"><input type="checkbox" bind:checked={recheckAll}> Recheck all pages, including passed</label>{/if}
        <div class="director-buttons">
          <button type="button" class="primary" disabled={!canStart} onclick={()=>start()}><i class="bi bi-play-fill" aria-hidden="true"></i> Run {tasks.length===ALL_DIRECTOR_TASKS.length?'':`${tasks.length} task${tasks.length===1?'':'s'} on `}{scope==='page'?'page':'chapter'}</button>
          {#if scope==='chapter'}<button type="button" disabled={!canStart||!pages.some(p=>p.state==='unresolved')} onclick={()=>start(true)}>Retry blocked</button>
          {:else if logPage}<button type="button" title="Forget saved stage results so the next run redoes every task on this page. Edits stay undoable." disabled={!canEdit||working||locked}
            onclick={()=>{if(confirm(`Reset Director for page ${logPage.pageNumber??'?'}? The next run redoes every task instead of reusing saved results.`)) void act({action:'reset-page',imageId:logPage.id});}}>Reset page</button>{/if}
          {#if run?.state==='running'}<button type="button" disabled={working} onclick={()=>void act({action:'pause',runId:run.id})}>Pause</button>
            <button type="button" class="danger" disabled={working} onclick={()=>void act({action:'stop',runId:run.id})}>Stop</button>{/if}
          {#if run && ['paused','interrupted','failed'].includes(run.state)}<button type="button" disabled={working||locked||!eligible} onclick={()=>void act({action:'resume',runId:run.id})}>Resume</button>{/if}
        </div>
        <div class="director-buttons secondary">
          <button type="button" disabled={working||locked} onclick={checkSetup}>Check setup</button>
          <button type="button" onclick={()=>{open=false;onsettings?.();}}>Director settings</button>
        </div>
      </section>
    </div>
    {#if preflight.length}<div class="director-preflight">{#each preflight as issue}<p>{issue.stage}: {issue.message}</p>{/each}</div>{/if}
    <div class="director-body">
      <aside><h3>Pages</h3>{#each pages as item}<div class="director-page" class:current={item.id===logPage?.id}>
        <button type="button" class="page-link" aria-pressed={item.id===logPage?.id} onclick={()=>selectedPageId=item.id}>Page {item.pageNumber??'?'}</button><strong class:passed={item.state==='passed'}>{directorStatusLabel(item.state)}</strong>
        {#if item.stage}<small>{item.stage}</small>{/if}
        {#if item.detail}<small title={item.detail}>{item.detail}</small>{/if}
      </div>{/each}</aside>
      <main><div class="director-overview">
      <section class="director-blockers" aria-label="Page blockers"><h3>Page status, blockers and warnings</h3><p>Checks passed does not mark a page Done. Warnings do not block; dismiss them in Review.</p>
        {#each pages.filter(p=>p.id===logPage?.id&&p.findings?.length) as item}<div><h4>Page {item.pageNumber??'?'}</h4>{#each item.findings as finding}<button type="button" class:warning={finding.severity==='warning'} onclick={()=>inspect(item,finding)}>{finding.severity==='warning'?'Warning · ':''}{finding.stage}{finding.lineId?` · Region ${finding.lineId}`:''}: {finding.message}</button>{/each}</div>{/each}
      </section><div class="director-run"><label>Run <select bind:value={selectedRun} onchange={()=>void refresh()}>
        {#each runs as item}<option value={item.id}>{new Date(item.created_at).toLocaleString()} · {item.scope} · {item.state}</option>{/each}
      </select></label>{#if run}<p>{run.message}</p>
        <div class="director-run-tasks" aria-label="Tasks in this run">{#each DIRECTOR_TASKS as task}<span class:on={runTasks(run).includes(task.id)}>{task.label}</span>{/each}</div>{/if}</div>
      {#if run}
        <details><summary>Undo Director edits</summary>
        <div class="director-buttons"><button type="button" disabled={working||locked||!changes.some(c=>!c.undone)} onclick={()=>void act({action:'undo',runId:run.id})}>Undo run</button>
          {#if logPage}<button type="button" disabled={working||locked||!changes.some(c=>!c.undone&&c.image_id===logPage.id)} onclick={()=>void act({action:'undo',runId:run.id,imageId:logPage.id})}>Undo selected page</button>{/if}</div>
        <details><summary>Individual changes ({pageChanges.length})</summary>
          {#each pageChanges as change}<div class="director-change"><span>#{change.id} {change.label}{change.undone?' · undone':''}</span>
            <button type="button" disabled={working||locked||!!change.undone} onclick={()=>void act({action:'undo',runId:run.id,changeId:change.id})}>Undo</button></div>{/each}
        </details>
        </details>
      {/if}
      {#if logPage}<button type="button" class="page-link" onclick={()=>inspect(logPage)}>Open page {logPage.pageNumber??'?'} in editor ↗</button>{/if}
      </div>
      <div class="director-log">
        <section class="director-log-list" aria-label="Director log items">
          <h3>Page {logPage?.pageNumber??'—'} · Director log ({auditEvents.length})</h3>
          <div class="director-events">
            {#each auditEvents as event (event.id)}
              <button type="button" class="director-event" class:selected={event.id===selectedEvent?.id} aria-pressed={event.id===selectedEvent?.id} onclick={()=>selectedEventId=event.id}>
                <small>{new Date(event.created_at).toLocaleTimeString()} · {event.kind}</small>
                <span>{eventSummary(event)}</span>
              </button>
            {:else}<p>No log items for this page in the selected run.</p>{/each}
          </div>
        </section>
        {#key selectedEvent?.id}
        <section class="director-log-content" aria-label="Director log content">
          {#if selectedEvent}
            {@const event=selectedEvent}
            <h3>{eventSummary(event)}</h3>
              {#if event.detail?.images && Array.isArray(event.detail.images)}<div class="director-images">{#each event.detail.images as hash}{@render logImage(hash,"Sent to model or proofreader")}{/each}</div>{/if}
              {#if event.detail?.sent && Array.isArray(event.detail.sent)}<div class="director-images">{#each event.detail.sent as hash}{@render logImage(hash,"Exact proofreader input")}{/each}</div>{/if}
              {#if event.detail?.input?.images && Array.isArray(event.detail.input.images)}<div class="director-images">{#each event.detail.input.images as item}{#if item.imageAsset}{@render logImage(item.imageAsset,"Exact model input")}{/if}{/each}</div>{/if}
              {#if event.detail?.raw && !Array.isArray(event.detail?.sent)}<div class="director-images">{@render logImage(event.detail.raw,"Saved raw page")}
                {#if event.detail?.typeset}{@render logImage(event.detail.typeset,"Saved typeset page")}{/if}</div>{/if}
              {#if event.detail?.crop}<div class="director-images">{@render logImage(event.detail.crop,"Crop sent for transcription")}</div>{/if}
              {#if event.kind==='clean:residue' && event.detail?.candidate}<div class="director-images">{@render logImage(event.detail.candidate,"Rejected clean: leftover strokes")}</div>{/if}
              <div class="director-log-fields">
                {#each logFields(event.detail) as field}
                  {@const view=logView(field.value)}
                  <section class="director-log-field">
                    <h4>{field.label}</h4>
                    {#if view.json}<pre class="director-log-json">{view.text}</pre>
                    {:else}<div class="director-log-text">{view.text}</div>{/if}
                  </section>
                {/each}
              </div>
          {:else}<p>Select a log item to view its content.</p>{/if}
        </section>
        {/key}
      </div>
      </main>
    </div>
  </div>
{/if}

{#if open && expandedImage}<DirectorImageViewer src={`${apiBase}/workflow/assets/${expandedImage.hash}`} label={expandedImage.label} onclose={()=>expandedImage=null}/>{/if}

<style>
  .director-controls{align-items:stretch;gap:20px}.director-tasks{flex:2 1 420px;min-width:0}.director-launch{flex:1 1 260px;display:flex;flex-direction:column;gap:10px}
  .director-tasks-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:6px}.director-tasks h3{margin:0}
  .director-presets{display:flex;gap:4px;flex-wrap:wrap}.director-presets button{background:transparent;color:inherit;border:1px solid #6668;border-radius:999px;padding:2px 10px;font-size:.75rem;cursor:pointer}.director-presets button.active{border-color:var(--hud-teal-ink,#7bd1ad);color:var(--hud-teal-ink,#7bd1ad)}
  .director-tasks ol{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px}
  .director-task{display:grid!important;grid-template-columns:auto auto 1fr;align-items:start;gap:8px!important;padding:7px 9px;border:1px solid #6665;border-radius:7px;cursor:pointer;opacity:.6;transition:opacity .12s,border-color .12s}.director-task.on{opacity:1;border-color:var(--hud-teal-ink,#7bd1ad);background:#6688a622}
  .director-task input{margin:2px 0 0}.director-task .step{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:#6666;font-size:.68rem;font-weight:600}.director-task.on .step{background:var(--hud-teal-ink,#7bd1ad);color:#102}
  .director-task strong{display:block;font-size:.82rem}.director-task small{display:block;color:var(--hud-muted,#aaa);font-size:.72rem;line-height:1.3}
  .director-hint{font-size:.75rem;color:var(--hud-muted,#aaa);margin-top:6px!important}.director-hint.warn{color:#ffb7a7}.director-scope{font-size:.8rem;color:var(--hud-muted,#aaa)}
  .director-buttons button.primary{background:#2f7a5f;border-color:#7bd1ad;font-weight:600}.director-buttons button.danger{background:#6b3a34;border-color:#c98478}.director-buttons.secondary button{background:transparent;color:inherit}
  .director-run-tasks{display:flex;gap:4px;flex-wrap:wrap}.director-run-tasks span{font-size:.68rem;padding:1px 7px;border-radius:999px;border:1px solid #6665;opacity:.4;text-decoration:line-through}.director-run-tasks span.on{opacity:1;text-decoration:none;border-color:var(--hud-teal-ink,#7bd1ad)}
  .director-preflight{padding:8px 20px;font-size:.8rem;border-bottom:1px solid #6665;max-height:140px;overflow:auto}.page-link{background:none;border:0;color:inherit;text-align:left;cursor:pointer;padding:0}.director-blockers{margin-bottom:16px}.director-blockers p{font-size:.8rem;color:var(--hud-muted,#aaa)}.director-blockers h4{margin:10px 0 5px}.director-blockers button{display:block;text-align:left;border:1px solid #886655;background:#43372c;color:#ffe2c9;padding:8px;border-radius:5px;width:100%;margin:4px 0;}.director-blockers button.warning{border-color:#c9a24a88;background:#3d3722;color:#f3e2b0}
  .director-check{color:#7bd1ad;font-size:1em;line-height:1}.director-backdrop{position:fixed;inset:0;background:#0009;z-index:1000}
  .director-panel{position:fixed;inset:5vh 5vw;background:var(--hud-bg,#1b2029);color:var(--hud-text,#eee);z-index:1001;border:1px solid var(--hud-line,#555);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 80px #000a}
  header{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid #6665}h2,h3,p{margin:0}h2{font-size:1.2rem}header p{color:var(--hud-muted,#aaa);font-size:.8rem}header button{background:none;border:0;color:inherit;cursor:pointer;font-size:1.3rem}
  .director-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid #6665}.director-controls label{display:grid;gap:3px;font-size:.8rem}.director-controls .inline{display:flex;align-items:center}.director-buttons{display:flex;gap:8px;flex-wrap:wrap}.director-buttons button,.director-change button{background:#334b5e;color:white;border:1px solid #8093a2;border-radius:5px;padding:5px 10px;cursor:pointer}button:disabled{opacity:.45;cursor:default}
  .director-error{color:#ffb7a7;padding:4px 20px}.director-body{display:grid;grid-template-columns:minmax(150px,220px) 1fr;min-height:0;flex:1}.director-body aside{overflow:auto;padding:12px;border-right:1px solid #6665}.director-body main{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}.director-overview{padding:12px 18px;max-height:35%;overflow:auto;flex-shrink:0;border-bottom:1px solid #6665}h3{font-size:.9rem;margin:12px 0 8px}.director-page{display:grid;grid-template-columns:1fr auto;gap:4px;padding:5px;border-bottom:1px solid #6663}.director-page.current{background:#6688a633}.director-page strong{font-size:.75rem}.director-page strong.passed{color:#7bd1ad}.director-page small{grid-column:1/3;color:var(--hud-muted,#aaa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .director-run{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.director-run select{max-width:350px}.director-change{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px;border-bottom:1px solid #6663}.director-events{display:grid;gap:6px}.director-event{display:grid;gap:6px;width:100%;text-align:left;cursor:pointer;color:inherit;background:transparent;border:1px solid #6665;border-radius:5px;padding:6px}.director-event small{color:var(--hud-muted,#aaa);font-size:.7rem}.director-event span{overflow-wrap:anywhere}.director-event.selected{border-color:var(--hud-teal-ink,#7bd1ad);background:#6688a633}.director-log-fields{display:grid;gap:8px;margin-top:10px}.director-log-field{min-width:0;border:1px solid #6664;border-radius:5px;background:#0002;overflow:hidden}.director-log-field h4{margin:0;padding:5px 9px;border-bottom:1px solid #6664;color:var(--hud-muted,#bbb);font-size:.72rem;font-weight:600;letter-spacing:.03em}.director-log-text,.director-log-json{margin:0;padding:8px 10px;overflow-wrap:anywhere;white-space:pre-wrap;font-size:.82rem;line-height:1.5}.director-log-json{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.76rem}.director-images{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.director-image-button{padding:0;border:1px solid #777;background:transparent;cursor:zoom-in;max-width:100%;border-radius:3px}.director-image-button:focus-visible{outline:2px solid var(--hud-teal-ink,#7bd1ad);outline-offset:3px}.director-images img{max-width:min(260px,100%);max-height:340px;object-fit:contain;background:white}select{background:var(--hud-bg,#222);color:inherit;border:1px solid #777;border-radius:4px;padding:5px}
  .director-log{display:grid;grid-template-columns:minmax(220px,32%) minmax(0,1fr);min-height:0;flex:1}.director-log-list,.director-log-content{overflow:auto;min-width:0;padding:12px 16px;overscroll-behavior:contain}.director-log-list{border-right:1px solid #6665}.director-log-list h3,.director-log-content h3{margin-top:0}.director-log-content>p,.director-events>p{color:var(--hud-muted,#aaa);font-size:.85rem}
  @media(max-width:1000px){.director-body{grid-template-columns:145px minmax(0,1fr)}.director-log{grid-template-columns:minmax(180px,40%) minmax(0,1fr)}}
  @media(max-width:700px){.director-controls{max-height:45vh!important}.director-panel{inset:0;border-radius:0}.director-body{grid-template-columns:1fr;grid-template-rows:100px minmax(0,1fr)}.director-log{grid-template-columns:minmax(130px,40%) minmax(0,1fr)}.director-log-list,.director-log-content{padding:8px}.director-controls{max-height:25vh;overflow:auto;flex-shrink:0}.director-overview{max-height:25%}.director-body aside{max-height:120px;border-right:0;border-bottom:1px solid #6665}}
</style>

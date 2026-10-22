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
      'transcription:attempt','transcription:fallback','text:correlate','translation:review','stage','stage:error','stage:reused','stage:skipped','clean:fallback','clean:retry','clean:request','clean:result','clean:residue','clean:waiting','repair:stalled','finding:unconfirmed','lettering:changed','region:created','region:rendering','region:excluded','region:removed','region:extended','region:relocated','region:read','type:changed','type:created','findings','retry','automation:error','automation:request','automation:response','automation:fallback','clean:over-artwork','clean:outside-regions','region:rejected','director:stalled','ocr:error','memory:warning','director:response','edit','typeset:result','page:empty','undo','model:error','director:correction','region:detect','region:detected','region:lettering-check','region:non-text','region:move-refused'].includes(event.kind)
    && (event.kind!=='run' || event.detail?.state!=='running' || event.detail?.message==='Starting Director')));

  const selectedEvent=$derived(auditEvents.find(event=>event.id===selectedEventId)??auditEvents.at(-1));
  const pageChanges=$derived(changes.filter(change=>change.image_id===logPage?.id));

  function quote(value:unknown):string {
    const text=String(value??'').replaceAll('\n','\\n');
    return JSON.stringify(text.length>90?`${text.slice(0,87)}…`:text);
  }
  // Region numbers come from the prompts Director was sent; raw ids are shortened.
  const regionNumbers=$derived.by(()=>{
    const numbers=new Map<string,string>();
    for (const event of events) {
      if (event.kind!=='director:request') continue;
      try {
        for (const region of JSON.parse(event.detail?.prompt||'{}').regions??[]) numbers.set(region.id,String(region.number));
      } catch { /* Older audit entries may have a different prompt. */ }
    }
    return numbers;
  });
  function regionNumber(id:string):string { return regionNumbers.get(id)??String(id??'?').slice(0,6); }
  const region=(id:string)=>`region ${regionNumber(id)}`;
  function regions(ids:string[]|undefined):string {
    const list=(ids??[]).map(regionNumber);
    return !list.length?'no regions':list.length===1?`region ${list[0]}`:`regions ${list.join(', ')}`;
  }
  const STAGE_NAMES:Record<string,string>={prepare:'Prepare',transcribe:'Transcription',proofread:'Proofreading','proofread-raw':'Proofread raw',
    clean:'Cleaning','clean-bubbles':'Bubble cleaning','clean-hard':'Hard bubble cleaning','clean-sfx':'SFX cleaning',typeset:'Typesetting',proof:'Final proof',check:'Checks'};
  const stageName=(stage:unknown)=>STAGE_NAMES[String(stage)]??String(stage??'Stage').replace(/[-_]/g,' ').replace(/^./,c=>c.toUpperCase());
  const PURPOSES:Record<string,string>={'inspect-cleaning':'Cleaning check','inspect-existing':'Page cleaning check'};
  const purpose=(value:unknown)=>PURPOSES[String(value)]??String(value??'Model').replace(/[-_]/g,' ').replace(/^./,c=>c.toUpperCase());
  // Replace region ids inside free text with their numbers.
  const tidy=(text:unknown)=>String(text??'').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,id=>region(id));

  type Tone='good'|'bad'|'warn'|'info'|'muted';
  function eventTone(event:Event):Tone {
    const d=event.detail||{}, k=event.kind;
    if (['stage:error','model:error','automation:error','clean:residue','repair:stalled','director:stalled','director:correction','ocr:error','clean:over-artwork','clean:outside-regions','region:rejected'].includes(k)) return 'bad';
    if (k==='run') return d.state==='completed'?(/need attention/.test(d.message||'')?'warn':'good'):d.state==='running'?'info':'bad';
    if (k==='stage:skipped' && /not selected/i.test(d.reason||'')) return 'muted';
    if (k==='page') return d.state==='passed'||d.state==='partial'?'good':d.state==='working'?'info':d.state==='unresolved'?'bad':'warn';
    if (k==='automation:response') return d.output?.safe===false?'bad':d.output?.safe===true?'good':'muted';
    if (k==='typeset:result') return d.errors?.length?'bad':'good';
    if (k==='director:response') return d.textComplete===false?'warn':'good';
    if (['clean:result','stage:reused','critique:reused','region:created','region:extended','region:non-text'].includes(k)) return 'good';
    if (k==='region:detect'||k==='region:detected') return 'muted';
    if (k==='region:move-refused'||(k==='region:lettering-check'&&!d.hasLettering)) return 'warn';
    if (['clean:fallback','clean:retry','automation:fallback','memory:warning','finding:unconfirmed','retry','findings','transcription:fallback','translation:review','region:excluded','region:removed','stage:skipped'].includes(k)) return 'warn';
    if (['automation:request','director:request','proofreader:images','proofreader:question','request','transcription:attempt','clean:request'].includes(k)) return 'muted';
    return 'info';
  }
  const TONE_ICONS:Record<Tone,string>={good:'bi-check-circle-fill',bad:'bi-x-circle-fill',warn:'bi-exclamation-triangle-fill',info:'bi-arrow-right-circle',muted:'bi-dot'};

  function eventSummary(event:Event):string {
    const detail=event.detail||{};
    if(event.kind==='transcription:attempt') return `Transcribing ${region(detail.lineId)}`;
    if(event.kind==='transcription:fallback') return `Transcription of ${region(detail.lineId)} failed, so the saved proofreader text was used`;
    if(event.kind==='text:correlate') return `Matching ${detail.lineIds?.length??0} unread regions against the page transcript`;
    if(event.kind==='translation:review') return `Translation concern sent to proofreading: ${tidy(detail.reason)}`;
    if(event.kind==='stage') return `${stageName(detail.stage)} started${detail.attempt>1?` (attempt ${detail.attempt})`:''}`;
    if(event.kind==='stage:reused') return `${stageName(detail.stage)} already verified, reused`;
    if(event.kind==='stage:error') return `${stageName(detail.stage)} failed: ${tidy(detail.error)}`;
    if(event.kind==='stage:skipped') return `${stageName(detail.stage)} skipped: ${tidy(detail.reason)}`;
    if(event.kind==='clean:request') return `Cleaning ${regions(detail.regionIds)} with ${detail.method}`;
    if(event.kind==='clean:result') return detail.regionIds?.length ? `Cleaned ${regions(detail.regionIds)} (${detail.method})${detail.remainingRegionIds?.length?`, ${detail.remainingRegionIds.length} still to do`:''}` : `Cleaned artwork verified (${detail.method})`;
    if(event.kind==='clean:residue') return `Clean rejected: leftover lettering or smudges in ${detail.findings?.length??0} regions`;
    if(event.kind==='clean:waiting') return tidy(detail.reason);
    if(event.kind==='clean:fallback') return `Switching cleaner to ${detail.method}: ${tidy(detail.reason)}`;
    if(event.kind==='clean:retry') return detail.expansion == null ? `Cleaning ${regions(detail.regionIds)} again: ${tidy(detail.reason)}` : `Cleaning again with mask grown ${detail.expansion}px: ${tidy(detail.reason)}`;
    if(event.kind==='clean:over-artwork') return `Clean rejected: it painted over artwork`;
    if(event.kind==='clean:outside-regions') return `Clean rejected: it changed pixels outside the regions`;
    if(event.kind==='repair:stalled'||event.kind==='director:stalled') return `Stuck: ${tidy(detail.message||detail.reason)}`;
    if(event.kind==='lettering:changed') return `Lettering style corrected: ${tidy(detail.reason)}`;
    if(event.kind==='region:created') return `Added missing ${region(detail.lineId)}`;
    if(event.kind==='region:rendering') return detail.renderEnabled === true ? `Rendering turned back on for ${region(detail.lineId)}` : `Rendering turned off for duplicate ${region(detail.lineId)} (kept for review)`;
    if(event.kind==='region:excluded') return `Excluded ${region(detail.lineId)} as ${detail.verdict}: ${tidy(detail.evidence)}`;
    if(event.kind==='region:removed') return `Removed ${region(detail.lineId)} ("${detail.source}"): ${tidy(detail.reason)}`;
    if(event.kind==='region:rejected') return `Rejected ${region(detail.lineId)}: ${tidy(detail.reason)}`;
    if(event.kind==='region:extended') return `Refit ${region(detail.lineId)} to its lettering`;
    if(event.kind==='region:detect') return `Text detector: ${String(detail.reason??'checking for lettering').replace(/^./,(c:string)=>c.toLowerCase())}${detail.lineId?` in ${region(detail.lineId)}`:''}…`;
    if(event.kind==='region:detected') return detail.cached ? 'Text detector reused its result for this page' : `Text detector finished${detail.seconds!=null?` in ${detail.seconds}s`:''}${detail.backend?` on ${detail.backend}`:''}`;
    if(event.kind==='region:lettering-check') return detail.hasLettering ? `${region(detail.lineId)} does hold lettering; kept` : `${region(detail.lineId)} holds no lettering: ${tidy(detail.reason)}`;
    if(event.kind==='region:non-text') return `Excluded ${region(detail.lineId)} as artwork, not text`;
    if(event.kind==='region:move-refused') return `Kept ${region(detail.lineId)} in place: moving it would cover ${region(detail.onto)}`;
    if(event.kind==='region:relocated') return `Moved ${region(detail.lineId)}: ${tidy(detail.reason)}`;
    if(event.kind==='region:read') return `Read the source in ${region(detail.lineId)}: ${tidy(detail.evidence)}`;
    if(event.kind==='type:changed') return `${region(detail.lineId)} type changed: ${detail.before} → ${detail.after}`;
    if(event.kind==='type:created') return `Created provisional type ${detail.kind?.label}`;
    if(event.kind==='findings') return `${detail.findings?.length||0} issues to resolve`;
    if(event.kind==='retry') return `Retrying ${purpose(detail.purpose).toLowerCase()} (attempt ${detail.attempt})`;
    if(event.kind==='automation:fallback') return `${purpose(detail.purpose)}: ${detail.from?.engine} failed, trying ${detail.to?.engine}`;
    if(event.kind==='automation:request') return `${purpose(detail.purpose)}: asked ${detail.model?.engine||'Director'}${detail.candidate>0?' (fallback)':''}`;
    if(event.kind==='automation:response') {
      const out=detail.output||{};
      if (out.safe===true) return `${purpose(detail.purpose)} passed`;
      if (out.safe===false) return `${purpose(detail.purpose)} failed${out.problem&&out.problem!=='none'?` (${String(out.problem).replace(/-/g,' ')})`:''}: ${tidy(out.reason)}`;
      return `${purpose(detail.purpose)}: answer received`;
    }
    if(event.kind==='automation:error') return `${purpose(detail.purpose)}: model error ${tidy(detail.error||'')}`;
    if(event.kind==='memory:warning') return tidy(detail.message);
    if(event.kind==='finding:unconfirmed') return `Not confirmed, left for review: ${tidy(detail.message)} (${tidy(detail.reason)})`;
    if(event.kind==='ocr:error') return `OCR failed: ${tidy(detail.error)}`;
    const pageNumber=pages.find(page=>page.id===event.image_id)?.pageNumber??'?';
    if (event.kind==='run') return detail.state==='completed'?tidy(detail.message||'Director finished'):
      detail.state==='running'?'Director started':`Director ${detail.state}${detail.message?`: ${tidy(detail.message)}`:''}`;
    if (event.kind==='page') return detail.state==='working'?`Started page ${pageNumber}`:
      detail.state==='passed'?`Page ${pageNumber} passed all checks`:
      `Page ${pageNumber} ${directorStatusLabel(detail.state).toLowerCase()}${detail.state==='unresolved'&&detail.detail?`: ${tidy(detail.detail)}`:''}`;
    if (event.kind==='request') return detail.task==='describe'?'Asked the model to describe the page':
      detail.task==='transcribe'?'Asked the model to transcribe the page':`Requested ${detail.task}`;
    if (event.kind==='critique:reused') return 'Reused the saved proofreader critique';
    if (event.kind==='proofreader:question') return `Asked the proofreader about ${region(detail.lineId)}`;
    if (event.kind==='proofreader:images') return detail.mode==='raw'?'Asked the proofreader to read the raw page':detail.mode==='raw-follow-up'?'Sent a region question to the proofreader':'Asked the proofreader to check the work';
    if (event.kind==='critique') return 'Proofreader critique received';
    if (event.kind==='director:request') {
      if (detail.round>0) {
        try {
          const missing=JSON.parse(detail.prompt).requiredMissing?.length||0;
          return `Asked Director to fill ${missing} remaining ${missing===1?'region':'regions'}`;
        } catch { /* Keep the generic summary for older events. */ }
      }
      return 'Sent Director the current page';
    }
    if (event.kind==='director:response') return detail.edits?.length
      ? `Director proposed ${detail.edits.length} text ${detail.edits.length===1?'change':'changes'}`
      : detail.textComplete===false?'Director found the source or English incomplete':
        'Director found the source and English complete';
    if (event.kind==='edit') {
      const number=detail.regionIndex??regionNumber(detail.lineId);
      const changes:string[]=[];
      if (detail.before?.source!==detail.after?.source) changes.push(`source to ${quote(detail.after?.source)}`);
      if (detail.before?.english!==detail.after?.english) changes.push(`English to ${quote(detail.after?.english)}`);
      return `Changed region ${number} ${changes.join(' and ')}`;
    }
    if (event.kind==='typeset:result') {
      const ids=detail.regionIds||[];
      return detail.errors?.length?`Could not refit page ${pageNumber}`:
        detail.completed===0&&detail.skipped?`Kept ${detail.skipped} locked ${detail.skipped===1?'layout':'layouts'}`:
        ids.length===1?`Refit ${region(ids[0])}`:
        detail.completed?`Refit ${detail.completed} regions`:`Text fit checked`;
    }
    if (event.kind==='page:empty') return `Page ${pageNumber} has no text to proofread`;
    if (event.kind==='undo') return `Undid ${detail.label||'a Director change'}`;
    if (event.kind==='model:error') return `Model request failed: ${tidy(detail.error||'unknown error')}`;
    if (event.kind==='director:correction') return `Director's answer needed correcting: ${tidy(detail.feedback||'')}`;
    return event.kind;
  }
  // Consecutive events from one stage share a heading in the log.
  function stageOf(event:Event):string|null { return event.kind==='stage'?stageName(event.detail?.stage):null; }
  const logRows=$derived.by(()=>{
    const rows:{event:Event;tone:Tone;heading:string|null}[]=[];
    for (const event of auditEvents) rows.push({event,tone:eventTone(event),heading:stageOf(event)});
    return rows;
  });
  const toneCounts=$derived(logRows.reduce((acc,row)=>{acc[row.tone]=(acc[row.tone]??0)+1;return acc;},{} as Record<string,number>));
  let toneFilter=$state<'all'|'problems'>('all');

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
  const HIDDEN_FIELDS=new Set(['fingerprint']);
  function logFields(detail:unknown):{label:string;value:unknown}[] {
    if (detail && typeof detail==='object' && !Array.isArray(detail))
      return Object.entries(detail).filter(([label])=>!HIDDEN_FIELDS.has(label))
        .map(([label,value])=>({label:label.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase()),value}));
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
        <div class="director-tasks-head"><h3>Tasks <small>{tasks.length} of {ALL_DIRECTOR_TASKS.length}</small></h3>
          <div class="director-presets" role="group" aria-label="Task presets">
            {#each presets as preset}<button type="button" class:active={samePreset(preset.tasks)} aria-pressed={samePreset(preset.tasks)} disabled={working||locked} onclick={()=>tasks=[...preset.tasks]}>{preset.label}</button>{/each}
          </div></div>
        <ol>
          {#each DIRECTOR_TASKS as task, index}
            <li><label class="director-task" class:on={tasks.includes(task.id)} title={task.description}>
              <input type="checkbox" checked={tasks.includes(task.id)} disabled={working||locked} onchange={(e)=>toggleTask(task.id,e.currentTarget.checked)}>
              <span class="step">{index+1}</span>{task.label}
            </label></li>
          {/each}
        </ol>
        {#if !tasks.length}<p class="director-hint warn">Choose at least one task.</p>
        {:else if tasks.length<ALL_DIRECTOR_TASKS.length}<p class="director-hint">Unselected tasks are skipped; a page is only marked “Checks passed” when every task runs.</p>{/if}
      </section>
      <section class="director-launch">
        <label>Chat and vision model
          <select bind:value={selectedModel} disabled={working||locked}>
            {#each models as model}<option value={model.id}>{model.name}</option>{/each}
          </select>
        </label>
        <p class="director-scope">{scope==='page' ? `Page ${logPage?.pageNumber??'—'} · ${directorStatusLabel(logPage?.state??'pending')}` :
          `Whole chapter · ${pages.filter(p=>p.state==='passed'||p.state==='stale').length} of ${pages.length} passed`}</p>
        {#if !eligible}<p class="director-error">Choose a story page first.</p>{/if}
        {#if scope==='chapter'}<label class="inline"><input type="checkbox" bind:checked={recheckAll}> Recheck all pages, including passed and stale</label>{/if}
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
        {#if item.stage}<small>{stageName(item.stage)}</small>{/if}
        {#if item.detail}<small title={tidy(item.detail)}>{tidy(item.detail)}</small>{/if}
      </div>{/each}</aside>
      <main><div class="director-overview">
      <section class="director-blockers" aria-label="Page blockers"><h3>Page status, blockers and warnings</h3><p>Checks passed does not mark a page Done. Warnings do not block; dismiss them in Review.</p>
        {#each pages.filter(p=>p.id===logPage?.id&&p.findings?.length) as item}<div><h4>Page {item.pageNumber??'?'}</h4>{#each item.findings as finding}<button type="button" class:warning={finding.severity==='warning'} onclick={()=>inspect(item,finding)}>{finding.severity==='warning'?'Warning · ':''}{stageName(finding.stage)}{finding.lineId?` · ${region(finding.lineId)}`:''}: {tidy(finding.message)}</button>{/each}</div>{/each}
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
          <div class="director-log-head"><h3>Page {logPage?.pageNumber??'—'} log</h3>
            <span class="director-tally">{#if toneCounts.good}<span class="tone-good"><i class="bi bi-check-circle-fill" aria-hidden="true"></i> {toneCounts.good}</span>{/if}{#if toneCounts.warn}<span class="tone-warn"><i class="bi bi-exclamation-triangle-fill" aria-hidden="true"></i> {toneCounts.warn}</span>{/if}{#if toneCounts.bad}<span class="tone-bad"><i class="bi bi-x-circle-fill" aria-hidden="true"></i> {toneCounts.bad}</span>{/if}</span>
            <div class="director-presets" role="group" aria-label="Log filter">
              <button type="button" class:active={toneFilter==='all'} aria-pressed={toneFilter==='all'} onclick={()=>toneFilter='all'}>All</button>
              <button type="button" class:active={toneFilter==='problems'} aria-pressed={toneFilter==='problems'} onclick={()=>toneFilter='problems'}>Problems</button>
            </div></div>
          <div class="director-events">
            {#each logRows.filter(row=>toneFilter==='all'||row.tone==='bad'||row.tone==='warn') as row (row.event.id)}
              {#if row.heading && toneFilter==='all'}<h4 class="director-stage-heading">{row.heading}</h4>{/if}
              <button type="button" class="director-event tone-{row.tone}" class:selected={row.event.id===selectedEvent?.id} aria-pressed={row.event.id===selectedEvent?.id} onclick={()=>selectedEventId=row.event.id}>
                <i class="bi {TONE_ICONS[row.tone]}" aria-hidden="true"></i>
                <span>{eventSummary(row.event)}</span>
                <small>{new Date(row.event.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</small>
              </button>
            {:else}<p>{toneFilter==='problems'?'No problems logged for this page.':'No log items for this page in the selected run.'}</p>{/each}
          </div>
        </section>
        {#key selectedEvent?.id}
        <section class="director-log-content" aria-label="Director log content">
          {#if selectedEvent}
            {@const event=selectedEvent}
            <h3 class="director-detail-title tone-{eventTone(event)}"><i class="bi {TONE_ICONS[eventTone(event)]}" aria-hidden="true"></i> {eventSummary(event)}</h3>
            <p class="director-detail-meta">{new Date(event.created_at).toLocaleString()} · <code>{event.kind}</code></p>
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
                  {#if view.json}<details class="director-log-field"><summary>{field.label}</summary><pre class="director-log-json">{view.text}</pre></details>
                  {:else}<section class="director-log-field"><h4>{field.label}</h4><div class="director-log-text">{tidy(view.text)}</div></section>{/if}
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
  .director-panel{--d-good:#1f8a52;--d-bad:#c0364a;--d-bad-text:#8f1f30;--d-warn:#a8700a;--d-info:#2f6fae}
  :global(:root[data-theme='dark']) .director-panel{--d-good:#6fd39b;--d-bad:#f07e78;--d-bad-text:#ffd6d3;--d-warn:#e8bd5c;--d-info:#7fb3e6}
  .director-controls{align-items:flex-start;gap:20px}.director-tasks{flex:2 1 420px;min-width:0}.director-launch{flex:1 1 260px;display:flex;flex-direction:column;gap:8px}
  .director-tasks-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:6px}.director-tasks h3{margin:0}
  .director-presets{display:flex;gap:4px;flex-wrap:wrap}.director-presets button{background:transparent;color:inherit;border:1px solid #6668;border-radius:999px;padding:2px 10px;font-size:.75rem;cursor:pointer}.director-presets button.active{border-color:var(--hud-teal-ink,#7bd1ad);color:var(--hud-teal-ink,#7bd1ad)}
  .director-tasks ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:5px}.director-tasks h3 small{color:var(--hud-muted,#aaa);font-weight:400;margin-left:4px}
  .director-task{display:flex!important;align-items:center;gap:6px!important;padding:3px 10px 3px 4px;border:1px solid #6665;border-radius:999px;font-size:.78rem!important;white-space:nowrap;cursor:pointer;opacity:.6;transition:opacity .12s,border-color .12s}.director-task.on{opacity:1;border-color:var(--hud-teal-ink,#7bd1ad);background:#6688a622}
  .director-task input{position:absolute;opacity:0;pointer-events:none}.director-task:focus-within{outline:2px solid var(--hud-teal-ink,#7bd1ad);outline-offset:1px}.director-task .step{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:#6666;font-size:.68rem;font-weight:600}.director-task.on .step{background:var(--hud-teal-ink,#7bd1ad);color:#102}
  
  .director-hint{font-size:.75rem;color:var(--hud-muted,#aaa);margin-top:6px!important}.director-hint.warn{color:#ffb7a7}.director-scope{font-size:.8rem;color:var(--hud-muted,#aaa)}
  .director-buttons button.primary{background:#2f7a5f;border-color:#7bd1ad;font-weight:600}.director-buttons button.danger{background:#6b3a34;border-color:#c98478}.director-buttons.secondary button{background:transparent;color:inherit}
  .director-run-tasks{display:flex;gap:4px;flex-wrap:wrap}.director-run-tasks span{font-size:.68rem;padding:1px 7px;border-radius:999px;border:1px solid #6665;opacity:.4;text-decoration:line-through}.director-run-tasks span.on{opacity:1;text-decoration:none;border-color:var(--hud-teal-ink,#7bd1ad)}
  .director-preflight{padding:8px 20px;font-size:.8rem;border-bottom:1px solid #6665;max-height:140px;overflow:auto}.page-link{background:none;border:0;color:inherit;text-align:left;cursor:pointer;padding:0}.director-blockers{margin-bottom:16px}.director-blockers p{font-size:.8rem;color:var(--hud-muted,#aaa)}.director-blockers h4{margin:10px 0 5px}.director-blockers button{display:block;text-align:left;border:1px solid #886655;background:#43372c;color:#ffe2c9;padding:8px;border-radius:5px;width:100%;margin:4px 0;}.director-blockers button.warning{border-color:#c9a24a88;background:#3d3722;color:#f3e2b0}
  .director-check{color:#7bd1ad;font-size:1em;line-height:1}.director-backdrop{position:fixed;inset:0;background:#0009;z-index:1000}
  .director-panel{position:fixed;inset:5vh 5vw;background:var(--hud-bg,#1b2029);color:var(--hud-text,#eee);z-index:1001;border:1px solid var(--hud-line,#555);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 80px #000a}
  header{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid #6665}h2,h3,p{margin:0}h2{font-size:1.2rem}header p{color:var(--hud-muted,#aaa);font-size:.8rem}header button{background:none;border:0;color:inherit;cursor:pointer;font-size:1.3rem}
  .director-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 20px;border-bottom:1px solid #6665}.director-controls label{display:grid;gap:3px;font-size:.8rem}.director-controls .inline{display:flex;align-items:center}.director-buttons{display:flex;gap:8px;flex-wrap:wrap}.director-buttons button,.director-change button{background:#334b5e;color:white;border:1px solid #8093a2;border-radius:5px;padding:5px 10px;cursor:pointer}button:disabled{opacity:.45;cursor:default}
  .director-error{color:#ffb7a7;padding:4px 20px}.director-body{display:grid;grid-template-columns:minmax(150px,220px) 1fr;min-height:0;flex:1}.director-body aside{overflow:auto;padding:12px;border-right:1px solid #6665}.director-body main{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}.director-overview{padding:10px 18px;max-height:28%;overflow:auto;flex-shrink:0;border-bottom:1px solid #6665}h3{font-size:.9rem;margin:12px 0 8px}.director-page{display:grid;grid-template-columns:1fr auto;gap:4px;padding:5px;border-bottom:1px solid #6663}.director-page.current{background:#6688a633}.director-page strong{font-size:.75rem}.director-page strong.passed{color:#7bd1ad}.director-page small{grid-column:1/3;color:var(--hud-muted,#aaa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .director-run{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.director-run select{max-width:350px}.director-change{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px;border-bottom:1px solid #6663}.director-events{display:grid;gap:3px}.director-event{display:grid;grid-template-columns:auto 1fr auto;align-items:start;gap:8px;width:100%;text-align:left;cursor:pointer;color:inherit;background:transparent;border:1px solid transparent;border-left:3px solid #6666;border-radius:4px;padding:5px 8px;font-size:.82rem;line-height:1.35}.director-event:hover{background:#ffffff0a}.director-event small{color:var(--hud-muted,#aaa);font-size:.68rem;font-variant-numeric:tabular-nums;padding-top:2px}.director-event i{padding-top:1px}
  .director-event.tone-good{border-left-color:var(--d-good)}.director-event.tone-bad{border-left-color:var(--d-bad);background:color-mix(in srgb,var(--d-bad) 9%,transparent)}.director-event.tone-warn{border-left-color:var(--d-warn)}.director-event.tone-info{border-left-color:var(--d-info)}.director-event.tone-muted{border-left-color:#6664;color:var(--hud-muted,#aaa)}
  .tone-good>i,.tone-good.director-detail-title,span.tone-good{color:var(--d-good)}.tone-bad>i,.tone-bad.director-detail-title,span.tone-bad{color:var(--d-bad)}.tone-warn>i,.tone-warn.director-detail-title,span.tone-warn{color:var(--d-warn)}.tone-info>i{color:var(--d-info)}.tone-muted>i{color:#888}
  .director-event.tone-muted span{color:var(--hud-muted,#aaa)}.director-event.tone-bad span{color:var(--d-bad-text)}
  .director-stage-heading{margin:10px 0 2px;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--hud-muted,#aaa)}
  .director-log-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}.director-log-head h3{margin:0!important}.director-tally{display:flex;gap:8px;font-size:.75rem;margin-right:auto}
  .director-detail-title{font-size:1rem!important;line-height:1.35;overflow-wrap:anywhere}.director-detail-meta{font-size:.72rem;color:var(--hud-muted,#aaa);margin:4px 0 0!important}
  details.director-log-field summary{padding:5px 9px;cursor:pointer;color:var(--hud-muted,#bbb);font-size:.72rem;font-weight:600}details.director-log-field[open] summary{border-bottom:1px solid #6664}.director-event span{overflow-wrap:anywhere}.director-event.selected{border-color:var(--hud-teal-ink,#7bd1ad);background:#6688a633}.director-log-fields{display:grid;gap:8px;margin-top:10px}.director-log-field{min-width:0;border:1px solid #6664;border-radius:5px;background:#0002;overflow:hidden}.director-log-field h4{margin:0;padding:5px 9px;border-bottom:1px solid #6664;color:var(--hud-muted,#bbb);font-size:.72rem;font-weight:600;letter-spacing:.03em}.director-log-text,.director-log-json{margin:0;padding:8px 10px;overflow-wrap:anywhere;white-space:pre-wrap;font-size:.82rem;line-height:1.5}.director-log-json{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.76rem}.director-images{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.director-image-button{padding:0;border:1px solid #777;background:transparent;cursor:zoom-in;max-width:100%;border-radius:3px}.director-image-button:focus-visible{outline:2px solid var(--hud-teal-ink,#7bd1ad);outline-offset:3px}.director-images img{max-width:min(260px,100%);max-height:340px;object-fit:contain;background:white}select{background:var(--hud-bg,#222);color:inherit;border:1px solid #777;border-radius:4px;padding:5px}
  .director-log{display:grid;grid-template-columns:minmax(280px,42%) minmax(0,1fr);min-height:0;flex:1}.director-log-list,.director-log-content{overflow:auto;min-width:0;padding:12px 16px;overscroll-behavior:contain}.director-log-list{border-right:1px solid #6665}.director-log-list h3,.director-log-content h3{margin-top:0}.director-log-content>p,.director-events>p{color:var(--hud-muted,#aaa);font-size:.85rem}
  @media(max-width:1000px){.director-body{grid-template-columns:145px minmax(0,1fr)}.director-log{grid-template-columns:minmax(180px,40%) minmax(0,1fr)}}
  @media(max-width:700px){.director-controls{max-height:45vh!important}.director-panel{inset:0;border-radius:0}.director-body{grid-template-columns:1fr;grid-template-rows:100px minmax(0,1fr)}.director-log{grid-template-columns:minmax(130px,40%) minmax(0,1fr)}.director-log-list,.director-log-content{padding:8px}.director-controls{max-height:25vh;overflow:auto;flex-shrink:0}.director-overview{max-height:25%}.director-body aside{max-height:120px;border-right:0;border-bottom:1px solid #6665}}
</style>

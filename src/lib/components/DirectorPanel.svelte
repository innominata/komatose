<script lang="ts">
  import { onMount, untrack } from 'svelte';
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
  // Page or chapter, switchable in the panel. Opening follows where the editor is.
  let mode=$state<'page'|'chapter'>('page');
  let wasOpen=false;
  $effect(()=>{ if(open && !wasOpen) mode=untrack(()=>scope); wasOpen=open; });
  // Narrow screens show either the log list or one item's detail.
  let showDetail=$state(false);
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
  const eligible=$derived(mode==='page' ? !!logPage : pages.length>0);
  const canStart=$derived(canEdit && !busy && !working && !locked && eligible && !!selectedModel && tasks.length>0);
  const auditEvents=$derived(events.filter(event=> event.run_id===selectedRun && event.image_id===logPage?.id &&
    ['run','page','request','critique:reused','proofreader:question','proofreader:images','critique','director:request',
      'transcription:attempt','transcription:fallback','text:correlate','translation:review','stage','stage:error','stage:reused','stage:skipped','clean:fallback','clean:retry','clean:request','clean:result','clean:damage','clean:second-opinion','clean:residue','clean:waiting','repair:stalled','finding:unconfirmed','lettering:changed','region:created','region:rendering','region:excluded','region:removed','region:extended','region:relocated','region:read','type:changed','type:created','findings','retry','automation:error','automation:request','automation:response','automation:fallback','clean:over-artwork','clean:outside-regions','region:rejected','director:stalled','ocr:error','memory:warning','director:response','edit','typeset:result','page:empty','undo','model:error','director:correction','region:detect','region:detected','region:lettering-check','region:non-text','region:move-refused','region:punctuation','edit:held','region:reference-type'].includes(event.kind)
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
    if (['stage:error','model:error','automation:error','clean:residue','clean:damage','repair:stalled','director:stalled','director:correction','ocr:error','clean:over-artwork','clean:outside-regions','region:rejected'].includes(k)) return 'bad';
    if (k==='run') return d.state==='completed'?(/need attention/.test(d.message||'')?'warn':'good'):d.state==='running'?'info':'bad';
    if (k==='stage:skipped' && /not selected/i.test(d.reason||'')) return 'muted';
    if (k==='page') return d.state==='passed'||d.state==='partial'?'good':d.state==='working'?'info':d.state==='unresolved'?'bad':'warn';
    if (k==='automation:response') return d.output?.safe===false?'bad':d.output?.safe===true?'good':'muted';
    if (k==='typeset:result') return d.errors?.length?'bad':'good';
    if (k==='director:response') return d.textComplete===false?'warn':'good';
    if (['clean:result','clean:second-opinion','region:reference-type','stage:reused','critique:reused','region:created','region:extended','region:non-text'].includes(k)) return 'good';
    if (k==='region:detect'||k==='region:detected') return 'muted';
    if (k==='region:move-refused'||(k==='region:lettering-check'&&!d.hasLettering)) return 'warn';
    if (['edit:held','clean:fallback','clean:retry','automation:fallback','memory:warning','finding:unconfirmed','retry','findings','transcription:fallback','translation:review','region:excluded','region:removed','stage:skipped'].includes(k)) return 'warn';
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
    if(event.kind==='clean:request') return detail.scope==='touch-up' ? `${tidy(detail.reason)} in ${regions(detail.regionIds)} with LaMa` : `Cleaning ${regions(detail.regionIds)} with ${detail.method}`;
    if(event.kind==='clean:result') return detail.regionIds?.length ? `Cleaned ${regions(detail.regionIds)} (${detail.method})${detail.remainingRegionIds?.length?`, ${detail.remainingRegionIds.length} still to do`:''}` : `Cleaned artwork verified (${detail.method})`;
    if(event.kind==='clean:residue' && detail.kind==='detected') return `Clean rejected: the text detector still finds ${Math.round((detail.findings?.[0]?.share??0)*100)}% of the lettering in ${regions(detail.findings?.map((f:any)=>f.lineId))}`;
    if(event.kind==='clean:residue') return `Clean rejected: leftover lettering or smudges in ${detail.findings?.length??0} regions`;
    if(event.kind==='region:reference-type') return `${region(detail.lineId)} typed ${detail.typeId} from a reference chapter with the same text`;
    if(event.kind==='clean:damage') return `Clean rejected: ${tidy(detail.reason || 'artwork damage measured')}`;
    if(event.kind==='clean:second-opinion') return `Clean kept: ${regions(detail.regionIds)} passed two of three artwork checks`;
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
    if(event.kind==='edit:held') return `Held for review: final check suggested ${quote(detail.proposed?.english)} for ${region(detail.lineId)}, which a check already revised to ${quote(detail.current?.english)}`;
    if(event.kind==='region:punctuation') return detail.kept ? `Kept ${quote(detail.source)} in ${region(detail.lineId)} as drawn (series setting): not cleaned or lettered` : `${region(detail.lineId)} ${quote(detail.source)} will be cleaned and lettered again (series setting)`;
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
  // Shown as pictures above the fields instead of as asset hashes.
  const CLEAN_IMAGE_FIELDS=new Set(['image','mask','maskOverlay']);
  function logFields(detail:unknown,kind=''):{label:string;value:unknown}[] {
    if (detail && typeof detail==='object' && !Array.isArray(detail))
      return Object.entries(detail).filter(([label])=>!HIDDEN_FIELDS.has(label) && !(kind==='clean:request' && CLEAN_IMAGE_FIELDS.has(label)))
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
    void act({action:retryBlocked?'retry-blocked':'start',scope:mode,imageId:mode==='page'?logPage?.id:undefined,
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
  /** Menus are <details>; close the others when one opens, and all of them on an outside click. */
  let panelEl=$state<HTMLElement>();
  function closeMenus(except?:Element) {
    for (const menu of panelEl?.querySelectorAll('details.director-menu[open]')??[]) if (menu!==except) menu.removeAttribute('open');
  }
  function menuToggled(event:{currentTarget:HTMLDetailsElement}) {
    const menu=event.currentTarget;
    if (menu.open) closeMenus(menu);
  }
  const runLabel=(item:Run)=>`${new Date(item.created_at).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} · ${item.scope} · ${directorStatusLabel(item.state)}`;
  const pageFindings=$derived(logPage?.findings??[]);
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

<button type="button" class="ed-btn" data-find="director" onclick={()=>{selectedPageId=pageId;showDetail=false;open=true;void refresh();}}>
  <i class="bi bi-stars" aria-hidden="true"></i> Director
  {#if page?.state==='passed' && scope==='page'}<span class="director-check" title="Automated checks passed; human approval remains" aria-label="Automated checks passed; human approval remains"><i class="bi bi-check-circle-fill" aria-hidden="true"></i></span>{/if}
</button>
{#if open}
  <div class="director-backdrop" role="presentation" onclick={()=>open=false}></div>
  <div class="director-panel" role="dialog" aria-modal="true" aria-label="Director mode" tabindex="-1" bind:this={panelEl}
    onclick={(e)=>{ if(!(e.target as Element).closest('details.director-menu')) closeMenus(); }}
    onkeydown={(e)=>{ if(e.key==='Escape'){ if(panelEl?.querySelector('details.director-menu[open]')) closeMenus(); else open=false; } }}>
    <header class="director-bar">
      <h2><i class="bi bi-stars" aria-hidden="true"></i> Director</h2>
      <div class="director-mode" role="group" aria-label="Director scope">
        <button type="button" class:active={mode==='page'} aria-pressed={mode==='page'} disabled={working} onclick={()=>mode='page'}>Page {logPage?.pageNumber??''}</button>
        <button type="button" class:active={mode==='chapter'} aria-pressed={mode==='chapter'} disabled={working} onclick={()=>mode='chapter'}>Chapter</button>
      </div>
      <label class="director-model"><span class="sr-only">Chat and vision model</span>
        <select bind:value={selectedModel} disabled={working||locked} title="Chat and vision model">
          {#each models as model}<option value={model.id}>{model.name}</option>{/each}
        </select>
      </label>
      <details class="director-menu" ontoggle={menuToggled}>
        <summary class:warn={!tasks.length} title="Choose which Director tasks run">Tasks {tasks.length}/{ALL_DIRECTOR_TASKS.length} <i class="bi bi-chevron-down" aria-hidden="true"></i></summary>
        <div class="director-pop director-tasks" aria-label="Director tasks">
          <div class="director-presets" role="group" aria-label="Task presets">
            {#each presets as preset}<button type="button" class:active={samePreset(preset.tasks)} aria-pressed={samePreset(preset.tasks)} disabled={working||locked} onclick={()=>tasks=[...preset.tasks]}>{preset.label}</button>{/each}
          </div>
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
        </div>
      </details>
      <div class="director-actions">
        {#if run?.state==='running'}
          <button type="button" disabled={working} onclick={()=>void act({action:'pause',runId:run.id})}><i class="bi bi-pause-fill" aria-hidden="true"></i> Pause</button>
          <button type="button" class="danger" disabled={working} onclick={()=>void act({action:'stop',runId:run.id})}><i class="bi bi-stop-fill" aria-hidden="true"></i> Stop</button>
        {:else if run && ['paused','interrupted','failed'].includes(run.state)}
          <button type="button" disabled={working||locked||!eligible} onclick={()=>void act({action:'resume',runId:run.id})}><i class="bi bi-play-fill" aria-hidden="true"></i> Resume</button>
        {/if}
        <button type="button" class="primary" disabled={!canStart} aria-label={`Run ${mode} Director`} onclick={()=>start()}><i class="bi bi-play-fill" aria-hidden="true"></i> Run {tasks.length===ALL_DIRECTOR_TASKS.length?'':`${tasks.length} task${tasks.length===1?'':'s'} on `}{mode==='page'?'page':'chapter'}</button>
        <details class="director-menu" ontoggle={menuToggled}>
          <summary aria-label="More Director actions" title="More"><i class="bi bi-three-dots" aria-hidden="true"></i></summary>
          <div class="director-pop director-more">
            {#if mode==='chapter'}
              <label class="inline"><input type="checkbox" bind:checked={recheckAll}> Recheck passed and stale pages</label>
              <button type="button" disabled={!canStart||!pages.some(p=>p.state==='unresolved')} onclick={()=>{closeMenus();start(true);}}>Retry blocked pages</button>
            {:else if logPage}
              <button type="button" title="Forget saved stage results so the next run redoes every task on this page. Edits stay undoable." disabled={!canEdit||working||locked}
                onclick={()=>{closeMenus();if(confirm(`Reset Director for page ${logPage.pageNumber??'?'}? The next run redoes every task instead of reusing saved results.`)) void act({action:'reset-page',imageId:logPage.id});}}>Reset page</button>
            {/if}
            <button type="button" disabled={working||locked} onclick={()=>{closeMenus();void checkSetup();}}>Check setup</button>
            <button type="button" onclick={()=>{open=false;onsettings?.();}}>Director settings</button>
          </div>
        </details>
      </div>
      <button type="button" class="director-close" aria-label="Close Director" onclick={()=>open=false}><i class="bi bi-x-lg" aria-hidden="true"></i></button>
    </header>
    <div class="director-status">
      {#if runs.length>1}
        <label><span class="sr-only">Run</span><select bind:value={selectedRun} onchange={()=>void refresh()} title="Choose a run">
          {#each runs as item}<option value={item.id}>{runLabel(item)}</option>{/each}
        </select></label>
      {:else if run}<span class="director-run-name">{runLabel(run)}</span>
      {:else}<span class="director-run-name">No runs yet</span>{/if}
      {#if run}<span class="director-run-message state-{run.state}" title={run.message}>{run.message}</span>
        {#if runTasks(run).length<ALL_DIRECTOR_TASKS.length}<span class="director-run-tasks" aria-label="Tasks in this run">{#each DIRECTOR_TASKS as task}<span class:on={runTasks(run).includes(task.id)}>{task.label}</span>{/each}</span>{/if}
      {:else}<span class="director-run-message">{mode==='page' ? `Page ${logPage?.pageNumber??'—'} · ${directorStatusLabel(logPage?.state??'pending')}` : `Whole chapter · ${pages.filter(p=>p.state==='passed'||p.state==='stale').length} of ${pages.length} passed`}</span>{/if}
      {#if run}
        <details class="director-menu director-undo" ontoggle={menuToggled}>
          <summary><i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i> Undo</summary>
          <div class="director-pop">
            <button type="button" disabled={working||locked||!changes.some(c=>!c.undone)} onclick={()=>{closeMenus();void act({action:'undo',runId:run.id});}}>Undo run</button>
            {#if logPage}<button type="button" disabled={working||locked||!changes.some(c=>!c.undone&&c.image_id===logPage.id)} onclick={()=>{closeMenus();void act({action:'undo',runId:run.id,imageId:logPage.id});}}>Undo page {logPage.pageNumber??'?'}</button>{/if}
            {#if pageChanges.length}<h4>Page {logPage?.pageNumber??'?'} changes</h4>
              <div class="director-changes">{#each pageChanges as change}<div class="director-change"><span>#{change.id} {change.label}{change.undone?' · undone':''}</span>
                <button type="button" disabled={working||locked||!!change.undone} onclick={()=>void act({action:'undo',runId:run.id,changeId:change.id})}>Undo</button></div>{/each}</div>{/if}
          </div>
        </details>
      {/if}
    </div>
    {#if error}<p class="director-error" role="alert">{error}</p>{/if}
    {#if !eligible}<p class="director-error">Choose a story page first.</p>{/if}
    {#if preflight.length}<div class="director-preflight"><div>{#each preflight as issue}<p>{issue.stage}: {issue.message}</p>{/each}</div>
      <button type="button" aria-label="Dismiss setup check" onclick={()=>preflight=[]}><i class="bi bi-x" aria-hidden="true"></i></button></div>{/if}
    <div class="director-body">
      <aside aria-label="Pages">
        <div class="director-pages">{#each pages as item}
          <button type="button" class="director-page state-{item.state}" class:current={item.id===logPage?.id} aria-pressed={item.id===logPage?.id} aria-label={`Page ${item.pageNumber??'?'}`}
            title={[directorStatusLabel(item.state),item.stage?stageName(item.stage):'',tidy(item.detail||'')].filter(Boolean).join(' · ')}
            onclick={()=>{selectedPageId=item.id;showDetail=false;}}>
            <span class="dot" aria-hidden="true"></span><span class="num">Page {item.pageNumber??'?'}</span>
            <small>{directorStatusLabel(item.state)}{item.stage?` · ${stageName(item.stage)}`:''}</small>
          </button>{/each}</div>
        <p class="director-footnote">Checks passed does not mark a page Done. Warnings do not block; dismiss them in Review.</p>
      </aside>
      <div class="director-log" class:show-detail={showDetail}>
        <section class="director-log-list" aria-label="Director log items">
          <div class="director-log-head"><h3>Page {logPage?.pageNumber??'—'}</h3>
            <span class="director-tally">{#if toneCounts.good}<span class="tone-good"><i class="bi bi-check-circle-fill" aria-hidden="true"></i> {toneCounts.good}</span>{/if}{#if toneCounts.warn}<span class="tone-warn"><i class="bi bi-exclamation-triangle-fill" aria-hidden="true"></i> {toneCounts.warn}</span>{/if}{#if toneCounts.bad}<span class="tone-bad"><i class="bi bi-x-circle-fill" aria-hidden="true"></i> {toneCounts.bad}</span>{/if}</span>
            <div class="director-presets" role="group" aria-label="Log filter">
              <button type="button" class:active={toneFilter==='all'} aria-pressed={toneFilter==='all'} onclick={()=>toneFilter='all'}>All</button>
              <button type="button" class:active={toneFilter==='problems'} aria-pressed={toneFilter==='problems'} onclick={()=>toneFilter='problems'}>Problems</button>
            </div>
            {#if logPage}<button type="button" class="director-open" title="Open this page in the editor" onclick={()=>inspect(logPage)}>Open <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></button>{/if}
          </div>
          {#if pageFindings.length && logPage}
            <div class="director-findings" aria-label="Page blockers">
              {#each pageFindings as finding}<button type="button" class:warning={finding.severity==='warning'} onclick={()=>inspect(logPage,finding)}>
                <i class="bi {finding.severity==='warning'?'bi-exclamation-triangle':'bi-x-octagon'}" aria-hidden="true"></i>
                <span>{stageName(finding.stage)}{finding.lineId?` · ${region(finding.lineId)}`:''}: {tidy(finding.message)}</span></button>{/each}
            </div>
          {/if}
          <div class="director-events">
            {#each logRows.filter(row=>toneFilter==='all'||row.tone==='bad'||row.tone==='warn') as row (row.event.id)}
              {#if row.heading && toneFilter==='all'}<h4 class="director-stage-heading">{row.heading}</h4>{/if}
              <button type="button" class="director-event tone-{row.tone}" class:selected={row.event.id===selectedEvent?.id} aria-pressed={row.event.id===selectedEvent?.id} onclick={()=>{selectedEventId=row.event.id;showDetail=true;}}>
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
            <button type="button" class="director-back" onclick={()=>showDetail=false}><i class="bi bi-arrow-left" aria-hidden="true"></i> Log</button>
            <h3 class="director-detail-title tone-{eventTone(event)}"><i class="bi {TONE_ICONS[eventTone(event)]}" aria-hidden="true"></i> {eventSummary(event)}</h3>
            <p class="director-detail-meta">{new Date(event.created_at).toLocaleString()} · <code>{event.kind}</code></p>
              {#if event.detail?.images && Array.isArray(event.detail.images)}<div class="director-images">{#each event.detail.images as hash}{@render logImage(hash,"Sent to model or proofreader")}{/each}</div>{/if}
              {#if event.detail?.sent && Array.isArray(event.detail.sent)}<div class="director-images">{#each event.detail.sent as hash}{@render logImage(hash,"Exact proofreader input")}{/each}</div>{/if}
              {#if event.detail?.input?.images && Array.isArray(event.detail.input.images)}<div class="director-images">{#each event.detail.input.images as item}{#if item.imageAsset}{@render logImage(item.imageAsset,"Exact model input")}{/if}{/each}</div>{/if}
              {#if event.detail?.raw && !Array.isArray(event.detail?.sent)}<div class="director-images">{@render logImage(event.detail.raw,"Saved raw page")}
                {#if event.detail?.typeset}{@render logImage(event.detail.typeset,"Saved typeset page")}{/if}</div>{/if}
              {#if event.detail?.crop}<div class="director-images">{@render logImage(event.detail.crop,"Crop sent for transcription")}</div>{/if}
              {#if event.kind==='clean:request' && (event.detail?.maskOverlay || event.detail?.mask)}<div class="director-images">{#if event.detail.maskOverlay}{@render logImage(event.detail.maskOverlay,"Mask sent to the cleaner, over its input")}{/if}{#if event.detail.image}{@render logImage(event.detail.image,"Exact cleaner input")}{/if}{#if event.detail.mask}{@render logImage(event.detail.mask,"Exact mask")}{/if}</div>{/if}
              {#if event.kind==='clean:residue' && event.detail?.candidate}<div class="director-images">{@render logImage(event.detail.candidate,"Rejected clean: leftover strokes")}</div>{/if}
              <div class="director-log-fields">
                {#each logFields(event.detail,event.kind) as field}
                  {@const view=logView(field.value)}
                  {#if view.json}<details class="director-log-field"><summary>{field.label}</summary><pre class="director-log-json">{view.text}</pre></details>
                  {:else}<section class="director-log-field"><h4>{field.label}</h4><div class="director-log-text">{tidy(view.text)}</div></section>{/if}
                {/each}
              </div>
          {:else}<p>Select a log item to view its content.</p>{/if}
        </section>
        {/key}
      </div>
    </div>
  </div>
{/if}

{#if open && expandedImage}<DirectorImageViewer src={`${apiBase}/workflow/assets/${expandedImage.hash}`} label={expandedImage.label} onclose={()=>expandedImage=null}/>{/if}

<style>
  .director-panel{--d-good:#1f8a52;--d-bad:#c0364a;--d-bad-text:#8f1f30;--d-warn:#a8700a;--d-info:#2f6fae;--d-line:color-mix(in srgb,var(--hud-text,#eee) 14%,transparent);--d-soft:color-mix(in srgb,var(--hud-text,#eee) 6%,transparent);--d-accent:var(--hud-teal-ink,#2f7a5f)}
  :global(:root[data-theme='dark']) .director-panel{--d-good:#6fd39b;--d-bad:#f07e78;--d-bad-text:#ffd6d3;--d-warn:#e8bd5c;--d-info:#7fb3e6}
  .director-check{color:#7bd1ad;font-size:1em;line-height:1}
  .director-backdrop{position:fixed;inset:0;background:#0009;z-index:1000}
  .director-panel{position:fixed;inset:3vh 3vw;background:var(--hud-bg,#1b2029);color:var(--hud-text,#eee);z-index:1001;border:1px solid var(--hud-line,#555);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 80px #000a;font-size:.85rem}
  h2,h3,h4,p{margin:0}
  .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  button,select,summary{font:inherit}
  button:disabled{opacity:.45;cursor:default}
  select{background:var(--hud-bg,#222);color:inherit;border:1px solid var(--d-line);border-radius:6px;padding:5px 8px;min-width:0}

  /* One-row toolbar */
  .director-bar{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 16px;border-bottom:1px solid var(--d-line);flex-wrap:wrap}
  .director-bar h2{font-size:1rem;display:flex;align-items:center;gap:6px;margin-right:4px}
  .director-mode{display:inline-flex;border:1px solid var(--d-line);border-radius:8px;overflow:hidden}
  .director-mode button{background:transparent;color:inherit;border:0;padding:5px 12px;cursor:pointer;white-space:nowrap}
  .director-mode button+button{border-left:1px solid var(--d-line)}
  .director-mode button.active{background:var(--d-accent);color:#fff;font-weight:600}
  .director-model{flex:0 1 240px;min-width:120px;display:flex}.director-model select{width:100%}
  .director-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
  .director-actions>button,.director-pop button,.director-change button{background:var(--d-soft);color:inherit;border:1px solid var(--d-line);border-radius:6px;padding:5px 11px;cursor:pointer;white-space:nowrap}
  .director-actions>button.primary{background:var(--d-accent);border-color:var(--d-accent);color:#fff;font-weight:600}
  .director-actions>button.danger{background:color-mix(in srgb,var(--d-bad) 80%,#000);border-color:var(--d-bad);color:#fff}
  .director-close{background:none;border:0;color:inherit;cursor:pointer;font-size:1.05rem;padding:4px 6px;border-radius:6px}.director-close:hover{background:var(--d-soft)}

  /* Menus: <details> with a floating panel */
  .director-menu{position:relative}
  .director-menu>summary{list-style:none;cursor:pointer;border:1px solid var(--d-line);border-radius:6px;padding:5px 10px;white-space:nowrap;user-select:none}
  .director-menu>summary::-webkit-details-marker{display:none}
  .director-menu>summary.warn{border-color:var(--d-warn);color:var(--d-warn)}
  .director-menu[open]>summary{background:var(--d-soft)}
  .director-pop{position:absolute;top:calc(100% + 6px);left:0;z-index:5;min-width:220px;max-width:min(520px,90vw);background:var(--hud-bg,#1b2029);border:1px solid var(--d-line);border-radius:10px;box-shadow:0 12px 40px #0006;padding:10px;display:grid;gap:8px}
  .director-actions .director-pop{left:auto;right:0}
  .director-pop button{text-align:left}
  .director-pop h4{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--hud-muted,#aaa);margin-top:4px}
  .director-more .inline,.director-tasks .inline{display:flex;align-items:center;gap:6px}
  .director-tasks{min-width:min(460px,90vw)}
  .director-tasks ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:5px}
  .director-presets{display:flex;gap:4px;flex-wrap:wrap}.director-presets button{background:transparent;color:inherit;border:1px solid var(--d-line);border-radius:999px;padding:2px 10px;font-size:.75rem;cursor:pointer}.director-presets button.active{border-color:var(--d-accent);color:var(--d-accent);font-weight:600}
  .director-task{display:flex;align-items:center;gap:6px;padding:3px 10px 3px 4px;border:1px solid var(--d-line);border-radius:999px;font-size:.78rem;white-space:nowrap;cursor:pointer;opacity:.55;transition:opacity .12s,border-color .12s}.director-task.on{opacity:1;border-color:var(--d-accent);background:var(--d-soft)}
  .director-task input{position:absolute;opacity:0;pointer-events:none}.director-task:focus-within{outline:2px solid var(--d-accent);outline-offset:1px}.director-task .step{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:var(--d-line);font-size:.68rem;font-weight:600}.director-task.on .step{background:var(--d-accent);color:#fff}
  .director-hint{font-size:.75rem;color:var(--hud-muted,#aaa)}.director-hint.warn{color:var(--d-warn)}
  .director-changes{display:grid;max-height:40vh;overflow:auto}
  .director-change{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--d-line)}

  /* One-line status strip */
  .director-status{display:flex;align-items:center;gap:10px;padding:6px 16px;border-bottom:1px solid var(--d-line);min-height:38px;flex-wrap:wrap;color:var(--hud-muted,#aaa)}
  .director-status select{max-width:300px;font-size:.8rem;padding:3px 6px}
  .director-run-name{font-size:.8rem}
  .director-run-message{color:var(--hud-text,#eee);flex:1 1 200px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .director-run-message.state-running::before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--d-info);margin-right:6px;animation:director-pulse 1.2s ease-in-out infinite}
  @keyframes director-pulse{50%{opacity:.3}}
  .director-run-tasks{display:inline-flex;gap:4px;flex-wrap:wrap}.director-run-tasks span{font-size:.68rem;padding:1px 7px;border-radius:999px;border:1px solid var(--d-line);opacity:.4;text-decoration:line-through}.director-run-tasks span.on{opacity:1;text-decoration:none;border-color:var(--d-accent)}
  .director-undo{margin-left:auto}.director-undo>summary{padding:3px 9px;font-size:.8rem;color:var(--hud-text,#eee)}.director-undo .director-pop{left:auto;right:0;min-width:280px}
  .director-error{color:var(--d-bad);padding:6px 16px;border-bottom:1px solid var(--d-line)}
  .director-preflight{display:flex;gap:8px;align-items:flex-start;padding:6px 16px;font-size:.8rem;border-bottom:1px solid var(--d-line);max-height:120px;overflow:auto;background:var(--d-soft)}.director-preflight>div{flex:1}.director-preflight button{background:none;border:0;color:inherit;cursor:pointer}

  /* Body: pages | log list | detail */
  .director-body{display:grid;grid-template-columns:150px minmax(0,1fr);min-height:0;flex:1}
  .director-body aside{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--d-line)}
  .director-pages{overflow:auto;padding:8px;display:grid;gap:2px;align-content:start;flex:1}
  .director-page{display:grid;grid-template-columns:auto 1fr;column-gap:7px;align-items:center;text-align:left;background:transparent;color:inherit;border:1px solid transparent;border-radius:6px;padding:5px 7px;cursor:pointer}
  .director-page:hover{background:var(--d-soft)}.director-page.current{background:var(--d-soft);border-color:var(--d-line)}
  .director-page .num{font-weight:600}.director-page small{grid-column:2;color:var(--hud-muted,#aaa);font-size:.7rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .director-page .dot{width:8px;height:8px;border-radius:50%;background:var(--d-line)}
  .director-page.state-passed .dot{background:var(--d-good)}.director-page.state-unresolved .dot{background:var(--d-bad)}.director-page.state-working .dot,.director-page.state-running .dot{background:var(--d-info)}.director-page.state-stale .dot{background:var(--d-warn)}
  .director-footnote{font-size:.68rem;color:var(--hud-muted,#aaa);padding:8px 10px;border-top:1px solid var(--d-line);line-height:1.35}
  .director-log{display:grid;grid-template-columns:minmax(300px,42%) minmax(0,1fr);min-height:0}
  .director-log-list,.director-log-content{overflow:auto;min-width:0;padding:10px 14px;overscroll-behavior:contain}
  .director-log-list{border-right:1px solid var(--d-line)}
  .director-log-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;position:sticky;top:-10px;background:var(--hud-bg,#1b2029);padding:4px 0;z-index:1}
  .director-log-head h3{font-size:.95rem}.director-tally{display:flex;gap:8px;font-size:.75rem;margin-right:auto}
  .director-open{background:none;border:1px solid var(--d-line);color:inherit;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:.75rem}
  .director-findings{display:grid;gap:4px;margin-bottom:10px}
  .director-findings button{display:flex;gap:8px;align-items:flex-start;text-align:left;border:1px solid color-mix(in srgb,var(--d-bad) 50%,transparent);background:color-mix(in srgb,var(--d-bad) 10%,transparent);color:inherit;padding:6px 9px;border-radius:6px;cursor:pointer;font-size:.8rem;line-height:1.35}
  .director-findings button i{color:var(--d-bad);padding-top:1px}
  .director-findings button.warning{border-color:color-mix(in srgb,var(--d-warn) 50%,transparent);background:color-mix(in srgb,var(--d-warn) 10%,transparent)}.director-findings button.warning i{color:var(--d-warn)}
  .director-events{display:grid;gap:3px}
  .director-event{display:grid;grid-template-columns:auto 1fr auto;align-items:start;gap:8px;width:100%;text-align:left;cursor:pointer;color:inherit;background:transparent;border:1px solid transparent;border-left:3px solid var(--d-line);border-radius:4px;padding:5px 8px;font-size:.82rem;line-height:1.35}
  .director-event:hover{background:var(--d-soft)}.director-event small{color:var(--hud-muted,#aaa);font-size:.68rem;font-variant-numeric:tabular-nums;padding-top:2px}.director-event i{padding-top:1px}
  .director-event span{overflow-wrap:anywhere}.director-event.selected{border-color:var(--d-accent);background:var(--d-soft)}
  .director-event.tone-good{border-left-color:var(--d-good)}.director-event.tone-bad{border-left-color:var(--d-bad);background:color-mix(in srgb,var(--d-bad) 9%,transparent)}.director-event.tone-warn{border-left-color:var(--d-warn)}.director-event.tone-info{border-left-color:var(--d-info)}.director-event.tone-muted{border-left-color:var(--d-line);color:var(--hud-muted,#aaa)}
  .tone-good>i,.tone-good.director-detail-title,span.tone-good{color:var(--d-good)}.tone-bad>i,.tone-bad.director-detail-title,span.tone-bad{color:var(--d-bad)}.tone-warn>i,.tone-warn.director-detail-title,span.tone-warn{color:var(--d-warn)}.tone-info>i{color:var(--d-info)}.tone-muted>i{color:#888}
  .director-event.tone-muted span{color:var(--hud-muted,#aaa)}.director-event.tone-bad span{color:var(--d-bad-text)}
  .director-stage-heading{margin:10px 0 2px;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--hud-muted,#aaa)}
  .director-back{display:none;background:none;border:1px solid var(--d-line);color:inherit;border-radius:6px;padding:3px 10px;cursor:pointer;margin-bottom:8px}
  .director-detail-title{font-size:1rem;line-height:1.35;overflow-wrap:anywhere}.director-detail-meta{font-size:.72rem;color:var(--hud-muted,#aaa);margin:4px 0 0}
  .director-log-content>p,.director-events>p{color:var(--hud-muted,#aaa);font-size:.85rem}
  details.director-log-field summary{padding:5px 9px;cursor:pointer;color:var(--hud-muted,#bbb);font-size:.72rem;font-weight:600}details.director-log-field[open] summary{border-bottom:1px solid var(--d-line)}
  .director-log-fields{display:grid;gap:8px;margin-top:10px}.director-log-field{min-width:0;border:1px solid var(--d-line);border-radius:5px;background:var(--d-soft);overflow:hidden}.director-log-field h4{margin:0;padding:5px 9px;border-bottom:1px solid var(--d-line);color:var(--hud-muted,#bbb);font-size:.72rem;font-weight:600;letter-spacing:.03em}
  .director-log-text,.director-log-json{margin:0;padding:8px 10px;overflow-wrap:anywhere;white-space:pre-wrap;font-size:.82rem;line-height:1.5}.director-log-json{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.76rem}
  .director-images{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.director-image-button{padding:0;border:1px solid var(--d-line);background:transparent;cursor:zoom-in;max-width:100%;border-radius:3px}.director-image-button:focus-visible{outline:2px solid var(--d-accent);outline-offset:3px}.director-images img{max-width:min(260px,100%);max-height:300px;object-fit:contain;background:white;display:block}

  @media(max-width:1100px){.director-log{grid-template-columns:minmax(240px,45%) minmax(0,1fr)}.director-model{flex-basis:180px}}
  /* Narrow: pages become a scrolling row, and the log shows the list or one item's detail. */
  @media(max-width:760px){
    .director-panel{inset:0;border-radius:0}
    .director-bar{padding:8px 10px;row-gap:6px}
    .director-bar h2{flex:1}
    .director-mode{order:2}.director-close{order:3}
    .director-model{order:4;flex:1 1 140px}
    .director-bar>.director-menu{order:5}
    .director-actions{order:6;margin-left:0;width:100%}.director-actions>button.primary{flex:1}
    .director-body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}
    .director-body aside{border-right:0;border-bottom:1px solid var(--d-line)}
    .director-pages{display:flex;overflow-x:auto;padding:6px 10px;gap:6px}
    .director-page{flex:0 0 auto;border-color:var(--d-line)}.director-page small{display:none}
    .director-footnote{display:none}
    .director-log{grid-template-columns:1fr}
    .director-log-list{border-right:0}
    .director-log .director-log-content{display:none}
    .director-log.show-detail .director-log-list{display:none}
    .director-log.show-detail .director-log-content{display:block}
    .director-back{display:inline-flex;gap:6px;align-items:center}
    .director-pop{position:fixed;left:8px!important;right:8px!important;top:auto;min-width:0;max-width:none}
  }
</style>

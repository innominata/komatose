const $ = (s, root = document) => root.querySelector(s);
const icon = (name) => `<i class="bi bi-${name}" aria-hidden="true"></i>`;
const esc = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stages = [
  ['Prepare', 'Arrange your pages', 'Prepare the pages', 'Get the page order and artwork ready.'],
  ['Translate', 'Create the first draft', 'Translate the dialogue', 'Read the source. Find the right words.'],
  ['Review', 'Check every line', 'Make it sound right', 'Check the meaning and approve each line.'],
  ['Clean', 'Remove original text', 'Make room for the words', 'Remove lettering while keeping the artwork.'],
  ['Typeset', 'Place your lettering', 'Bring the page to life', 'Fit the approved text into each bubble.'],
  ['Export', 'Share the chapter', 'Ready for your readers', 'Check the chapter and create your download.'],
];
const regions = [
  {source:'研修医というのは\n要するに見習いだ', en:'A medical intern is, in short, an apprentice.', x:70,y:4.8,w:15,h:18},
  {source:'医者になるには\n大学で6年間\n医学を学び',en:'To become a doctor, you study medicine at university for six years.',x:38.9,y:4.5,w:14,h:15},
  {source:'医師国家試験に\n合格しなければ\nいけない',en:'Then you have to pass the national medical examination.',x:7,y:22.5,w:17,h:15},
  {source:'ところがこの国家試験は医学の知識をみるものだ',en:'But that examination only tests your medical knowledge.',x:70,y:39.5,w:13,h:20},
  {source:'実技試験などは含まれていない',en:'There is no practical test.',x:9,y:47,w:13.5,h:14},
  {source:'もっと術野を広げろ斉藤',en:'Open up the surgical field, Saito.',x:46,y:64.5,w:12,h:12},
];
const state = {stage:1,page:9,region:0,scope:'page',overlays:true,zoom:100,filter:'all',tool:'select',cleaned:false,maskApproved:false,exported:false,approved:new Set(),translated:new Set([9]),drafts:{},settings:{language:'Japanese',direction:'Right to left',model:'Chapter default',font:'Comic lettering',size:'12',term:'斉藤 → Saito'},settingsTab:'chapter',showEnglish:false,paletteDocked:true,paletteX:96,paletteY:140,brushRadius:8,growAmount:10,brushDismissed:false,growDismissed:false,nudgeAmount:10};
const STEP = () => stages[state.stage][0];
const REGION_PAGE = () => state.page===9 && ![0,5].includes(state.stage);
const BRUSH_TOOLS = new Set(['brush','erase','clone-stamp','blur','restore','raw']);
const BRUSH_PRESETS = [2,4,8,12,16,32];
const TOOLS = {
  select:['cursor','Select (V)','Select tool. Click a region or empty page.'],
  region:['bounding-box','Draw region (R)','Demo: draw region. This prototype does not add boxes.'],
  'read-area':['eye','Read area with image model','Demo: read area with the image model. No model is called.'],
  reorder:['arrow-down-up','Reorder reading flow (O)','Demo: reorder reading flow. Region order is unchanged.'],
  brush:['brush','Mask brush (B)','Demo: mask brush. Artwork is unchanged.'],
  'style-brush':['brush-fill','Style brush · copy the selected region’s fitted text style','Demo: style brush. Click again to stop. Styles are not copied.'],
  erase:['eraser','Erase mask (E)','Demo: erase mask. Artwork is unchanged.'],
  'bubble-fill':['paint-bucket','Fill speech bubble (F) · click the empty interior','Demo: fill speech bubble. Artwork is unchanged.'],
  'clone-stamp':['copy','Clone stamp (C) · right-click source, then click and drag to paint','Demo: clone stamp. Artwork is unchanged.'],
  blur:['droplet-half','Blur (L) · paint to blend inpainted patches into a gradient','Demo: blur brush. Artwork is unchanged.'],
  restore:['clock-history','Restore (H) · paint previous-save pixels back with a soft edge','Demo: restore brush. Artwork is unchanged.'],
  raw:['image','Paint raw (S) · paint uncleaned source pixels onto the working page','Demo: paint raw. Artwork is unchanged.'],
  'mask-grow':['arrows-angle-expand','Grow mask (G) · click a mask region to expand it by the set amount','Demo: grow mask. The mask is unchanged.'],
  polygon:['pentagon','Draw polygon','Demo: draw polygon. Artwork is unchanged.'],
  rectangle:['square','Draw rectangle','Demo: draw rectangle. Artwork is unchanged.'],
  oval:['circle','Draw oval','Demo: draw oval. Artwork is unchanged.'],
  crop:['crop','Crop','Demo: crop. Artwork is unchanged.'],
  split:['vr','Split page','Demo: split page. Artwork is unchanged.'],
  reslice:['hr','Reslice strips','Demo: reslice strips. Artwork is unchanged.'],
  zoom:['zoom-in','Zoom (Z)','Zoom tool. Use the canvas zoom controls to change the view.'],
};
const INPAINT = [
  ['big-lama','AnimeManga Big-LaMa','stars','#ff6b9d','Demo: AnimeManga Big-LaMa would approve the mask and clean. Artwork is unchanged.'],
  ['aot','AOT','lightning-charge-fill','#4fd1c5','Demo: AOT would approve the mask and clean. Artwork is unchanged.'],
  ['auto','Auto · balloon fill, then Big-LaMa','layers-fill','#e8c36a','Demo: Auto would fill balloons, then run Big-LaMa. Artwork is unchanged.'],
  ['lama','Existing manga LaMa','droplet-fill','#f0a050','Demo: manga LaMa would approve the mask and clean. Artwork is unchanged.'],
  ['telea','OpenCV Telea','paint-bucket','#6bcf7f','Demo: OpenCV Telea would approve the mask and clean. Artwork is unchanged.'],
  ['flat','Sampled flat fill','square-fill','#8ea4c8','Demo: sampled flat fill would approve the mask and clean. Artwork is unchanged.'],
  ['clone','Clone / patch','copy','#b794f4','Demo: clone / patch would approve the mask and clean. Artwork is unchanged.'],
  ['codex','Codex · reconstruct artwork. Edit the prompt first.','robot','#67e8f9','Demo: Codex would ask for a prompt, then reconstruct. No model is called.'],
  ['qwen-image','Qwen-Image 2.1 · reconstruct artwork. Edit the prompt first.','magic','#c084fc','Demo: Qwen-Image 2.1 would ask for a prompt, then reconstruct. No model is called.'],
  ['qwen-image-edit','Qwen-Image-Edit 2511 · edit artwork. Edit the prompt first.','pencil-square','#a78bfa','Demo: Qwen-Image-Edit would ask for a prompt, then edit. No model is called.'],
];
const imagePath = (page, english=false) => `../../fixtures/test-pages/${english?'english/':''}${String(page).padStart(3,'0')}.jpg`;
const scopeLabel = () => state.scope==='chapter'?'chapter':`page ${state.page}`;
const primary = (label,action,ico='arrow-right') => `<button class="primary wide" data-action="${action}">${icon(ico)} ${label}</button>`;
const field = (label,control,extra='') => `<label class="field"><span>${label}${extra}</span>${control}</label>`;
const select = (key,values,current) => `<select data-setting="${key}">${values.map(v=>`<option ${v===current?'selected':''}>${esc(v)}</option>`).join('')}</select>`;
const scoped = () => `<div class="scope-line"><label for="scope">Apply to</label><select id="scope" data-action="scope"><option value="page" ${state.scope==='page'?'selected':''}>This page · ${state.page}</option><option value="chapter" ${state.scope==='chapter'?'selected':''}>Whole chapter · 10 pages</option></select></div>`;
function draft(){const key=`${state.page}-${state.region}`;return state.drafts[key]??= {...regions[state.region]};}
function toast(message){$('#toast').textContent=message;$('#toast').style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').style.display='none',3500);}
function stepTools(){
  const step=STEP();
  const region=REGION_PAGE();
  if(step==='Prepare') return ['select','crop','split','reslice','zoom'];
  if(step==='Translate'||step==='Review') return ['select','region','reorder','read-area','zoom'];
  if(step==='Clean') return ['select','brush','erase','bubble-fill','clone-stamp','blur','restore','raw','mask-grow',...(region?['polygon']:[]),'zoom'];
  if(step==='Typeset') return ['select','style-brush','brush','erase',...(region?['polygon','rectangle','oval']:[]),'zoom'];
  return ['zoom'];
}
function palBtn(id){
  if(id==='polygon'&&state.tool==='polygon') return `<button class="ed-rail-btn active" type="button" title="Save polygon" aria-label="Save polygon" disabled><i class="bi bi-check2"></i></button>`;
  const [ico,title]=TOOLS[id];
  const label=id==='style-brush'&&state.tool==='style-brush'?'Click regions to apply the copied style. Click again or press Esc to stop.':title;
  const disabled=id==='style-brush'&&state.tool!=='style-brush'&&!REGION_PAGE();
  return `<button class="ed-rail-btn${state.tool===id?' active':''}" type="button" data-palette="${id}" title="${esc(label)}" aria-label="${esc(label)}" aria-pressed="${state.tool===id}" ${disabled?'disabled':''}><i class="bi bi-${ico}"></i></button>`;
}
function cmd(id,ico,title,message,color=''){
  return `<button class="palette-command" type="button" data-command="${id}" data-toast="${esc(message)}" title="${esc(title)}" aria-label="${esc(title)}" ${color?`style="color:${color}"`:''}><i class="bi bi-${ico}"></i></button>`;
}
function group(name,label,inner){
  return `<div class="palette-command-group" role="group" aria-label="${esc(label)}"><span class="palette-group-name">${name}</span>${inner}</div>`;
}
function commandGroups(){
  const step=STEP();
  const region=REGION_PAGE();
  let html='';
  if(step==='Review'||step==='Typeset') html+=group('Images','Page images',cmd('copy-raw','clipboard','Copy raw image','Demo: copy the raw page image. Nothing is copied.')+cmd('copy-typeset','clipboard-check','Copy typeset image','Demo: copy the typeset page image. Nothing is copied.')+cmd('proofread-images','chat-square-quote','Proofread raw + typeset images','Demo: proofread the raw and typeset images together. No model is called.'));
  if(step==='Prepare'){
    html+=group('Page','Page',cmd('scene','card-text','Generate scene context (optional)','Demo: generate scene context for this page. No model is called.')+(state.tool==='reslice'?cmd('apply-reslice','scissors','Apply reslice cuts','Demo: apply reslice cuts. Artwork is unchanged.'):'')+cmd('delete-page','trash','Delete page','Demo: delete this page. No pages are removed.'));
    html+=group('Nudge','Nudge page',[['left','arrow-left'],['right','arrow-right'],['up','arrow-up'],['down','arrow-down']].map(([dir,ico])=>cmd('nudge-'+dir,ico,'Nudge '+dir,'')).join('')+`<label class="nudge-amount"><input type="number" min="1" data-nudge value="${state.nudgeAmount}" aria-label="Nudge pixels" title="Nudge pixels"></label>`);
  }
  if(step==='Translate'||step==='Review') html+=group('Translate','Translate',[
    cmd('transcribe-page','chat-square-text','Transcribe page','Demo: transcribe this page. No model is called.'),
    cmd('translate-page','translate','Translate page','Demo: translate this page. Existing edits would be kept. No model is called.'),
    cmd('review-translations','check2-square','Review translations','Demo: open translation review for this page.'),
    cmd('proofread-english','spellcheck','Proofread edited English','Demo: proofread the edited English. No model is called.'),
    cmd('reread','eye','Retry uncertain image reading','Demo: retry uncertain image reading. No model is called.'),
    cmd('fill-missing','plus-square','Fill missing source & English','Demo: fill missing source and English. Existing text would be left alone.'),
    cmd('scene','card-text','Refresh scene context','Demo: refresh scene context. No model is called.'),
    cmd('forget-history','journal-x','Clear saved history for this step','Demo: clear saved history for this step. Nothing is deleted.'),
  ].join(''));
  if(step==='Clean'){
    html+=group('Clean','Clean',[
      cmd('generate-mask','magic','Generate lettering mask','Demo: generate a lettering mask from the regions. Artwork is unchanged.'),
      cmd('approve-mask','check2','Approve mask','Demo: approve the mask.'),
      cmd('clear-strokes','x-lg','Clear draft strokes','Demo: clear draft strokes.'),
      cmd('apply-pass','floppy','Apply cleaning & start new mask','Demo: apply the cleaning pass and start a new mask. Artwork is unchanged.'),
      cmd('undo','arrow-counterclockwise','Undo saved edit (Ctrl+Z)','Demo: undo the saved edit.'),
      cmd('redo','arrow-clockwise','Redo (Ctrl+Shift+Z)','Demo: redo.'),
      cmd('approve-cleaned','check2-square','Approve cleaned page and go to next','Demo: approve the cleaned page and go to the next page.'),
      cmd('forget-history','journal-x','Clear saved history for this step','Demo: clear saved history for this step. Nothing is deleted.'),
    ].join(''));
    html+=group('Inpaint','Inpaint',INPAINT.map(([id,title,ico,color,message])=>cmd(id,ico,title,message,color)).join(''));
  }
  if(step==='Typeset') html+=group('Page','Page history',cmd('forget-history','journal-x','Clear saved history for this step','Demo: clear saved history for this step. Nothing is deleted.'));
  if(step==='Typeset'&&region) html+=group('Text','Text',[
    cmd('auto-fit','textarea-resize','Auto-fit','Demo: auto-fit this region. The layout is unchanged.'),
    cmd('lock','lock','Lock layout','Demo: lock this layout.'),
    cmd('knockout','front','Knock out overlapping regions','Demo: knock out overlapping regions. Artwork is unchanged.'),
    cmd('clear-text-mask','circle','Clear text mask','Demo: clear the text mask.'),
  ].join(''));
  if((step==='Clean'||step==='Typeset')&&region) html+=group('Geometry','Geometry',[
    cmd('rect-bounds','square','Set polygon to region bounds','Demo: set the polygon to the region bounds.'),
    cmd('fit-bubble','crosshair','Fit bubble (enclosed interior)','Demo: fit the bubble to the enclosed interior.'),
    cmd('sam','bounding-box-circles','Refine bubble with SAM points','Demo: refine the bubble with SAM. No model is called.'),
    state.tool==='polygon'?'':cmd('save-polygon','check2','Save polygon','Demo: a polygon needs at least three points. Artwork is unchanged.'),
    cmd('approve-geometry','check2-square','Approve geometry','Demo: approve geometry.'),
    cmd('undo-geometry','arrow-counterclockwise','Undo geometry','Demo: undo geometry.'),
    cmd('redo-geometry','arrow-clockwise','Redo','Demo: redo geometry.'),
  ].join(''));
  return html;
}
function paletteBlock(){
  return `<div class="tools-dock${state.paletteDocked?'':' tools-floating'}"><div class="palette${state.paletteDocked?' docked':''}" role="toolbar" aria-label="Tools" style="${state.paletteDocked?'':`left:${state.paletteX}px;top:${state.paletteY}px`}"><button class="handle" type="button" title="Drag to float Tools · double-click to pin as a panel" aria-label="Move Tools palette"><i class="bi bi-grip-horizontal" aria-hidden="true"></i><span>Tools</span></button><div class="palette-tools" role="group" aria-label="Canvas tools">${stepTools().map(palBtn).join('')}</div>${commandGroups()}${state.paletteDocked?'':`<button class="ed-rail-btn pin-palette" type="button" data-action="dock-palette" title="Pin as a panel between pages and the image" aria-label="Pin as a panel"><i class="bi bi-pin-angle" aria-hidden="true"></i></button>`}</div></div>`;
}
function popovers(){
  const step=STEP();
  let html='';
  if(!state.brushDismissed&&BRUSH_TOOLS.has(state.tool)&&(step==='Clean'||step==='Typeset')){
    html+=`<div class="brush-size-toolbar" role="toolbar" aria-label="Brush size"><span class="brush-size-label">Size</span>${BRUSH_PRESETS.map(size=>{const px=Math.max(3,Math.round(size/32*16));return `<button type="button" class="brush-preset" data-brush="${size}" title="Brush ${size}px" aria-label="Brush ${size} pixels" aria-pressed="${state.brushRadius===size}"><span class="brush-swatch" style="width:${px}px;height:${px}px"></span></button>`;}).join('')}<span class="brush-size-value">${state.brushRadius}px</span></div>`;
  }
  if(!state.growDismissed&&state.tool==='mask-grow'&&step==='Clean'){
    html+=`<div class="grow-amount-toolbar" role="toolbar" aria-label="Grow mask"><span class="grow-amount-label">Grow</span><input class="grow-amount-input" data-grow type="number" min="1" max="50" step="1" value="${state.growAmount}" aria-label="Grow mask by (px)" title="Pixels to expand the clicked mask section"><span class="grow-amount-unit">px</span></div>`;
  }
  return html;
}
function placePopovers(){
  const anchor=document.querySelector('.palette');
  if(!anchor) return;
  const rect=anchor.getBoundingClientRect();
  for(const el of document.querySelectorAll('.brush-size-toolbar,.grow-amount-toolbar')){
    const gap=8;
    const width=el.offsetWidth||220;
    let left=rect.right+gap;
    if(left+width>window.innerWidth-8) left=Math.max(8,rect.left-gap-width);
    let top=Math.max(8,Math.min(rect.top,window.innerHeight-el.offsetHeight-8));
    el.style.left=Math.round(left)+'px';
    el.style.top=Math.round(top)+'px';
  }
}
function canvasNote(){
  if(state.showEnglish) return `${icon('layout-split')} English reference fixture · not generated output`;
  if(state.tool!=='select') return `${icon('tools')} ${esc(TOOLS[state.tool][1])}`;
  const idle=state.page===9&&![0,5].includes(state.stage)?'Click a text region to work on it':'Choose page 09 to try the text-editing example';
  return `${icon(state.stage===3?'brush':'cursor')} ${idle}`;
}
function render(){
 const s=stages[state.stage];
 $('#app').innerHTML=`<div class="app">
  <header class="topbar"><div class="brand"><img src="../../src/lib/assets/komatose-logo.png" alt="Komatose" width="613" height="193"></div><span class="divider"></span><div class="breadcrumb"><span class="crumb-title">Give My Regards to Black Jack</span><span class="slash">/</span><strong>Chapter 01</strong></div><span class="badge">Workflow concept</span><div class="spacer"></div><span class="saved">${icon('check2-circle')} Demo edits stay in this session</span><button class="quiet" data-action="help">${icon('question-circle')}<span class="help-text">Quick guide</span></button><button class="quiet" data-action="settings">${icon('sliders2')} Settings</button></header>
  <nav class="steps" aria-label="Chapter workflow">${stages.map((step,i)=>`${i?'<span class="step-arrow">›</span>':''}<button class="step ${i===state.stage?'active':''} ${i<state.stage?'done':''}" data-stage="${i}" ${i===state.stage?'aria-current="step"':''}><span class="step-num">${i+1}</span><span><span class="step-title">${step[0]}</span><span class="step-sub">${step[1]}</span></span></button>`).join('')}</nav>
  <main class="workspace${state.paletteDocked?'':' palette-floating'}"><aside class="pages" aria-label="Chapter pages"><div class="pane-label">Pages <span class="count">10</span></div><select class="page-filter" aria-label="Filter pages" data-action="filter"><option value="all" ${state.filter==='all'?'selected':''}>All pages</option><option value="attention" ${state.filter==='attention'?'selected':''}>Needs attention</option></select><div class="thumbnails">${Array.from({length:10},(_,i)=>i+1).filter(n=>state.filter==='all'||[7,9,10].includes(n)).map(n=>`<button class="thumb ${n===state.page?'active':''}" data-page="${n}" aria-label="Open page ${n}" ${n===state.page?'aria-current="page"':''}><img src="${imagePath(n)}" alt="Page ${n} thumbnail" loading="lazy"><span class="thumb-meta">${String(n).padStart(2,'0')} ${[7,9,10].includes(n)?`<span class="issue" title="Needs review">${icon('circle-half')}</span>`:icon('check2')}</span></button>`).join('')}</div><div class="pages-bottom">10 pages · reading order</div></aside>
  ${paletteBlock()}
  <section class="editor" aria-label="Page canvas"><div class="canvas-toolbar"><strong class="page-name">Page ${String(state.page).padStart(2,'0')}</strong><div class="mobile-pages"><select data-action="mobile-page" aria-label="Current page">${Array.from({length:10},(_,i)=>`<option value="${i+1}" ${state.page===i+1?'selected':''}>Page ${i+1}</option>`).join('')}</select></div><span class="toolbar-rule"></span><div class="view-options"><button data-action="overlays" class="${state.overlays?'active':''}" aria-pressed="${state.overlays}">${icon('bounding-box')} <span class="tool-label">${state.stage===3?'Mask':'Text regions'}</span></button><button data-action="original" class="${state.showEnglish?'active':''}" aria-pressed="${state.showEnglish}">${icon('layout-split')}<span class="tool-label">${state.showEnglish?'English reference':'Compare'}</span></button></div><div class="spacer"></div><button data-action="zoom-out" aria-label="Zoom out">${icon('dash')}</button><button data-action="fit" title="Fit page">${state.zoom===100?'Fit':state.zoom+'%'}</button><button data-action="zoom-in" aria-label="Zoom in">${icon('plus')}</button></div><div class="artboard"><div class="paper ${state.overlays?'':'no-overlays'}" style="${state.zoom!==100?`height:${Math.round(540*state.zoom/100)}px;width:auto;`:''}"><img src="${imagePath(state.page,state.showEnglish)}" alt="${state.showEnglish?'English reference':'Original Japanese artwork'}, page ${state.page}">${state.page===9&&state.stage!==0&&state.stage!==5&&!state.showEnglish?regions.map((r,i)=>`<button class="region ${i===state.region?'selected':''} ${state.stage===3?'clean-mask':''}" data-region="${i}" aria-label="Select text region ${i+1}" aria-pressed="${i===state.region}" style="left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%"><span>${i+1}</span></button>`).join(''):''}</div><div class="canvas-caption">${canvasNote()}</div><div class="attribution">ブラックジャックによろしく<br>佐藤秀峰<br>Give My Regards to Black Jack<br>SHUHO SATO</div></div></section>
  <aside class="inspector" aria-label="${s[0]} controls"><div class="inspector-heading"><span class="eyebrow">Step ${state.stage+1} of 6 · ${s[0]}</span><h1>${s[2]}</h1><p class="muted">${s[3]}</p></div><div class="inspector-scroll">${panel()}</div><div class="inspector-footer"><div class="footer-progress"><span>${state.stage===2?`${state.approved.size} of 6 example lines approved`:`${s[0]} · chapter workflow`}</span><span>${state.stage+1} / 6</span></div><div class="progress"><span style="width:${(state.stage+1)/6*100}%"></span></div><button class="secondary wide" data-action="continue" ${state.stage===5?'disabled':''}>${state.stage===5?'Final step':`Continue to ${stages[state.stage+1][0]}`} ${icon('arrow-right')}</button></div></aside></main>
  <footer class="statusbar"><span>${icon('circle-half')} Interactive prototype</span><span class="desktop-only">Sample content · actions are simulated</span><div class="spacer"></div><button data-action="jobs">${icon('activity')} Activity</button><span class="desktop-only">Japanese → English</span><button data-action="help">${icon('keyboard')} Guide</button></footer></div>${popovers()}`;
 const thumb=$('.thumb.active');if(thumb)thumb.scrollIntoView({block:'nearest'});
 placePopovers();
}
function textEditor(review=false){
 if(state.page!==9)return `<div class="callout">The interactive text example is on page 09. Other pages are available to explore the navigation.</div><button class="secondary wide" data-page="9">Open page 09 ${icon('arrow-right')}</button>`;
 const r=draft(), approved=state.approved.has(state.region);
 return `<hr class="rule"><div class="section-heading"><span>Text region ${state.region+1} <span class="count">/ 6</span></span><div class="arrows"><button data-action="prev-region" aria-label="Previous text region" ${state.region===0?'disabled':''}>‹</button><button data-action="next-region" aria-label="Next text region" ${state.region===5?'disabled':''}>›</button></div></div><div style="margin-bottom:17px"><span class="tag ${approved?'good':''}">${icon(approved?'check2':'pencil')} ${approved?'Approved':'Draft · needs a human check'}</span></div>${field('Source text',`<textarea class="source" data-text="source" aria-label="Source text">${esc(r.source)}</textarea>`,'<span class="lang">JAPANESE</span>')}${field('Translation',`<textarea class="translation" data-text="en" aria-label="Translation">${esc(r.en)}</textarea>`,'<span class="lang">ENGLISH</span>')}<div class="editor-actions"><button data-action="suggest">${icon('stars')} Suggest wording</button><button data-action="source-review">${icon('chat-square-text')} Check source</button></div>${review?'<div class="callout">Approving confirms you have checked the meaning and the English. AI drafts are never approved automatically.</div>':''}<div class="save-next"><span class="muted">${review?'Human review': 'Draft saved as you type'}</span><button class="secondary small" data-action="${review?'approve':'save-next'}">${review?'Approve & next':'Next text region'} ${icon('arrow-right')}</button></div><details><summary>More text tools</summary><button class="secondary wide small" data-action="enquire">Ask about this line</button><p class="muted" style="margin-top:10px">Source comparisons, alternatives, and revisions stay attached to this text region.</p></details>`;
}
function panel(){
 if(state.stage===0)return `${scoped()}${primary('Add pages','upload','plus-lg')}<p class="engine-note">JPG, PNG, WebP or a ZIP of pages. Crop, split, and reslice are on the Tools palette.</p><h2 class="subheading">Chapter preparation</h2><div class="task-card">${icon('check-circle')}<div><strong>10 pages added</strong><small>Original artwork preserved</small></div></div><div class="task-card">${icon('check-circle')}<div><strong>Reading order</strong><small>${state.settings.direction} · ${state.settings.language}</small></div><button class="link-button" data-action="settings">Edit</button></div><button class="secondary wide" style="margin-top:18px" data-action="organize">${icon('grid')} Organize pages</button><details><summary>Advanced preparation</summary><button class="secondary wide small" data-action="reslice">Reslice long strips</button><button class="subtle-action" data-action="credits">Add series credits</button></details>`;
 if(state.stage===1)return `${state.translated.has(state.page)?'<div class="draft-ready">'+icon('check2-circle')+'<span>Draft ready <small>Check the wording below.</small></span></div>':''}<details class="draft-actions" ${!state.translated.has(state.page)||state.actionsOpen?'open':''}><summary>Page & chapter actions</summary>${scoped()}${primary(`Translate ${state.scope==='chapter'?'chapter':'page'}`,'translate','stars')}<p class="engine-note">${icon('cpu')} ${esc(state.settings.model)} <span>·</span> <button class="link-button" data-settings-tab="ai">Change in Settings</button></p><button class="secondary wide small" data-action="transcribe">${icon('scan')} Transcribe source text first</button></details>${textEditor()}`;
 if(state.stage===2)return `<div class="section-heading"><span>Review queue</span><span class="tag">${6-state.approved.size} to check</span></div><p class="muted">Work through the draft one line at a time.</p>${textEditor(true)}`;
 if(state.stage===3)return `${scoped()}<div class="section-heading"><span>1. Mark the original lettering</span></div>${primary('Detect lettering','detect','bounding-box')}<p class="engine-note">Brush, fill, clone, and the other mask tools are on the Tools palette.</p><label class="checkline"><input type="checkbox" data-action="mask-approved" ${state.maskApproved?'checked':''}> I checked the mask on this page</label><hr class="rule"><div class="section-heading">2. Remove the marked lettering</div>${field('Cleaning method',select('cleaner',['Automatic · recommended','Flat fill','LaMa','Clone / patch'],'Automatic · recommended'))}<button class="primary wide" data-action="clean" ${!state.maskApproved?'disabled':''}>${icon('eraser')} Clean page</button><p class="engine-note">${state.maskApproved?'The reviewed mask is ready.':'Check the mask before cleaning this page.'}</p>${state.cleaned?'<div class="callout">Demo cleaning pass complete. In the app, the cleaned artwork would appear here for comparison.</div>':''}<details><summary>Advanced cleaning</summary>${field('Mask expansion', '<input type="number" min="0" max="50" value="3" aria-label="Mask expansion in pixels">')}<p class="muted">Inpaint models and mask history are on the Tools palette.</p></details>`;
 if(state.stage===4)return `${scoped()}${primary(`Fit text to ${state.scope==='chapter'?'chapter':'page'}`,'fit-text','textarea-t')}<p class="engine-note">Uses approved English and your chapter type style.</p><hr class="rule"><div class="section-heading">Selected text · region ${state.region+1}</div>${field('Lettering style',select('font',['Comic lettering','Narration','Sound effect'],state.settings.font))}<div class="two-col">${field('Size (pt)',`<input type="number" data-setting="size" value="${esc(state.settings.size)}" min="8" max="72">`)}${field('Alignment',select('alignment',['Centered','Left','Right'],'Centered'))}</div>${field('English line breaks',`<textarea data-text="en" aria-label="English line breaks">${esc(draft().en)}</textarea>`)}<div class="callout">Editing here affects only the selected text. Change shared styles in <button class="link-button" data-settings-tab="type">Settings → Lettering</button>.</div><details><summary>Advanced text styling</summary>${field('Line spacing', '<input type="number" value="1.1" step="0.1" aria-label="Line spacing">')}${field('Rotation (degrees)', '<input type="number" value="0" aria-label="Rotation">')}<label class="checkline"><input type="checkbox">Lock this layout during auto-fit</label></details>`;
 return `${state.exported?'<div class="complete-state">'+icon('check-circle')+'<h2>Export preview complete</h2><p class="muted">This is a simulated export. No production files were generated.</p></div>':''}<span class="eyebrow">Whole chapter · 10 pages</span><div style="margin-top:14px"><div class="task-card">${icon('check-circle')}<div><strong>Pages are in order</strong><small>10 original pages</small></div></div><div class="task-card">${icon(state.approved.size===6?'check-circle':'circle-half')}<div><strong>${6-state.approved.size} example lines need review</strong><small>Finish checking before publishing</small></div><button class="link-button" data-stage="2">Review</button></div></div><hr class="rule">${field('File format',select('format',['PNG images · ZIP','JPEG images · ZIP','Layered PSD'], 'PNG images · ZIP'))}${field('File name','<input value="black-jack-chapter-01" aria-label="Export file name">')}<label class="checkline"><input type="checkbox" checked>Include series credits</label>${primary('Preview export','export','download')}<p class="engine-note">Demo only · no files are uploaded or published</p><details><summary>Advanced export options</summary><label class="checkline"><input type="checkbox">Include translation metadata</label></details>`;
}
function openDialog(html){const dialog=$('#dialog');dialog.innerHTML=html;if(!dialog.open)dialog.showModal();}
function modalHeader(title,sub=''){return `<div class="modal-head"><div><h2>${title}</h2>${sub?`<p class="muted">${sub}</p>`:''}</div><button class="close" data-action="close" aria-label="Close dialog">${icon('x-lg')}</button></div>`;}
function showSettings(tab=state.settingsTab){state.settingsTab=tab;const tabs=[['chapter','Chapter defaults'],['ai','AI & translation'],['glossary','Series glossary'],['type','Lettering'],['view','Appearance']];
 let content='';
 if(tab==='chapter')content=`<h3>Chapter defaults</h3><p class="muted">Applies to Chapter 01. Existing text edits are kept.</p><hr class="rule">${field('Source language',select('language',['Japanese','Korean','Chinese'],state.settings.language))}${field('Reading direction',select('direction',['Right to left','Left to right'],state.settings.direction))}<div class="callout">These settings describe the chapter. Crop, split, and reslice live on the Tools palette in Prepare.</div>`;
 if(tab==='ai')content=`<h3>AI & translation</h3><p class="muted">Choose chapter defaults once. Running a task is always an explicit action in the workflow.</p><hr class="rule">${field('Translation model',select('model',['Chapter default','Local translator','Configured cloud model'],state.settings.model))}${field('Source reading',select('ocr',['Compare two OCR readers','Primary OCR reader'],'Compare two OCR readers'))}${field('Translation preferences','<textarea placeholder="For example: natural English; keep honorifics." data-setting="preferences">'+esc(state.settings.preferences||'Natural English. Preserve the medical terminology.')+'</textarea>')}<details><summary>Models for other tasks</summary>${field('Description',select('description',['Chapter default','Configured vision model'],'Chapter default'))}${field('Proofreading',select('proofread',['Chapter default','Configured text model'],'Chapter default'))}</details>`;
 if(tab==='glossary')content=`<h3>Series glossary</h3><p class="muted">Shared across every chapter in this series.</p><hr class="rule">${field('Names & terminology',`<textarea data-setting="term" style="min-height:160px">${esc(state.settings.term)}</textarea>`)}<div class="callout">Keep names and recurring terms consistent. Each entry uses source → preferred English.</div>`;
 if(tab==='type')content=`<h3>Lettering defaults</h3><p class="muted">Chapter style. Individual text can override it in Typeset.</p><hr class="rule">${field('Default style',select('defaultFont',['Comic lettering','Narration','Sound effect'],state.settings.defaultFont||'Comic lettering'))}${field('Default size (pt)',`<input type="number" data-setting="defaultSize" value="${esc(state.settings.defaultSize||'12')}" min="8" max="72">`)}<div class="callout">The production version would show inherited series styles here, with an explicit chapter override.</div>`;
 if(tab==='view')content=`<h3>Your workspace</h3><p class="muted">Display preferences affect your view, not the artwork.</p><hr class="rule"><label class="checkline"><input type="checkbox" data-action="settings-overlays" ${state.overlays?'checked':''}>Show text region outlines</label><div class="callout">Canvas view controls also provide a quick outline toggle while you work.</div>`;
 openDialog(`${modalHeader('Settings','One home for defaults. Tools stay with their workflow step.')}<div class="modal-body"><nav class="modal-nav" aria-label="Settings categories">${tabs.map(([id,label])=>`<button data-settings-tab="${id}" class="${id===tab?'active':''}" ${id===tab?'aria-current="page"':''}>${label}</button>`).join('')}</nav><div class="modal-content">${content}</div></div><div class="modal-footer"><span class="muted">Changes apply to this demo session only.</span><button class="primary" data-action="close">Done ${icon('check2')}</button></div>`);
}
function simpleModal(title,body){openDialog(`${modalHeader(title)}<div class="help-content">${body}</div><div class="modal-footer"><span class="muted">Interactive workflow concept</span><button class="primary" data-action="close">Got it</button></div>`);}
function guide(){simpleModal('A place for everything',[
 ['Choose your step','Follow Prepare → Translate → Review → Clean → Typeset → Export. You can return to any step.'],
 ['Choose your page','The left side is just pages. Click page 09, then click an outlined text region on the artwork.'],
 ['Work beside the page','The Tools palette sits between the pages and the artwork. It changes with the step. Drag the grip to float it, and double-click the grip to pin it back.'],
 ['Set defaults once','Settings holds languages, models, terminology, and shared lettering styles. Advanced tools are tucked into their relevant step.'],
 ].map(([t,b],i)=>`<div class="help-item"><span>${i+1}</span><div><strong>${t}</strong><p>${b}</p></div></div>`).join(''));}
function setStage(n){state.stage=n;state.scope='page';state.tool='select';state.brushDismissed=false;state.growDismissed=false;render();}
function chooseTool(id){
  if(id==='style-brush'&&state.tool==='style-brush') id='select';
  else if(id==='zoom'&&state.tool==='zoom') id='select';
  state.tool=id;
  state.brushDismissed=false;
  state.growDismissed=false;
  render();
  toast(TOOLS[id][2]);
}
document.addEventListener('click',e=>{
 const el=e.target.closest('button');if(!el||el.disabled)return;
 if(el.dataset.stage!==undefined){setStage(+el.dataset.stage);return;}
 if(el.dataset.page){state.page=+el.dataset.page;state.region=0;render();return;}
 if(el.dataset.region){state.region=+el.dataset.region;render();return;}
 if(el.dataset.palette){chooseTool(el.dataset.palette);return;}
 if(el.dataset.brush){state.brushRadius=+el.dataset.brush;state.brushDismissed=false;render();return;}
 if(el.dataset.command){const id=el.dataset.command;toast(id.startsWith('nudge-')?`Demo: nudge ${id.slice(6)} by ${state.nudgeAmount}px. Artwork is unchanged.`:el.dataset.toast);return;}
 if(el.dataset.settingsTab){showSettings(el.dataset.settingsTab);return;}
 const action=el.dataset.action;
 if(action==='dock-palette'){state.paletteDocked=true;render();}
 else if(action==='settings')showSettings();
 else if(action==='close'){$('#dialog').close();render();}
 else if(action==='help')guide();
 else if(action==='continue')setStage(Math.min(5,state.stage+1));
 else if(action==='overlays'){state.overlays=!state.overlays;render();}
 else if(action==='original'){state.showEnglish=!state.showEnglish;render();}
 else if(action==='zoom-in'||action==='zoom-out'||action==='fit'){state.zoom=action==='fit'?100:Math.max(50,Math.min(200,state.zoom+(action==='zoom-in'?25:-25)));render();}
 else if(['next-region','prev-region','save-next','approve'].includes(action)){if(action==='approve'){state.approved.add(state.region);toast('Example line approved.');}state.region=Math.max(0,Math.min(5,state.region+(action==='prev-region'?-1:1)));render();}
 else if(action==='translate'){state.translated.add(state.page);state.actionsOpen=false;render();toast(`Demo: translation drafted for ${scopeLabel()}. Existing edits are preserved.`);}
 else if(action==='transcribe')toast(`Demo: source text detected and transcribed for ${scopeLabel()}.`);
 else if(action==='detect'){state.overlays=true;state.maskApproved=false;render();toast(`Demo mask shown for ${scopeLabel()}. Inspect it before cleaning.`);}
 else if(action==='clean'){state.cleaned=true;render();toast('Demo cleaning completed. Artwork is unchanged in this prototype.');}
 else if(action==='fit-text')toast(`Demo: auto-fit requested for ${scopeLabel()}. Artwork is unchanged.`);
 else if(action==='export'){state.exported=true;render();toast('Export preview complete. This prototype does not create a ZIP.');}
 else if(action==='suggest'){simpleModal('Wording suggestion',`<p class="muted">Example alternative for this text region. Accepting it updates the demo draft.</p><div class="callout">${state.region===0?'A medical intern is essentially an apprentice.':esc(draft().en)}</div><button class="primary" data-action="accept-suggestion">Use this wording</button>`);}
 else if(action==='accept-suggestion'){if(state.region===0)draft().en='A medical intern is essentially an apprentice.';state.approved.delete(state.region);$('#dialog').close();render();toast('Wording saved as a draft.');}
 else if(action==='source-review'||action==='enquire')simpleModal(action==='source-review'?'Check the source':'Ask about this line',`<p class="muted">The production dialog would keep the crop, original reading, and model suggestions together.</p>${field('Current source',`<textarea readonly>${esc(draft().source)}</textarea>`)}<div class="callout">This prototype makes no model calls. Suggested changes would require your explicit acceptance.</div>`);
 else if(action==='jobs')simpleModal('Activity',`<div class="task-card">${icon('check-circle')}<div><strong>Workflow concept loaded</strong><small>Sample chapter · 10 pages</small></div></div><p class="muted">Running tasks, completed downloads, and retry actions will live here. No background jobs are running in this demo.</p>`);
 else if(action==='organize')simpleModal('Organize pages',`<p class="muted">Page organization belongs in Prepare. The production view would provide reorder, select, and extract actions together.</p><div class="callout">Current reading direction: ${state.settings.direction}. 10 sample pages are loaded.</div>`);
 else if(action==='upload')simpleModal('Add pages',`<p class="muted">The production upload flow would accept images or a ZIP and return you to Prepare with the new pages selected.</p><div class="callout">This mockup uses 10 bundled sample pages. No upload or network request is made.</div>`);
 else if(action==='reslice'||action==='credits')toast(`Demo: ${action==='reslice'?'Reslice strips':'Series credits'} opens from Prepare.`);
});
document.addEventListener('change',e=>{const el=e.target;
 if(el.dataset.action==='scope'){state.scope=el.value;state.actionsOpen=true;render();}
 if(el.dataset.action==='filter'){state.filter=el.value;render();}
 if(el.dataset.action==='mobile-page'){state.page=+el.value;state.region=0;render();}
 if(el.dataset.action==='mask-approved'){state.maskApproved=el.checked;render();}
 if(el.dataset.action==='settings-overlays'){state.overlays=el.checked;render();}
 if(el.dataset.setting)state.settings[el.dataset.setting]=el.value;
});
document.addEventListener('input',e=>{
  if(e.target.dataset.text){draft()[e.target.dataset.text]=e.target.value;state.approved.delete(state.region);}
  if(e.target.dataset.setting)state.settings[e.target.dataset.setting]=e.target.value;
  if(e.target.dataset.nudge){const n=Math.round(Number(e.target.value));if(Number.isFinite(n)&&n>=1)state.nudgeAmount=n;}
  if(e.target.dataset.grow){const n=Math.round(Number(e.target.value));if(Number.isFinite(n))state.growAmount=Math.min(50,Math.max(1,n));}
});
let paletteDrag=null;
function clampPalette(x,y,palette){
  return {
    x:Math.max(8,Math.min(x,window.innerWidth-(palette?.offsetWidth??78)-8)),
    y:Math.max(8,Math.min(y,window.innerHeight-Math.min(palette?.offsetHeight??80,window.innerHeight-16)-8)),
  };
}
document.addEventListener('pointerdown',e=>{
  const handle=e.target.closest?.('.palette .handle');
  if(handle&&e.button===0){
    e.preventDefault();
    const palette=handle.closest('.palette');
    const rect=palette.getBoundingClientRect();
    if(state.paletteDocked){
      state.paletteDocked=false;
      state.paletteX=rect.left;
      state.paletteY=rect.top;
      document.querySelector('.workspace')?.classList.add('palette-floating');
      document.querySelector('.tools-dock')?.classList.add('tools-floating');
      palette.classList.remove('docked');
      palette.style.left=rect.left+'px';
      palette.style.top=rect.top+'px';
      if(!palette.querySelector('.pin-palette')) palette.insertAdjacentHTML('beforeend','<button class="ed-rail-btn pin-palette" type="button" data-action="dock-palette" title="Pin as a panel between pages and the image" aria-label="Pin as a panel"><i class="bi bi-pin-angle" aria-hidden="true"></i></button>');
    }
    palette.classList.add('dragging');
    paletteDrag={dx:e.clientX-rect.left,dy:e.clientY-rect.top,palette};
    handle.setPointerCapture?.(e.pointerId);
    return;
  }
  if(e.target.closest('.brush-size-toolbar,.grow-amount-toolbar,.palette')) return;
  const hideBrush=!state.brushDismissed&&BRUSH_TOOLS.has(state.tool);
  const hideGrow=!state.growDismissed&&state.tool==='mask-grow';
  if(!hideBrush&&!hideGrow) return;
  state.brushDismissed=true;
  state.growDismissed=true;
  if(!e.target.closest('button,a,select,summary,input,textarea,label')){
    document.querySelector('.brush-size-toolbar')?.remove();
    document.querySelector('.grow-amount-toolbar')?.remove();
  }
});
document.addEventListener('pointermove',e=>{
  if(!paletteDrag) return;
  const next=clampPalette(e.clientX-paletteDrag.dx,e.clientY-paletteDrag.dy,paletteDrag.palette);
  state.paletteX=next.x;state.paletteY=next.y;
  paletteDrag.palette.style.left=next.x+'px';
  paletteDrag.palette.style.top=next.y+'px';
  placePopovers();
});
document.addEventListener('pointerup',()=>{
  if(!paletteDrag) return;
  paletteDrag.palette.classList.remove('dragging');
  paletteDrag=null;
});
document.addEventListener('dblclick',e=>{
  if(!e.target.closest('.palette .handle')) return;
  state.paletteDocked=true;
  render();
});
window.addEventListener('resize',()=>{
  if(!state.paletteDocked){
    const palette=document.querySelector('.palette');
    const next=clampPalette(state.paletteX,state.paletteY,palette);
    state.paletteX=next.x;state.paletteY=next.y;
    if(palette){palette.style.left=next.x+'px';palette.style.top=next.y+'px';}
  }
  placePopovers();
});
$('#dialog').addEventListener('click',e=>{if(e.target===$('#dialog')){$('#dialog').close();render();}});
$('#dialog').addEventListener('close',()=>render());
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&state.tool==='style-brush'&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){state.tool='select';render();return;}
  if(e.key==='?'&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)&&!$('#dialog').open)guide();
});
render();

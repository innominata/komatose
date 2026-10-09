/** Korean d1 calibration. Saved approval is not ground truth; private crops stay in scratch. */
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { inferenceTokenFromPort, readSavedToken } from '../src/lib/server/residentInference';
const data = process.env.SCAN_DATA_DIR || join(process.cwd(), 'data');
const runtime = process.env.SCAN_DECIDER_RUNTIME_DIR || join(data, 'runtimes/llama-decider');
const models = join(process.env.SCAN_DECIDER_MODELS_DIR || join(data, 'models/deciders'), 'd1-3b');
const scratch = await mkdtemp(join(tmpdir(), 'komatose-d1-korean-eval-'));
process.env.SCAN_DATA_DIR = scratch;
process.env.DATABASE_URL = join(scratch, 'smoke.db');
const socket = createServer();
await new Promise<void>(r => socket.listen(0, '127.0.0.1', r));
const port = (socket.address() as { port: number }).port;
await new Promise<void>(r => socket.close(() => r()));
const device = process.argv[2] || 'Vulkan2';
const cpu = device === 'CPU';
const env = { ...process.env, GGML_VK_ALLOW_GRAPHICS_QUEUE: '1', GGML_VK_DISABLE_FUSION: '1', MTMD_BACKEND_DEVICE: device, LD_LIBRARY_PATH: `${join(runtime, 'build/bin')}:${process.env.LD_LIBRARY_PATH || ''}` };
for (const key of Object.keys(env)) if (key.startsWith('LLAMA_ARG_')) delete (env as Record<string, string | undefined>)[key];
if (cpu) delete (env as Record<string, string | undefined>).MTMD_BACKEND_DEVICE;
const child = spawn(join(runtime, 'build/bin/llama-server'), ['-m', join(models, 'd1-3B-Q8_0.gguf'),
  '--mmproj', join(models, 'mmproj-d1-3B-F16.gguf'), '-a', 'd1-3b', '--host', '127.0.0.1', '--port', String(port),
  '--device', cpu ? 'none' : device, '-ngl', cpu ? '0' : '999', '-c', '8192', '-np', '1', '--log-verbose', ...(cpu ? ['--no-mmproj-offload'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
let spawnError: Error | undefined;
child.on('error', error => { spawnError = error; });
try {
  const startupStarted = performance.now();
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const deadline = Date.now() + 300_000;
  while (true) {
    if (spawnError) throw spawnError;
    if (child.exitCode != null) throw new Error(`Server exited ${child.exitCode}: ${logs.slice(-5000)}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`Server did not become ready: ${logs.slice(-5000)}`);
    await new Promise(r => setTimeout(r, 250));
  }


  const startupMs = performance.now() - startupStarted;
  const results: any[] = [];
  const samples: any[] = [];
  const phrases = ['안녕하세요', '기다려 주세요', '정말 괜찮아요?', '다시 만나요', '고마워요', '어디 가세요?', '지금 뭐 해요?', '문을 열어 주세요', '조금만 기다려', '괜찮습니다', '누구세요?', '빨리 와요',
    '조심하세요', '왜 그러세요?', '잘 모르겠어요', '나중에 봐요', '이리 와 봐요', '처음 뵙겠습니다', '어서 오세요', '믿을 수 없어', '도와주세요', '집에 가고 싶어요', '잠깐만요!', '무슨 일이에요?'];
  const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const variants = ['sans', 'serif', 'inverted', 'blur', 'clutter', 'outline', 'low-contrast', 'clipped'];
  for (const [i, text] of phrases.entries()) {
    // Every phrase has a clean control; other conditions rotate, without reusing held-out phrases in training.
    for (const variant of ['sans', variants[1 + (i % 7)]]) {
      const bg = variant === 'inverted' ? 'black' : 'white';
      const fg = variant === 'inverted' ? 'white' : variant === 'low-contrast' ? '#cccccc' : 'black';
      const width = 720, height = 220;
      const font = variant === 'serif' ? 'Noto Serif CJK KR' : 'Noto Sans CJK KR';
      const extra = variant === 'clutter' ? '<path d="M0 110 L720 110 M0 60 L720 170 M0 160 L720 40" stroke="black" stroke-width="10"/><path d="M0 30 Q250 200 720 10" fill="none" stroke="black" stroke-width="8"/>' : '';
      const lettering = variant === 'outline' ? 'fill="white" stroke="black" stroke-width="2"' : `fill="${fg}"`;
      let jpeg = await sharp(Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${bg}"/><text x="360" y="140" text-anchor="middle" font-family="${font}" font-size="55" ${lettering}>${xml(text)}</text>${extra}</svg>`)).png().toBuffer();
      if (variant === 'blur') jpeg = await sharp(jpeg).blur(3.5).png().toBuffer();
      if (variant === 'clipped') jpeg = await sharp(jpeg).extract({ left: 310, top: 0, width: 410, height }).png().toBuffer();
      jpeg = await sharp(jpeg).jpeg({ quality: 90 }).toBuffer();
      const id = `synthetic-${i}-${variant}`;
      const path = join(scratch, `${id}.jpg`); await writeFile(path, jpeg);
      samples.push({ id, text, variant, split: i < 12 ? 'train' : 'heldout', jpeg, path,
        labels: { easy: ['sans', 'serif', 'inverted'].includes(variant), blackWhite: ['sans', 'serif', 'clipped', 'blur', 'clutter'].includes(variant),
          clean: variant !== 'clutter', regular: variant !== 'outline', legible: !['blur', 'clipped', 'low-contrast'].includes(variant) } });
    }
  }
  const privateManifest = process.argv.find(arg => arg.startsWith('--approved='))?.slice('--approved='.length);
  const reviewPath = process.argv.find(arg => arg.startsWith('--independent-review='))?.slice('--independent-review='.length);
  const reviews: any[] = reviewPath ? JSON.parse(await readFile(reviewPath, 'utf8')) : [];
  if (privateManifest) {
    for (const [i, row] of JSON.parse(await readFile(privateManifest, 'utf8')).entries()) {
      const raw = await readFile(join(data, 'images', row.series_slug, row.episode_slug, row.filename));
      const meta = await sharp(raw).metadata(); const width = meta.width!, height = meta.height!;
      const left = Math.max(0, Math.floor(row.x * width)), top = Math.max(0, Math.floor(row.y * height));
      const jpeg = await sharp(raw).extract({ left, top, width: Math.min(width-left, Math.ceil(row.w*width)), height: Math.min(height-top, Math.ceil(row.h*height)) }).jpeg({ quality: 95 }).toBuffer();
      const id = `approved-${i}`, path = join(scratch, `${id}.jpg`); await writeFile(path, jpeg);
      const review = reviews.find(r => r.id === id && r.status === 'independently-reviewed' && r.visualConfidence === 'high');
      samples.push({ id, text: row.source.trim(), groundTruth: review?.independentReading,
        variant: 'real', split: review ? 'real-heldout' : 'real-unverified', jpeg, path });
    }
  }
  const reusePath = process.argv.find(arg => arg.startsWith('--reuse='))?.slice('--reuse='.length);
  if (reusePath) {
    samples.length = 0;
    const previous = JSON.parse(await readFile(reusePath, 'utf8'));
    for (const row of previous.results) samples.push({ ...row,
      text: row.source, jpeg: await readFile(join(reusePath.replace(/\/[^/]+$/, ''), `${row.id}.jpg`)) });
  }
  const stress = process.argv.includes('--stress');
  if (stress) samples.splice(0, samples.length, ...samples.filter(s => s.variant === 'sans'));
  const nativeBinary = process.argv.includes('--native-binary');
  const request = async (jpeg: Buffer, questions: any, state: any = null) => {
    const started = performance.now();
    const response = await fetch(`${baseUrl}/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ state, images: [`data:image/jpeg;base64,${jpeg.toString('base64')}`], questions }) });
    const payload = await response.json();
    if (!response.ok || !payload.answers) throw new Error(JSON.stringify(payload));
    const answers = Object.fromEntries(Object.entries(payload.answers).map(([key, raw]: [string, any]) => {
      if (raw.type !== 'noul') return [key, raw];
      if (typeof raw.noul !== 'number' || !Number.isFinite(raw.noul) || raw.noul < 0 || raw.noul > 1)
        throw new Error('Invalid native yes/no probability');
      return [key, { ...raw, choice: raw.noul >= .5 ? 'yes' : 'no', probabilities: {yes: raw.noul, no: 1-raw.noul} }];
    }));
    return { answers, ms: performance.now() - started, usage: payload.usage };
  };
  const binary = (instructions: string) => nativeBinary ? { type: 'noul', instructions }
    : { type: 'choice', instructions, criteria: { yes: 'Yes', no: 'No' } };
  const qualityQuestions = {
    easy: binary('Is the text crop clean, fully legible, and printed in regular unornamented lettering, suitable for trying ordinary local OCR first? Answer no for stylized or damaged letters, clutter crossing text, low contrast, blur, or cut-off characters.'),
    blackWhite: binary('Are the letters mostly solid black on a plain white background?'),
    clean: binary('Is the text area free of distracting artwork, speckles or lines touching or crossing the lettering?'),
    regular: binary('Is the lettering a regular printed font rather than hollow outline, decorative, distorted, or hand-drawn lettering?'),
    legible: binary('Are all characters fully visible and sharply legible, without blur, low contrast, or clipping?'),
  };
  const mutation = (text: string) => {
    const chars = [...text]; const index = chars.findIndex(c => /[가-힣]/.test(c));
    if (index < 0) return text + '가';
    const code = chars[index].charCodeAt(0)-0xac00, tail=code%28;
    chars[index] = String.fromCharCode(0xac00 + code - tail + (tail === 0 ? 4 : 0));
    return chars.join('');
  };
  const localOcrUrl = process.argv.find(arg => arg.startsWith('--ocr='))?.slice('--ocr='.length);
  const localEndpoint = localOcrUrl ? new URL(localOcrUrl) : undefined;
  if (localEndpoint && !['127.0.0.1', 'localhost', '[::1]'].includes(localEndpoint.hostname))
    throw new Error('Calibration OCR must use a local endpoint; private crops must not leave this machine');
  const localToken = localEndpoint ? inferenceTokenFromPort(Number(localEndpoint.port)) || readSavedToken('paddleocr-vl-1.6') : '';
  const comparable = (s: string) => s.normalize('NFC').replace(/\s/g,'').trim();
  for (const [i, sample] of samples.entries()) {
    const quality = await request(sample.jpeg, qualityQuestions);
    let local: any = sample.local;
    if (localOcrUrl && (sample.variant === 'real' || sample.variant === 'sans')) {
      const started = performance.now();
      try {
        const response = await fetch(`${localOcrUrl}/v1/chat/completions`, { method:'POST', headers:{'content-type':'application/json',...(localToken ? {authorization:`Bearer ${localToken}`} : {})}, signal:AbortSignal.timeout(45_000),
          body:JSON.stringify({model:'paddleocr-vl-1.6',temperature:0,top_k:1,max_tokens:1024,messages:[{role:'user',content:[{type:'image_url',image_url:{url:`data:image/jpeg;base64,${sample.jpeg.toString('base64')}`}},{type:'text',text:'OCR:\nOCR language: Korean'}]}]}) });
        const payload = await response.json(); if(!response.ok) throw new Error(`Local OCR HTTP ${response.status}`);
        const source=payload.choices?.[0]?.message?.content?.trim(); if(typeof source!=='string') throw new Error('Local OCR returned no text');
        local={source,correct:sample.split === 'real-unverified' ? undefined : comparable(source)===comparable(sample.groundTruth ?? sample.text),ms:performance.now()-started};
      } catch(e) {local={error:String(e),ms:performance.now()-started};}
    }
    const wrong = mutation(sample.text);
    const candidates = i % 2 ? { A: wrong, B: sample.text } : { A: sample.text, B: wrong };
    const correctId = Object.keys(candidates).find(id => candidates[id as 'A'|'B'] === sample.text)!;
    const choiceQuestions:any = {
      native: {type:'choice',instructions:'Which candidate exactly matches the original lettering visible in this crop? Judge the glyphs, not which wording sounds most natural. Choose none if every candidate is wrong, or unclear if the image cannot support a reliable choice.',criteria:{...candidates,none:'None of these candidates exactly matches the visible lettering.',unclear:'The lettering is too unclear to choose a reliable reading.'}},
      balanced: {type:'choice',instructions:'Which description is true of the visible text?',criteria:{ A:`The visible text reads: ${candidates.A}`,B:`The visible text reads: ${candidates.B}`,none:'The visible text matches neither candidate.',unclear:'The visible text is not legible enough to transcribe.'}},
      pair: {type:'choice',instructions:'Which transcription matches the text visible in the image?',criteria:candidates},
      verifyCorrect:binary(`Does the text in the image exactly read: ${sample.groundTruth ?? sample.text}? Judge the actual visible characters.`),
      verifyWrong:binary(`Does the text in the image exactly read: ${wrong}? Judge the actual visible characters.`),
      balancedReverse: {type:'choice',instructions:'Which description is true of the visible text?',criteria:{ B:`The visible text reads: ${candidates.A}`,A:`The visible text reads: ${candidates.B}`,none:'The visible text matches neither candidate.',unclear:'The visible text is not legible enough to transcribe.'}},
      absent: {type:'choice',instructions:'Which description is true of the visible text?',criteria:{ A:`The visible text reads: ${wrong}`,B:`The visible text reads: ${sample.text}가`,none:'The visible text matches neither candidate.',unclear:'The visible text is not legible enough to transcribe.'}},
    };
    if (local?.source) choiceQuestions.verifyLocal=binary(`Does the text in the image exactly read: ${local.source}? Judge the actual visible characters.`);
    if (stress) {
      const chars=[...sample.text]; const positions=chars.map((c,i)=>/[가-힣]/.test(c)?i:-1).filter(i=>i>=0);
      const mutations=new Set<string>();
      for(const index of new Set([positions[0],positions[Math.floor(positions.length/2)],positions.at(-1)])) {
        if(index==null) continue;
        const n=chars[index].charCodeAt(0)-0xac00, tail=n%28, vowel=Math.floor(n/28)%21, onset=Math.floor(n/588);
        for(const code of [((onset+1)%19)*588+vowel*28+tail,onset*588+((vowel+1)%21)*28+tail,onset*588+vowel*28+(tail+1)%28]) {
          const changed=[...chars];changed[index]=String.fromCharCode(0xac00+code);mutations.add(changed.join(''));
        }
      }
      mutations.add(chars.slice(1).join(''));mutations.add(chars.slice(0,-1).join(''));mutations.add(`${sample.text}가`);
      for(const [j,wrongText] of [...mutations].entries()) choiceQuestions[`stressWrong${j}`]=binary(`Does the text in the image exactly read: ${wrongText}? Judge the actual visible characters.`);
    }
    const reading = await request(sample.jpeg,choiceQuestions,{language:'korean'});
    const answers=Object.fromEntries(Object.entries(reading.answers).map(([key,a]:[string,any])=>[key,{...a,correct:key==='verifyCorrect'?a.choice==='yes':key==='verifyWrong'||key.startsWith('stressWrong')?a.choice==='no':key==='absent'?['none','unclear'].includes(a.choice):key==='balancedReverse'?a.choice!==(correctId)&&['A','B'].includes(a.choice):key==='verifyLocal'?undefined:a.choice===correctId}]));
    if (sample.variant === 'real') {
      for (const method of ['native', 'balanced', 'pair']) {
        const chosen = candidates[answers[method].choice as 'A'|'B'];
        answers[method].correct = sample.groundTruth == null ? undefined : chosen != null && comparable(chosen) === comparable(sample.groundTruth);
      }
    }
    const record={id:sample.id,split:sample.split,variant:sample.variant,source:sample.text,groundTruth:sample.groundTruth,labels:sample.labels,quality,reading:{...reading,answers},local,correctId};
    results.push(record);
    await writeFile(join(scratch,'results.json'),JSON.stringify({device,nativeBinary,startupMs,results},null,2));
    // Real transcripts and crops stay private in scratch, never stdout or the repository.
    console.log(JSON.stringify({id:sample.id,qualityMs:Math.round(quality.ms),readingMs:Math.round(reading.ms),easy:quality.answers.easy.probabilities.yes,pairCorrect:answers.pair.correct,localCorrect:local?.correct}));
  }
  const warmedTimes:number[]=[];
  for(let i=0;i<30;i++) warmedTimes.push((await request(samples[0].jpeg,{easy:qualityQuestions.easy})).ms);
  const thresholds=[.5,.55,.6,.65,.7,.75,.8,.85,.9,.95,.98];
  const summary:any={startupMs,samples:samples.length,latency:{}};
  const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*p)];
  for(const key of ['quality','reading']){const times=results.map(r=>r[key].ms);summary.latency[key]={median:percentile(times,.5),p95:percentile(times,.95),min:Math.min(...times),max:Math.max(...times)};}
  summary.latency.singleQuestion={median:percentile(warmedTimes,.5),p95:percentile(warmedTimes,.95),samples:warmedTimes.length};
  summary.thresholds={};
  summary.verification={};
  for(const split of ['train','heldout','real-heldout']) {
    const group=results.filter(r=>r.split===split);
    summary.thresholds[split]={};
    for(const method of ['native','balanced','pair']) summary.thresholds[split][method]=thresholds.map(threshold=>{
      const accepted=group.filter(r=>['A','B'].includes(r.reading.answers[method].choice)&&r.reading.answers[method].probabilities[r.reading.answers[method].choice]>=threshold);
      return {threshold,accepted:accepted.length,correct:accepted.filter(r=>r.reading.answers[method].correct).length,errors:accepted.filter(r=>!r.reading.answers[method].correct).length};
    });
    summary.thresholds[split].quality=thresholds.map(threshold=>{const accepted=group.filter(r=>r.quality.answers.easy.probabilities.yes>=threshold);return{threshold,accepted:accepted.length,knownHardAccepted:accepted.filter(r=>r.labels?.easy===false).length,localOcrTested:accepted.filter(r=>typeof r.local?.correct === 'boolean').length,localOcrErrors:accepted.filter(r=>r.local?.correct === false).length,localOcrRequestErrors:accepted.filter(r=>r.local?.error).length};});
    const readable=group.filter(r=>r.variant==='sans' || r.split==='real-heldout');
    const wrongScores=readable.flatMap(r=>Object.entries(r.reading.answers).filter(([key])=>key==='verifyWrong'||key.startsWith('stressWrong')).map(([,a]:[string,any])=>a.probabilities.yes));
    summary.verification[split]={correctSamples:readable.length,wrongSamples:wrongScores.length,
      maxWrongProbability:wrongScores.length ? Math.max(...wrongScores) : null,
      thresholds:thresholds.map(threshold=>({threshold,
        correctAccepted:readable.filter(r=>r.reading.answers.verifyCorrect.probabilities.yes>=threshold).length,
        wrongAccepted:wrongScores.filter(p=>p>=threshold).length}))};
  }
  await writeFile(join(scratch,'summary.json'),JSON.stringify(summary,null,2));
  await writeFile(join(scratch,'server.log'),logs);
  console.log('SUMMARY',JSON.stringify(summary));
  console.log('Artifacts:',scratch);

} catch (e) {
  await writeFile(join(scratch, 'server.log'), logs);
  console.error('Diagnostic log:', join(scratch, 'server.log'));
  throw e;
} finally {
  if (child.exitCode === null && child.signalCode === null && !spawnError) {
    const closed = new Promise<void>(r => child.once('close', () => r()));
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await closed;
    clearTimeout(killer);
  }
  // Retain generated controls and machine-readable results for inspection.
}

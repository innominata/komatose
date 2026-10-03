/** Japanese manga SFX that translation models routinely miss or romanize. */

export type SfxEntry = {
	source: string;
	meanings: string[];
};

export type SfxHit = {
	literal: string;
	translation: string;
	reasoning: string;
};

const SFX_TEXT = `
ドキ = thump / ba-dump / heartbeat
ドキッ = thump / ba-dump / sudden heartbeat
ドキドキ = thump thump / pounding heartbeat
キュン = heart flutter / pang / throb
キュンッ = heart flutter / pang / throb
ズキ = stab / throb / pang of pain
ズキッ = sharp pain / stab / throb
ズキズキ = throbbing / aching
ギュッ = squeeze / clench / hug tightly / grip
ギュウ = squeeze tightly / hug
キュッ = tighten / squeeze / sudden stop / squeak
グッ = clench / brace / tighten / firmly
ガシッ = grab firmly / seize
グイッ = tug / pull firmly
ムギュ = squish / squeeze tightly / hug tightly
ビク = flinch / jerk
ビクッ = flinch / jerk
ビクビク = trembling / nervous shaking
ブルッ = shiver / tremble
ブルブル = trembling / shivering / vibration
ゾクッ = shiver / chill down the spine
ゾワッ = goosebumps / creeping chill
ヒヤッ = sudden chill / alarm
ヒヤヒヤ = nervous suspense / anxious
ハッ = gasp / sudden realization
ハァ = sigh / breath / pant
ハァハァ = pant pant / heavy breathing
ゼェゼェ = panting heavily / wheezing
フー = sigh / exhale
スー = inhale / soft breath / smooth motion
ゴク = gulp / swallow
ゴクリ = gulp / swallow
ゴホッ = cough
ゴホゴホ = cough cough
ゲホッ = hacking cough
クシュン = achoo / sneeze
ヘクシュ = achoo / sneeze
グスッ = sniff / sniffle
ズズッ = sniff / slurp
シクシク = sob / quiet crying
メソメソ = whimper / cry
ワーン = waah / bawl
ポロッ = tear falls / drop
ポロポロ = tears falling / drops falling
ウルッ = eyes well up / teary
ジワッ = well up / gradually spread
ニコ = smile
ニコッ = smile / grin
ニコニコ = smiling happily / beam
ニヤ = grin / smirk
ニヤッ = grin / smirk
ニヤニヤ = smirk / grin repeatedly
ニタァ = creepy grin / broad grin
クスッ = chuckle / giggle
クスクス = giggle / chuckle softly
フフ = hehe / soft laugh
フフフ = chuckle / hehe
ハハハ = haha
アハハ = hahaha
ケラケラ = laugh brightly / giggle
ゲラゲラ = roar with laughter
ブハッ = burst out laughing / spit take
プッ = snort / stifle a laugh
ムスッ = sulk / pout
ムッ = annoyed / irritated
イラッ = irritation / annoyed
イライラ = irritated / frustrated
カチン = offended / irritated
プンプン = angry / huffy
ゴゴゴ = ominous rumble / menacing aura
ドヨーン = gloomy / depressed atmosphere
ズーン = gloom / heavy mood
ガーン = shock / devastation
ショボン = dejected / crestfallen
しょんぼり = downcast / dejected
ホッ = relief / sigh of relief
ホワ = warm / fluffy / dreamy
ホワホワ = fluffy / dreamy / warm
ポワ = dreamy / dazed
ポワポワ = dreamy / floating
ポッ = blush / flush
カーッ = flush red / blush intensely
カァ = blush / flush / caw
モジモジ = fidget shyly
ソワソワ = restless / fidgety
オロオロ = flustered / panicking
アワアワ = flustered / panic
キョロ = glance around
キョロキョロ = look around
チラ = glance
チラッ = glance / peek
チラチラ = glance repeatedly
ジー = stare
ジロッ = glare / sharp look
ギロッ = fierce glare
じっ = stare intently
パチッ = blink / snap / click
パチパチ = blink repeatedly / clap / crackle
コクッ = nod
コクコク = nod repeatedly
フルフル = shake head gently
ブンブン = shake vigorously / swing
ペコリ = bow
ペコペコ = bow repeatedly / hungry
トン = tap / light knock
トンッ = tap / light impact
トントン = tap tap / knock knock / pat
コン = knock / clunk
コンッ = knock / clunk
コンコン = knock knock
コツ = tap / footstep
コツッ = tap / footstep
コツコツ = footsteps / steady tapping
カツッ = hard footstep / heel click
カツカツ = heels clicking
スタッ = land lightly / step
スタスタ = brisk footsteps / walk quickly
トコトコ = light footsteps / small steps
テクテク = walking steadily
ノソノソ = lumber along / sluggish steps
ヨロッ = stagger
ヨロヨロ = stagger unsteadily
フラッ = sway / stagger
フラフラ = wobble / dizzy
タッ = dash / step off quickly
ダッ = dash
ダダダ = rapid footsteps / running
タタタ = quick light footsteps
ドタドタ = heavy running / stomping
バタバタ = frantic footsteps / flapping / bustling
ドスッ = heavy thud
ズシッ = heavy thump / weight
ドン = thud / boom / slam
ドンッ = thud / boom / slam
ドーン = BOOM / huge impact / dramatic reveal
ドドド = rumble / rushing / ominous approach
ズドン = massive impact / boom
バン = bang / slam
バンッ = bang / slam
バーン = bang / dramatic impact / reveal
バタン = slam / thud
バタッ = collapse / fall
ドサッ = thump / heavy drop
ドサドサ = multiple heavy drops
ボスッ = soft heavy thud
ゴン = bonk / clunk
ゴンッ = bonk / clunk
ゴツン = bonk / knock
ガン = bang / clang
ガンッ = bang / clang
カン = clang
カンッ = clang
キン = ring / metallic chime
キンッ = ring / metallic chime
ガキン = metallic clash
ガチャ = click / clatter
ガチャッ = click / clunk
ガチャガチャ = rattle / clank
カチャ = click / light clatter
カチャッ = click / light clatter
カチ = click
カチッ = click
カチカチ = click click / ticking
パタン = soft close / flop
パタッ = light fall / flap
パタパタ = flap flap / patter
バサッ = rustle / flap
バサバサ = vigorous rustling / flapping
ガサッ = rustle
ガサガサ = rustling
カサカサ = dry rustling
サラサラ = smooth rustle / flowing / write smoothly
サッ = whoosh / swift motion
シュッ = whoosh / swift movement
シュバッ = dart / whoosh
ビュッ = whoosh / whip
ビュー = whoosh / wind
ヒュッ = whoosh
ヒュー = whistle / wind
ブン = swing / whoosh
ブンッ = swing / whoosh
ブォン = heavy whoosh
ゴォ = roar / rushing wind / fire
ザッ = sudden step / rustle
ザザ = rushing / static / rain
ザー = pouring rain / rushing
ザアザア = pouring rain
ポツ = drip / raindrop
ポツポツ = drip drip / light rain
パラパラ = light rain / scattering
シトシト = steady gentle rain
ピチャ = splash / drip
ピチャッ = splash / drip
チャプ = slosh
チャプチャプ = sloshing
バシャッ = splash
ザブン = big splash
ゴボゴボ = bubbling / gurgling
ブクブク = bubbling
コポコポ = bubbling / pouring
ジャー = running water
チョロチョロ = trickle
ポタ = drip
ポタポタ = drip drip
ジュッ = sizzle
ジュージュー = sizzling
メラ = flame / burn
メラメラ = flames blazing
ボッ = burst into flame / ignition
ボォ = roaring flame
ゴォォ = roaring fire / wind
パッ = flash / sudden appearance
ピカ = flash / gleam
ピカッ = flash / gleam
キラ = sparkle
キラッ = sparkle
キラキラ = sparkling
ギラ = glare / gleam
ギラギラ = glaring shine
テカテカ = shiny / glossy
ツヤツヤ = glossy / lustrous
ピカピカ = shiny / sparkling
ポン = pop / light tap
ポンッ = pop / light tap
ポンポン = pat pat / pop pop
パン = clap / slap / pop
パンッ = clap / slap / bang
パーン = loud smack / bang
ペチッ = light slap
ペシッ = smack
バシッ = sharp smack
ビシッ = sharp hit / snap / dramatic point
ボコッ = hit / dent
ボコボコ = repeated beating / bubbling
ガッ = grab / sudden forceful motion
ガシ = grab firmly
グイ = pull / tug firmly
ググッ = strain / push
むぎゅ = squish / hug tightly
ムニッ = squish / press soft flesh
プニッ = poke something soft
ふわっ = float / soft / fluffy
ふわふわ = fluffy / floating
もふもふ = fluffy / fuzzy
さらさら = silky / smooth / flowing
すべすべ = smooth
ベタベタ = sticky
ヌルヌル = slimy / slippery
ネバネバ = sticky / stringy
カリカリ = crunchy / scratching / scribble
サクサク = crispy / crunchy
パリパリ = crisp / crackly
ボリボリ = crunch / scratch
モグモグ = chew / munch
ムシャムシャ = munch
パクッ = bite / chomp
ガブッ = chomp / bite hard
ゴクゴク = gulp / drink
ズルズル = slurp / drag
チュルチュル = slurp
ペロッ = lick
ペロペロ = lick repeatedly
チュッ = kiss / smooch
チュウ = kiss / smooch
ゲプ = burp
グー = stomach growl / snore
グゥ = stomach growl
スヤスヤ = sleeping peacefully
グーグー = snoring / sleeping
ムニャムニャ = sleepy mumbling
ピコン = ping / beep / notification
ピピッ = beep beep
ピー = beep / tone
ピーピー = repeated beeping
ブー = buzz / buzzer
ブーブー = buzzing / complaining
ブルル = vibration / rumble
リン = ring / chime
リンリン = ringing
プルル = phone ringing
プルルル = phone ringing
トゥルル = phone ringing
ガヤガヤ = chatter / hubbub / crowd noise
ザワ = murmur / stir
ザワザワ = murmuring / restless crowd
ワイワイ = lively chatter / noisy fun
ガヤ = chatter
シーン = silence / dead quiet
しーん = silence / dead quiet
シン = silence
シン… = silence / ...
ざわ… = murmur / uneasy stir
ゴロゴロ = rumble / rolling / lazing around / purr
ゴロッ = roll / flop
ゴロリ = roll over / flop
コロコロ = roll / rolling lightly
クルッ = turn / spin
クルクル = spin / twirl
グルグル = spin / swirl
フワッ = float / softly
ヒラヒラ = flutter
ハラハラ = flutter down / nervous suspense
パラッ = flip / scatter
ペラッ = flip a page
ペラペラ = flip pages / chatter fluently
ガリガリ = scratch / scrape / crunch
ゴリゴリ = grind / scrape
ギコギコ = creak / saw back and forth
ミシ = creak
ミシッ = creak / strain
ミシミシ = creaking / straining
ギシ = creak
ギシギシ = creaking
ギィ = creak
キー = screech
キィ = squeak / screech
ギュル = screech / twist
ギュルギュル = spinning / stomach rumble
パキ = crack
パキッ = snap / crack
パキパキ = cracking
ポキ = snap
ポキッ = snap / crack
ポキポキ = cracking joints
バキ = crack / smash
バキッ = crack / smash
バキバキ = cracking / smashing
メキ = crack / strain
メキメキ = cracking / bending
ベキ = snap / break
ベキッ = snap / break
ズルッ = slip
ツルッ = slip / smooth slide
スルッ = slip smoothly / glide
スルスル = glide / move smoothly
ヌルッ = slippery movement
ピタッ = stop suddenly / stick
ピタ = stop / cling
ピタピタ = cling / patter
ペタッ = stick / flatten
ペタペタ = patter / sticky footsteps
ドロ = goo / ooze
ドロドロ = thick / gooey / muddy
トロ = thick / melty
トロトロ = melty / slow / thick
グチャ = squish / mush
グチャッ = squish / crush
グチャグチャ = smashed / messy
ベチャ = splat / wet slap
ベチャッ = splat
ビチャ = splash / splat
ビチャッ = splash / splat
コソコソ = sneak / whisper secretly
ソロリ = sneak carefully
ソロソロ = slowly / cautiously
忍び足 = tiptoe / sneaking
スッ = smoothly / quietly / suddenly
ヌッ = suddenly appear / loom
ヌッと = suddenly appear / loom
ヒョコ = pop up / peek
ヒョコッ = pop up / peek
ひょい = lightly / casually lift
ひょいっ = hop / lift lightly
ワッ = surprise / burst
ギャッ = yelp / scream
キャッ = shriek / squeal
キャー = scream / squeal
ギャー = scream
うわっ = whoa / yikes
うわー = whoa / aaah
ひっ = eek / gasp
ヒィ = eek / terrified cry
ぎゃあ = scream
わあ = wow / aaah
おお = oooh / wow
パチン = snap / slap
パンパン = clap clap / pat pat
バチン = smack / snap
バチッ = zap / smack / spark
ビリッ = rip / zap
ビリビリ = electric shock / tearing / tingling / rip
バリッ = rip / crunch
バリバリ = ripping / crunching / crackling
ベリッ = peel / rip
ベリベリ = peel off / rip repeatedly
ブチッ = snap / tear
ブチブチ = snapping / tearing
カキカキ = scribble / scratch
スラスラ = write/read fluently
ペンペン = tap / spank
シュルシュル = pull / unwind
ゴシゴシ = scrub / rub
キュッキュ = squeak / polish
フキフキ = wipe
ナデナデ = pat / stroke
撫で撫で = pat / stroke
わしゃわしゃ = ruffle / vigorously pet
ピク = twitch
ピクッ = twitch
ピクピク = twitching
ピシッ = snap / crack / straighten
ピン = taut / ping
ピンッ = ping / tense
シャキッ = straighten up / crisp
シャキーン = dramatic shine / ready
キリッ = sharp serious expression
ドヤ = smug
ドヤァ = smug pose / triumphant aura
モクモク = smoke billowing
モワ = waft / haze
モワモワ = hazy / steaming
ムワッ = hot humid blast
フワァ = yawn / float
ふぁ = yawn
ふぁぁ = yawn
アクビ = yawn
チーン = ding / awkward silence / deadpan
カーン = clang / bell
ゴーン = gong / bell toll
キーン = ringing / high-pitched tone
ジリリリ = alarm bell
ジリジリ = ringing / scorching / inching closer
リーン = bell / insect chirp
ミーンミーン = cicada chirping
ジージー = cicada buzz / static
チリチリ = chirp / singe
ワン = woof
ワンワン = woof woof
キャン = yelp
ニャー = meow
ニャン = meow
チュン = chirp
チュンチュン = chirp chirp
ピヨピヨ = cheep cheep
カーカー = caw caw
ケロケロ = croak
ゲロゲロ = croak
ブーン = buzz
プーン = mosquito buzz
`;

const SFX_PUNCT =
	/[\s\u3000…‥.。．·・･,，、!！?？~～〜'"″“”‘’「」『』【】（）()［］[\]<>＜＞★☆※♪♡♥^*＊#＃_/\\|｜]+/g;
const KANA_RUN = /[\u3040-\u30ff\uff66-\uff9dーｰ]+/gu;
const VOWEL_OF: Record<string, string> = {};

for (const [kana, vowel] of [
	['ァアカサタナハマヤラワガザダバパャヮ', 'ア'],
	['ィイキシチニヒミリギジヂビピ', 'イ'],
	['ゥウクスツヌフムユルグズヅブプュヴ', 'ウ'],
	['ェエケセテネヘメレゲゼデベペ', 'エ'],
	['ォオコソトノホモヨロヲゴゾドボポョ', 'オ']
] as const) {
	for (const ch of kana) VOWEL_OF[ch] = vowel;
}

const byNorm = new Map<string, SfxEntry>();
const byCore = new Map<string, SfxEntry[]>();
const longKeys: string[] = [];

function toKatakana(text: string) {
	return [...text]
		.map((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			if (code >= 0x3041 && code <= 0x3096) return String.fromCodePoint(code + 0x60);
			return ch;
		})
		.join('');
}

export function normalizeSfx(text: string) {
	return toKatakana(text.normalize('NFKC').replace(SFX_PUNCT, ''));
}

function expandChoon(text: string) {
	let out = '';
	for (const ch of text) {
		if (ch === 'ー' && out.length) out += VOWEL_OF[out[out.length - 1]] || '';
		else out += ch;
	}
	return out;
}

function collapseVowels(text: string) {
	return text.replace(/([アイウエオ])\1+/g, '$1');
}

function sfxCore(norm: string) {
	return collapseVowels(
		expandChoon(norm)
			.replace(/ッ/g, '')
			.replace(/ァ/g, 'ア')
			.replace(/ィ/g, 'イ')
			.replace(/ゥ/g, 'ウ')
			.replace(/ェ/g, 'エ')
			.replace(/ォ/g, 'オ')
	);
}

function smallestRepeatUnit(text: string) {
	for (let len = 1; len <= Math.floor(text.length / 2); len++) {
		if (text.length % len === 0 && text.slice(0, len).repeat(text.length / len) === text)
			return text.slice(0, len);
	}
	return text;
}

function madeOf(text: string, unit: string) {
	return unit.length > 0 && text.length >= unit.length && unit.repeat(Math.floor(text.length / unit.length)) === text.slice(0, unit.length * Math.floor(text.length / unit.length)) && text.length % unit.length === 0;
}

function mergeMeanings(into: string[], extra: string[]) {
	for (const meaning of extra) {
		if (!into.some((have) => have.toLowerCase() === meaning.toLowerCase())) into.push(meaning);
	}
}

function addEntry(source: string, meanings: string[]) {
	if (!source || !meanings.length) return;
	const norm = normalizeSfx(source);
	if (!norm) return;
	const existing = byNorm.get(norm);
	if (existing) {
		mergeMeanings(existing.meanings, meanings);
		return;
	}
	const entry: SfxEntry = { source, meanings: [...meanings] };
	byNorm.set(norm, entry);
	const core = sfxCore(norm);
	if (core.length >= 2) {
		const list = byCore.get(core) ?? [];
		list.push(entry);
		byCore.set(core, list);
	}
}

for (const line of SFX_TEXT.split('\n')) {
	const trimmed = line.trim();
	if (!trimmed) continue;
	const eq = trimmed.indexOf('=');
	if (eq < 1) continue;
	const source = trimmed.slice(0, eq).trim();
	const meanings = trimmed
		.slice(eq + 1)
		.split(/\s+\/\s+/)
		.map((part) => part.trim())
		.filter(Boolean);
	addEntry(source, meanings);
}

longKeys.push(...[...byNorm.keys()].filter((key) => key.length >= 3).sort((a, b) => b.length - a.length));

function lookupExact(norm: string) {
	return byNorm.get(norm) ?? null;
}

function lookupSokuon(norm: string) {
	if (norm.endsWith('ッ')) {
		let cur = norm;
		while (cur.endsWith('ッ')) {
			cur = cur.slice(0, -1);
			const hit = lookupExact(cur);
			if (hit) return hit;
		}
		return null;
	}
	return lookupExact(`${norm}ッ`);
}

function lookupCore(norm: string) {
	const core = sfxCore(norm);
	if (core.length < 2) return null;
	const candidates = byCore.get(core);
	if (!candidates?.length) return null;
	const hadSoku = norm.includes('ッ');
	return candidates
		.slice()
		.sort((a, b) => {
			const aNorm = normalizeSfx(a.source);
			const bNorm = normalizeSfx(b.source);
			const aScore = (aNorm.includes('ッ') === hadSoku ? 2 : 0) + aNorm.length;
			const bScore = (bNorm.includes('ッ') === hadSoku ? 2 : 0) + bNorm.length;
			return bScore - aScore;
		})[0];
}

function lookupRepetition(norm: string) {
	for (let len = Math.min(norm.length - 1, 12); len >= 2; len--) {
		const stem = norm.slice(0, len);
		const entry = lookupExact(stem);
		if (!entry) continue;
		if (stem.repeat(Math.floor(norm.length / len)) === norm && norm.length >= len * 2) return entry;
		const unit = smallestRepeatUnit(stem);
		if (
			unit.length >= 1 &&
			madeOf(norm, unit) &&
			madeOf(stem, unit) &&
			norm.length > stem.length &&
			(unit.length >= 2 || stem.length >= 3)
		)
			return entry;
	}
	return null;
}

/** Whole region is a known SFX, including punctuation, elongation, and repeats. */
export function lookupStandaloneSfx(source: string): SfxEntry | null {
	const norm = normalizeSfx(source);
	if (norm.length < 2) return null;
	return lookupExact(norm) ?? lookupSokuon(norm) ?? lookupCore(norm) ?? lookupRepetition(norm);
}

function lookupKanaRun(run: string) {
	const standalone = lookupStandaloneSfx(run);
	if (standalone) return [standalone];
	const norm = normalizeSfx(run);
	if (norm.length < 3) return [];
	const found: SfxEntry[] = [];
	const seen = new Set<SfxEntry>();
	for (const key of longKeys) {
		if (key.length > norm.length) continue;
		if (!norm.includes(key)) continue;
		const entry = byNorm.get(key);
		if (!entry || seen.has(entry)) continue;
		seen.add(entry);
		found.push(entry);
	}
	return found;
}

/** SFX that appear as their own kana run or as a 3+ mora term inside one. */
export function findSfxInText(source: string): SfxEntry[] {
	const standalone = lookupStandaloneSfx(source);
	if (standalone) return [standalone];
	const found: SfxEntry[] = [];
	const seen = new Set<SfxEntry>();
	for (const run of source.normalize('NFKC').match(KANA_RUN) ?? []) {
		for (const entry of lookupKanaRun(run)) {
			if (seen.has(entry)) continue;
			seen.add(entry);
			found.push(entry);
		}
	}
	return found;
}

export function sfxGlossaryPrompt(sources: string[]) {
	const found: SfxEntry[] = [];
	const seen = new Set<SfxEntry>();
	for (const source of sources) {
		for (const entry of findSfxInText(source)) {
			if (seen.has(entry)) continue;
			seen.add(entry);
			found.push(entry);
		}
	}
	return found.map((entry) => `${entry.source} → ${entry.meanings.join(' / ')}`).join('\n');
}

export function withSfxGlossary(seriesGlossary: string | undefined, sources: string[]) {
	const extra = sfxGlossaryPrompt(sources);
	const series = (seriesGlossary || '').trim();
	if (!extra) return series;
	if (!series) return extra;
	const have = new Set(
		series.split('\n').map((line) => line.split(/\s*→\s*|\s+translates to\s+/)[0]?.trim()).filter(Boolean)
	);
	const fresh = extra.split('\n').filter((line) => !have.has(line.split(' → ')[0] ?? ''));
	return [series, ...fresh].filter(Boolean).join('\n');
}

export function sfxTranslateHit(source: string): SfxHit | null {
	const entry = lookupStandaloneSfx(source);
	if (!entry) return null;
	const translation = entry.meanings[0];
	return {
		literal: translation,
		translation,
		reasoning: `SFX dictionary: ${entry.source} = ${entry.meanings.join(' / ')}`
	};
}

export function sfxEntries() {
	return [...new Set(byNorm.values())];
}

export type RegionDetectionKind = 'bubble' | 'free' | 'unknown';

/**
 * A reading is dialogue when it is not itself a dictionary SFX and it contains
 * kanji, or enough hiragana to be a spoken line. Katakana lettering stays eligible.
 */
export function looksLikeDialogue(source: string) {
	const text = source.normalize('NFKC').trim();
	if (!text || lookupStandaloneSfx(text)) return false;
	if (/[\u4e00-\u9fff]/.test(text)) return true;
	const hiragana = text.match(/[\u3041-\u3096]/g)?.length ?? 0;
	const katakana = text.match(/[\u30a1-\u30fa]/g)?.length ?? 0;
	return hiragana >= 4 && hiragana > katakana;
}

/** A reading that is plainly a sentence: three kanji, six hiragana, or kanji with okurigana. */
function looksLikeSentence(text: string) {
	const kanji = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
	const hiragana = text.match(/[\u3041-\u3096]/g)?.length ?? 0;
	return kanji >= 3 || hiragana >= 6 || (kanji >= 1 && hiragana >= 3);
}

/**
 * The shape of an onomatopoeia that is not in the dictionary: kana only, short,
 * and either one sound stretched or repeated (ババババ, ちゅううう, ズバズバ) or a
 * katakana burst cut off by a small tsu (ドキッ, チッ).
 */
export function looksLikeOnomatopoeia(source: string) {
	const text = source.normalize('NFKC').replace(/[\s…・。、！？!?.,'"「」『』()（）~〜♪♡]/g, '');
	if (text.length < 2 || text.length > 12) return false;
	if (!/^[\u3041-\u3096\u30a1-\u30fc]+$/.test(text)) return false;
	// A repeated word is still a word: "yeah yeah", "no no".
	if (/^(はい|いや|うん|ええ|そう|だめ|まって|ねえ)+$/.test(text)) return false;
	if (/(.)\1{2,}/.test(text)) return true;
	if (text.length >= 4 && /(.{2,3})\1/.test(text)) return true;
	const katakana = text.match(/[\u30a1-\u30fa]/g)?.length ?? 0;
	if (katakana === text.length && /ッ$/.test(text)) return true;
	return /(.)\1.{0,2}っ$/.test(text);
}

export type RegionTypeHints = {
	/** A sound-effect detector (COO) found this lettering, so a dialogue-looking misread does not outvote it. */
	sfxDetector?: boolean;
	/** Where the detector put the lettering, when the caller only has a line type to go on. */
	kind?: RegionDetectionKind;
};

/** Short hiragana that is plainly something said: an interjection or a line ending in a spoken particle. */
const SPOKEN_WORD = /(そう|はい|うん|ええ|いや|まって|だめ|です|ます|ない|よね|かな)[！？!?…。、]*$/;
const SPOKEN_PARTICLE = /(よ|ね|だ|ぞ|ぜ|か|な|わ)[！？!?…。、]*$/;

/** Hiragana-only and not a sound: "そう！" in a margin is speech even though the sound-effect detector fired. */
function looksSpoken(text: string) {
	const plain = text.replace(/[\s…・。、！？!?.,'"「」『』()（）~〜♪♡]/g, '');
	if (plain.length < 2 || plain.length > 8) return false;
	if (!/^[\u3041-\u3096ー]+$/.test(plain)) return false;
	if (looksLikeOnomatopoeia(plain)) return false;
	// One particle after a single mora is as likely a sound (ぐわ, かさ) as a word, so it needs a stem.
	return SPOKEN_WORD.test(text) || (plain.length >= 3 && SPOKEN_PARTICLE.test(text));
}

/**
 * Detector class is the prior. A standalone dictionary hit is SFX even inside a
 * bubble, unless it is a plain hiragana word there. A free-text box whose reading is
 * dialogue is not SFX: it is an aside ('//'), speech or narration lettered outside a
 * bubble. A detector that cannot tell bubble text from free lettering (`unknown`)
 * is judged by the shape of what was read.
 */
export function classifyRegionLineType(
	kind: RegionDetectionKind,
	source: string,
	hints: RegionTypeHints = {}
): '::' | '""' | '//' {
	const text = source.trim();
	if (text && lookupStandaloneSfx(text)) {
		// A short hiragana word that is not known to be free lettering is a sigh or a murmur (はあ……), not lettering.
		const spoken =
			kind !== 'free' &&
			!hints.sfxDetector &&
			!/[\u30a1-\u30fa]/.test(text.normalize('NFKC')) &&
			!looksLikeOnomatopoeia(text);
		return spoken ? '""' : '::';
	}
	const speech = text && (looksLikeSentence(text.normalize('NFKC')) || looksSpoken(text.normalize('NFKC')));
	if (hints.sfxDetector && !speech) return '::';
	if (kind === 'free') return looksLikeDialogue(text) || speech ? '//' : '::';
	if (kind === 'unknown' && text && looksLikeOnomatopoeia(text)) return '::';
	return '""';
}

/** Agreed source, or any reading when every reading is a dictionary SFX. */
export function sfxClassificationSource(
	agreedSource: string,
	readings: { source: string; error?: string }[],
) {
	const agreed = agreedSource.trim();
	if (agreed) return agreed;
	const texts = readings.filter((reading) => reading.source.trim() && !reading.error).map((reading) => reading.source.trim());
	if (texts.length && texts.every((text) => lookupStandaloneSfx(text))) return texts[0];
	return '';
}

/**
 * Gold standard for fixtures/test-pages (Give My Regards to Black Jack, vol. 1 pp. 1–10).
 *
 * Boxes are [x0, y0, x1, y1] in source pixels (every page is 1414 × 2000) and hug
 * the lettering, not the balloon. `source` is the lettering as printed, without furigana.
 * `en` is the official English from fixtures/test-pages/english; `literal` stays close
 * to the Japanese wording. `keys` are meaning checks: every group must be matched by
 * one of its phrases. A line carrying several boxes is one repeated SFX.
 *
 * speech/caption/sfx must be detected; sign/title text may be detected without penalty.
 * Only lines with official English are translated.
 */
export type GoldKind = 'speech' | 'caption' | 'sfx' | 'sign' | 'title';
export type GoldBox = [number, number, number, number];

export type GoldLine = {
	id: string;
	kind: GoldKind;
	boxes: GoldBox[];
	source: string;
	en?: string;
	literal?: string;
	keys?: string[][];
	/** Non-source lettering or numeric signs: detected, never OCR-scored. */
	latin?: boolean;
	/** False for lettering whose visible glyphs cannot support a reliable reading. */
	ocr?: false;
	note?: string;
};

export type GoldPage = {
	id: string;
	file: string;
	english?: string;
	width: number;
	height: number;
	note: string;
	lines: GoldLine[];
};

export const GOLD_SERIES = 'Give My Regards to Black Jack (ブラックジャックによろしく)';
export const GOLD_LANG = 'japanese' as const;
export const GOLD_PAGE_SIZE = { width: 1414, height: 2000 };

/** What a series page would carry: the title and the two names the official edition romanizes. */
export const GOLD_SERIES_NOTES = 'Give My Regards to Black Jack (ブラックジャックによろしく): a medical drama.';
export const GOLD_GLOSSARY = '斉藤 → Saito\n永禄大学 → Eiroku University';

const INTERN = ['intern', 'resident', 'trainee'];
const SAITO = ['saito', 'saitō'];

function page(id: string, note: string, lines: GoldLine[]): GoldPage {
	return {
		id,
		file: `fixtures/test-pages/${id}.jpg`,
		english: `fixtures/test-pages/english/${id}.jpg`,
		...GOLD_PAGE_SIZE,
		note,
		lines,
	};
}

export const GOLD_PAGES: GoldPage[] = [
	page('001', 'Cover', [
		{ id: '001-title', kind: 'title', boxes: [[510, 1140, 1090, 1890]], source: 'ブラックジャックによろしく',
			en: 'Give My Regards to Black Jack', literal: 'Regards to Black Jack',
			keys: [['black jack', 'blackjack'], ['regards', 'hello', 'greet', 'say hi']] },
		{ id: '001-edition', kind: 'title', boxes: [[318, 1145, 462, 1548]], source: '完全版', literal: 'Complete Edition' },
		{ id: '001-author', kind: 'title', boxes: [[318, 1560, 425, 1930]], source: '佐藤秀峰',
			en: 'Shuho Sato', literal: 'Sato Shuho', keys: [['sato'], ['shuho', 'shūhō', 'syuhou', 'shuuhou']] },
		{ id: '001-volume', kind: 'title', boxes: [[1100, 470, 1275, 790]], source: '1', latin: true },
		{ id: '001-strip', kind: 'title', boxes: [[840, 640, 1180, 1000]], source: 'GIVE MY REGARDS TO BLACK JACK', latin: true },
		{ id: '001-romaji', kind: 'title', boxes: [[425, 1570, 470, 1880]], source: 'SATO SYUHOU', latin: true },
	]),
	page('002', 'Contents', [
		{ id: '002-volume', kind: 'title', boxes: [[655, 240, 760, 420]], source: '1', latin: true },
		{ id: '002-arc', kind: 'title', boxes: [[575, 462, 835, 525]], source: '第一外科編', literal: 'First Surgery Department Arc' },
		{ id: '002-strip', kind: 'title', boxes: [[490, 530, 930, 575]], source: 'GIVE MY REGARDS TO BLACKJACK', latin: true },
		{ id: '002-ep1', kind: 'title', boxes: [[886, 755, 932, 1030]], source: '第1話 研修医の夜',
			en: 'Ep.01 Night of the Intern', literal: 'Chapter 1: Night of the Trainee Doctor', keys: [['night'], INTERN] },
		{ id: '002-ep2', kind: 'title', boxes: [[822, 755, 868, 1195]], source: '第2話 ウナギとゴッドハンド',
			en: 'Ep.02 Eels and Godhands', literal: 'Chapter 2: Eels and the God Hand',
			keys: [['eel'], ['god hand', 'godhand', 'god-hand', "god's hand"]] },
		{ id: '002-ep3', kind: 'title', boxes: [[758, 755, 804, 1040]], source: '第3話 75歳の値段',
			en: 'Ep.03 The Price of Being 75', literal: 'Chapter 3: The Price of a 75-Year-Old',
			keys: [['price', 'cost', 'value', 'worth'], ['75', 'seventy-five', 'seventy five']] },
		{ id: '002-ep4', kind: 'title', boxes: [[692, 755, 738, 940]], source: '第4話 夏雲',
			en: 'Ep.04 Summer Clouds', literal: 'Chapter 4: Summer Clouds', keys: [['summer'], ['cloud']] },
		{ id: '002-ep5', kind: 'title', boxes: [[626, 755, 672, 1215]], source: '第5話 外科と内科と医局と斉藤',
			en: 'Ep.05 Surgery, Internists, Departments, And Saito',
			literal: 'Chapter 5: Surgery, Internal Medicine, the Medical Office, and Saito',
			keys: [['surg'], ['internal', 'internist'], SAITO] },
		{ id: '002-ep6', kind: 'title', boxes: [[561, 755, 607, 1000]], source: '第6話 最初のウソ',
			en: 'Ep.06 The First Lie', literal: 'Chapter 6: The First Lie', keys: [['first'], ['lie']] },
		{ id: '002-ep7', kind: 'title', boxes: [[497, 755, 543, 1000]], source: '第7話 一流のワナ',
			en: 'Ep.07 The Top-tier Trap', literal: 'Chapter 7: A First-Class Trap',
			keys: [['trap', 'snare'], ['first-class', 'first class', 'top-tier', 'top tier', 'first-rate', 'first rate', 'elite', 'top-notch', 'top notch', 'world-class', 'world class', 'top-class', 'top class', 'expert', 'master']] },
		{ id: '002-title', kind: 'title', boxes: [[590, 1390, 930, 1860]], source: 'ブラックジャックによろしく',
			en: 'Give My Regards to Black Jack', literal: 'Regards to Black Jack',
			keys: [['black jack', 'blackjack'], ['regards', 'hello', 'greet', 'say hi']] },
		{ id: '002-edition', kind: 'title', boxes: [[485, 1400, 572, 1630]], source: '完全版', literal: 'Complete Edition' },
	]),
	page('003', 'Graduation ceremony', [
		{ id: '003-sign', kind: 'sign', boxes: [[280, 170, 1060, 285]], source: '永禄大学医学部卒業',
			literal: 'Eiroku University School of Medicine Graduation' },
		{ id: '003-8000', kind: 'speech', boxes: [[1065, 130, 1185, 360]], source: '8千人……',
			en: '8000...', literal: 'Eight thousand people...', keys: [['8000', 'eight thousand']] },
		{ id: '003-every-year', kind: 'speech', boxes: [[185, 255, 395, 520]], source: '毎年8千人が全国に81ある大学医学部を卒業してゆく',
			en: 'Every year, 8000 students graduate from the 81 medical universities in this country.',
			literal: 'Every year, eight thousand people graduate from the 81 university medical schools across the country',
			keys: [['every year', 'each year', 'annually', 'yearly', 'a year'], ['8000', 'eight thousand'], ['81', 'eighty-one', 'eighty one'], ['graduat'], ['medic']] },
		{ id: '003-banner', kind: 'sign', boxes: [[510, 575, 910, 635]], source: '永禄大学医学部卒業式',
			literal: 'Eiroku University School of Medicine Graduation Ceremony' },
		{ id: '003-plaque', kind: 'sign', boxes: [[1150, 750, 1215, 830]], source: '', latin: true },
		{ id: '003-top-80', kind: 'speech', boxes: [[255, 1170, 450, 1415]], source: '君達はその8千人のトップの80人である！',
			en: 'And, of those 8000, YOU are the top eighty!', literal: 'You are the top 80 of those eight thousand!',
			keys: [['80', 'eighty'], ['top', 'best', 'elite', 'cream'], ['8000', 'eight thousand']] },
	]),
	page('004', 'Ceremony speech and chapter title', [
		{ id: '004-japan', kind: 'speech', boxes: [[715, 185, 1195, 1000]], source: '日本の医療を背負っていくのは君達です!!',
			en: "Japan's medical future rests in your hands!!",
			literal: "The ones who will carry Japan's medical care on their backs are you!!",
			keys: [['japan'], ['medic', 'health'], ['you']] },
		{ id: '004-chapter', kind: 'title', boxes: [[850, 1555, 1300, 1765]], source: '第1話 研修医の夜',
			en: 'Ep.01 Night of the Intern', literal: 'Chapter 1: Night of the Trainee Doctor', keys: [['night'], INTERN] },
	]),
	page('005', 'Full-page art with no lettering: anything detected here is a false positive', []),
	page('006', 'Eiroku University Hospital', [
		{ id: '006-pillar', kind: 'sign', boxes: [[930, 1090, 1185, 1995]], source: '永禄大学附属病院',
			en: 'Eiroku University Hospital', literal: 'Eiroku University Affiliated Hospital',
			keys: [['eiroku'], ['universit'], ['hospital']] },
		{ id: '006-or-sign', kind: 'sign', boxes: [[372, 1540, 522, 1700]], source: '手術室', literal: 'Operating Room' },
		{ id: '006-sleepy', kind: 'speech', boxes: [[583, 1468, 712, 1675]], source: '眠そうだな斉藤……',
			en: 'You look pretty sleepy, Saito...', literal: 'You look sleepy, Saito...',
			keys: [['sleepy', 'tired', 'drowsy', 'exhausted', 'sleep'], SAITO] },
		{ id: '006-on-duty', kind: 'speech', boxes: [[218, 1608, 372, 1862]], source: 'うんさっきまで当直だったから',
			en: 'Yeah, I just got off my shift.', literal: 'Yeah, because I was on night duty until just now',
			keys: [['shift', 'duty', 'on call', 'on-call', 'night watch', 'overnight', 'all night', 'working', 'nights']] },
	]),
	page('007', 'Scrubbing in', [
		{ id: '007-24-hours', kind: 'speech', boxes: [[992, 165, 1183, 425]], source: 'きのうの朝からもう24時間以上ここにいるよ',
			en: "I've been here over 24 hours since yesterday morning.",
			literal: "I've been here since yesterday morning, already more than 24 hours",
			keys: [['yesterday'], ['morning'], ['24', 'twenty-four', 'twenty four']] },
		{ id: '007-me-too', kind: 'speech', boxes: [[654, 688, 726, 860]], source: 'オレもさ',
			en: 'Yeah, me too.', literal: 'Me too',
			keys: [['me too', 'same', 'me neither', 'so am i', 'so have i', 'i too', 'likewise', 'as well', 'also']] },
		{ id: '007-professor', kind: 'speech', boxes: [[426, 112, 555, 352]], source: '教授の実験の手伝いでさ……',
			en: "Helping out with the doctor's experiments.", literal: "Helping with the professor's experiment, see...",
			keys: [['professor', 'doctor', 'prof'], ['experiment', 'research', 'lab']] },
		{ id: '007-3-hours', kind: 'speech', boxes: [[106, 155, 235, 372]], source: '3時間しか寝てねえ……',
			en: 'I only slept 3 hours...', literal: "I've only slept 3 hours...",
			keys: [['3', 'three'], ['hour'], ['sleep', 'slept']] },
		{ id: '007-scrub', kind: 'sfx', boxes: [[205, 95, 330, 155], [115, 405, 245, 465], [820, 128, 875, 240], [626, 326, 680, 420]], source: 'ゴシ',
			en: 'Scrub', literal: 'Scrub', keys: [['scrub', 'rub', 'gosh']] },
		{ id: '007-i-win', kind: 'speech', boxes: [[452, 615, 572, 812]], source: 'じゃあ僕の勝ちだ',
			en: 'Then I win.', literal: "Then it's my win", keys: [['win', 'won', 'beat', 'victory']] },
		{ id: '007-2-hours', kind: 'speech', boxes: [[1013, 997, 1199, 1288]], source: '2時間しか寝てない！',
			en: 'I only slept 2 hours!', literal: "I've only slept 2 hours!",
			keys: [['2', 'two'], ['hour'], ['sleep', 'slept']] },
	]),
	page('008', 'Operating theatre', [
		{ id: '008-3-months', kind: 'caption', boxes: [[1145, 60, 1328, 742]], source: '永禄大学医学部卒業から3ヵ月——',
			en: "It's been 3 months since I graduated from Eiroku University...",
			literal: 'Three months since graduating from Eiroku University School of Medicine—',
			keys: [['3', 'three'], ['month'], ['graduat'], ['eiroku']] },
		{ id: '008-intern', kind: 'caption', boxes: [[180, 57, 415, 628]], source: '僕は今永禄大学附属病院で研修医をしている',
			en: "And currently I'm working as an intern at the university's hospital.",
			literal: 'I am now working as a trainee doctor at Eiroku University Affiliated Hospital',
			keys: [INTERN, ['hospital'], ['now', 'currently', 'these days', 'at present']] },
		{ id: '008-shluurp', kind: 'sfx', boxes: [[1183, 915, 1275, 1228]], source: 'ちゅううううう',
			en: 'Shluuuurp', literal: 'Chuuuuu (sucking)',
			keys: [['slurp', 'shlurp', 'shluu', 'sluu', 'suck', 'sip', 'chuu', 'squirt', 'schlu', 'fsss', 'shhh']] },
		{ id: '008-come-on', kind: 'speech', boxes: [[765, 1425, 888, 1573]], source: 'ホラ斉藤！',
			en: 'Come on, Saito!', literal: 'Here, Saito!', keys: [SAITO] },
		{ id: '008-injection', kind: 'speech', boxes: [[215, 1655, 370, 1900]], source: '注射するのにイチイチそんな顔すんな！',
			en: "Don't make that kinda face every time you give an injection!",
			literal: "Don't make that face every single time you give an injection!",
			keys: [['inject', 'shot', 'needle', 'syringe'], ['face', 'expression', 'look']] },
		{ id: '008-squirt', kind: 'sfx', boxes: [[965, 1430, 1305, 1505]], source: 'チューーッ', literal: 'Squirt' },
		{ id: '008-syringe', kind: 'sign', boxes: [[1118, 1580, 1185, 1610]], source: '', latin: true },
	]),
	page('009', 'What an intern is', [
		{ id: '009-apprentice', kind: 'caption', boxes: [[1042, 100, 1158, 364]], source: '研修医というのは要するに見習いだ',
			en: 'Interns are basically apprentices.', literal: 'A trainee doctor is, in short, an apprentice',
			keys: [INTERN, ['apprentice', 'trainee', 'novice', 'learner', 'in training']] },
		{ id: '009-six-years', kind: 'caption', boxes: [[584, 114, 739, 358]], source: '医者になるには大学で6年間医学を学び',
			en: 'To become a doctor, we need to study at a medical university for 6 years...',
			literal: 'To become a doctor, you study medicine at university for 6 years',
			keys: [['doctor', 'physician'], ['6', 'six'], ['year'], ['stud', 'learn']] },
		{ id: '009-pass-exam', kind: 'caption', boxes: [[130, 474, 286, 722]], source: '医師国家試験に合格しなければいけない',
			en: 'And then pass the National Medical Practitioners Qualifying Examination.',
			literal: 'and must pass the national medical licensing exam',
			keys: [['pass'], ['national'], ['exam', 'test']] },
		{ id: '009-knowledge', kind: 'caption', boxes: [[987, 790, 1169, 1056]], source: 'ところがその国家試験は医学の知識をみるもので',
			en: 'But the National Medical Practitioners Qualifying Examination only tests medical knowledge.',
			literal: 'However, that national exam tests medical knowledge',
			keys: [['national'], ['exam', 'test'], ['knowledge'], ['medic']] },
		{ id: '009-no-practical', kind: 'caption', boxes: [[157, 939, 292, 1206]], source: '実技試験などは含まれていない(!)',
			en: 'There is no practical exam!', literal: 'and practical exams and the like are not included (!)',
			keys: [['practical', 'hands-on', 'hands on', 'skills', 'clinical'], ['exam', 'test'], ['no', 'not', "doesn't", "don't", "isn't", "aren't", 'none', 'nothing', 'without', 'never', 'exclud']] },
		{ id: '009-two-years', kind: 'caption', boxes: [[908, 1283, 1190, 1523]], source: 'そこで医師免許を取得した者の大半はその後2年間大学病院などで研修をする',
			en: "That's why most graduates spend the next 2 years as an intern at a university hospital.",
			literal: 'So most of those who obtain a medical license then train for 2 years at university hospitals and the like',
			keys: [['most', 'majority', 'many', 'the bulk', 'almost all'], ['2', 'two'], ['year'], ['hospital']] },
		{ id: '009-widen', kind: 'speech', boxes: [[673, 1286, 814, 1496]], source: 'もっと術野を広げろ斉藤',
			en: 'Widen the incision, Saito.', literal: 'Widen the surgical field more, Saito',
			keys: [['widen', 'wider', 'open', 'spread', 'expand', 'bigger', 'broaden', 'larger', 'more room', 'retract'], SAITO] },
		{ id: '009-yes', kind: 'speech', boxes: [[542, 1431, 623, 1579]], source: 'はい！',
			en: 'Yes, sir!', literal: 'Yes!', keys: [['yes', 'sir', 'right', 'okay', 'ok', 'yeah', 'got it', 'understood', 'roger']] },
	]),
	page('010', 'Canteen after surgery', [
		{ id: '010-sigh', kind: 'speech', boxes: [[1178, 672, 1253, 833]], source: 'はあ……', en: 'Ah...', literal: 'Haa... (sigh)' },
		{ id: '010-hate-myself', kind: 'speech', boxes: [[784, 1061, 970, 1329]], source: '手術の後でうまそうにメシを食ってる自分が嫌だ',
			en: 'I hate myself for being able to enjoy food like this after an operation.',
			literal: "I hate myself for eating my meal like it's delicious after surgery",
			keys: [['hate', 'disgust', "can't stand", 'sick of', 'despise', 'dislike', 'loathe'], ['surgery', 'operation', 'operating'], ['eat', 'food', 'meal', 'enjoy', 'delicious', 'tasty']] },
		{ id: '010-hey-saito', kind: 'speech', boxes: [[630, 686, 743, 857]], source: 'なあ斉藤……', en: 'Saito, I...', literal: 'Hey, Saito...', keys: [SAITO] },
		{ id: '010-slurp', kind: 'sfx', boxes: [[388, 671, 480, 916]], source: 'ちゅるるっ', en: 'Sluuuurp', literal: 'Churuu (slurp)',
			keys: [['slurp', 'sluu', 'slur', 'shluu', 'chur', 'suck', 'sip', 'schlu']] },
		{ id: '010-losing-heart', kind: 'speech', boxes: [[493, 1093, 661, 1329]], source: 'オレはこのままでは人の心を失くしてしまう……',
			en: "I feel like, with this job, I'm losing my ability to care for others...",
			literal: "At this rate, I'm going to lose my human heart...",
			keys: [['lose', 'losing', 'lost'], ['heart', 'human', 'humanity', 'compassion', 'feeling', 'care', 'emotion', 'soul', 'empathy']] },
		{ id: '010-silence', kind: 'speech', boxes: [[556, 1389, 636, 1573]], source: '…………', literal: '......' },
		{ id: '010-what', kind: 'speech', boxes: [[1167, 1424, 1290, 1668]], source: '何言ってんだよ！',
			en: 'What are you talking about?', literal: 'What are you saying!',
			keys: [['what'], ['talk', 'say', 'mean', 'nonsense']] },
		{ id: '010-supporting', kind: 'speech', boxes: [[689, 1622, 847, 1901]], source: '日本の医療を支えてるのは僕達なんだぞ！',
			en: "We're the ones supporting Japan's medical care!",
			literal: "We're the ones supporting Japan's medical care, you know!",
			keys: [['japan'], ['medic', 'health'], ['support', 'prop', 'carry', 'backbone', 'hold', 'uphold', 'sustain', 'keep']] },
	]),
];

/** Detection must find these; sign and title regions are neutral either way. */
export function goldRequired(line: GoldLine): boolean {
	return line.kind === 'speech' || line.kind === 'caption' || line.kind === 'sfx';
}

/** Dialogue (speech and captions) is the headline OCR score; SFX, signs, and titles are scored apart. */
export function goldOcrGroup(line: GoldLine): 'dialogue' | 'other' | null {
	if (line.latin || line.ocr === false) return null;
	return line.kind === 'speech' || line.kind === 'caption' ? 'dialogue' : 'other';
}

/** Lines sent for translation, in reading order: those with checked English and real words. */
export function goldTranslationLines(page: GoldPage): GoldLine[] {
	return page.lines.filter((line) => line.en && !line.latin && line.ocr !== false && /[\p{L}\p{N}]/u.test(line.source) && /[\p{L}\p{N}]/u.test(line.en));
}

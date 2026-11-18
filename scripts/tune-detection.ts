/**
 * Tune text detection on a series from your own corrections.
 *
 *   npx tsx scripts/tune-detection.ts <series id or slug> [--all] [--episode <id>]
 *
 * Every page Transcribe detects keeps each detector's raw boxes (see detectionLog.ts). This
 * replays them through the fusion rules with stricter thresholds and scores each variant
 * against the regions you kept on pages marked done (--all: every detected page). Nothing is
 * changed; apply a threshold you like in FUSION in src/lib/server/detectFusion.ts.
 *
 * "False positives" are regions the reader would not have filtered, which you then had to
 * delete or ignore; "found" are regions you kept; "missed" are kept regions no detection made.
 */
import { sqlite } from '../src/lib/server/db';
import { FUSION } from '../src/lib/server/detectFusion';
import { tuneFusion, tuningPages, type TuningScore } from '../src/lib/server/detectionTuning';

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const all = args.includes('--all');
const episodeId = flag('--episode');
const target = args.filter((a) => !a.startsWith('--'))[0];
if (!target) {
	console.error('Usage: npx tsx scripts/tune-detection.ts <series id or slug> [--all] [--episode <id>]');
	process.exit(2);
}
const series = sqlite.prepare('SELECT id, title FROM series WHERE id=? OR slug=?').get(target, target) as { id: string; title: string } | undefined;
if (!series) {
	console.error(`No series "${target}"`);
	process.exit(1);
}
const pages = tuningPages(series.id, { all, episodeId });
if (!pages.length) {
	console.error(all
		? 'No detected pages recorded for this series yet. Run Transcribe on a chapter first.'
		: 'No detected pages are marked done yet. Finish a chapter (Mark page done), or pass --all to use every detected page.');
	process.exit(1);
}
const { baseline, results, combined } = tuneFusion(pages);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const line = (label: string, s: TuningScore) => {
	const d = (n: number, base: number) => (n === base ? '' : ` (${n > base ? '+' : ''}${n - base})`);
	return `${label.padEnd(48)} found ${String(s.found).padStart(5)}${d(s.found, baseline.found).padEnd(7)} ` +
		`false+ ${String(s.falsePositives).padStart(5)}${d(s.falsePositives, baseline.falsePositives).padEnd(7)} ` +
		`missed ${String(s.missed).padStart(4)}  precision ${pct(s.precision)}  recall ${pct(s.recall)}`;
};
console.log(`${series.title}: ${pages.length} page${pages.length === 1 ? '' : 's'}${all ? '' : ' marked done'}, ${pages.reduce((n, p) => n + p.truth.length, 0)} kept regions`);
console.log(`Current lone-box thresholds: ${JSON.stringify(FUSION.alone)}\n`);
console.log(line('Current settings', baseline));
console.log('');
for (const r of results) console.log(line(r.variant.label, r.score));
if (combined) {
	console.log('');
	console.log(line(`Together: ${combined.variant.label}`, combined.score));
}

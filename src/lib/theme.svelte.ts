import { browser } from '$app/environment';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'komatose.theme';
const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

export const themeChoice = $state({ value: 'system' as ThemeChoice });
export const themeResolved = $state({ value: 'dark' as 'light' | 'dark' });

export function readChoice(): ThemeChoice {
	if (!browser) return 'system';
	const saved = localStorage.getItem(KEY);
	return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

export function resolvedTheme(choice: ThemeChoice): 'light' | 'dark' {
	if (choice === 'light' || choice === 'dark') return choice;
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(choice: ThemeChoice) {
	const theme = resolvedTheme(choice);
	document.documentElement.dataset.theme = theme;
	document.documentElement.dataset.bsTheme = theme;
	document.documentElement.dataset.themeChoice = choice;
	localStorage.setItem(KEY, choice);
	themeChoice.value = choice;
	themeResolved.value = theme;
}

let listening = false;

export function initTheme() {
	applyTheme(readChoice());
	if (listening) return;
	listening = true;
	const query = window.matchMedia('(prefers-color-scheme: dark)');
	query.addEventListener('change', () => {
		if (readChoice() === 'system') applyTheme('system');
	});
	window.addEventListener('storage', (event) => {
		if (event.key === KEY) applyTheme(readChoice());
	});
}

export function cycleTheme() {
	const current = readChoice();
	const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
	applyTheme(next);
}

export function themeLabel(choice: ThemeChoice) {
	if (choice === 'light') return 'Light';
	if (choice === 'dark') return 'Dark';
	return 'System';
}

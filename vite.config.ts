import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';
import { scanWsPlugin } from './src/lib/server/ws-dev';

export default defineConfig(({ mode }) => {
	// Deployment origins are supplied through the environment so site hostnames
	// never live in the repository. Comma-separated, e.g.
	// SCAN_TRUSTED_ORIGINS=https://scan.example.com,http://scan.example.com
	const env = loadEnv(mode, process.cwd(), '');
	const trustedOrigins = (env.SCAN_TRUSTED_ORIGINS ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);

	return {
		plugins: [
			sveltekit({
				compilerOptions: {
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},
				adapter: adapter(),
				typescript: {
					config: (config) => {
						config.include.push('../drizzle.config.ts');
						config.include.push('../server.ts');
					}
				},
				csrf: {
					trustedOrigins: [...trustedOrigins, 'http://127.0.0.1:3847']
				}
			}),
			scanWsPlugin()
		],
		server: {
			host: '127.0.0.1',
			port: 5173
		}
	};
});

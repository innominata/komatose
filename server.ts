import { createServer } from 'node:http';
// Built by `vite build` (adapter-node).
// @ts-ignore generated output is built by adapter-node
import { handler } from './build/handler.js';
import { warmupOcr } from './src/lib/server/ocr.ts';
import { ensureAiUser } from './src/lib/server/aiUser.ts';
import { attachWss } from './src/lib/server/realtime.ts';
import { startKomatoseGpu } from './src/lib/server/komatoseGpu.ts';

const port = Number(process.env.PORT || 3847);
const host = process.env.HOST || '127.0.0.1';

const server = createServer((req, res) => {
	handler(req, res, () => {});
});
server.on('error', (err) => {
	console.error('HTTP server error', err);
});
process.on('uncaughtException', (err) => {
	const error = err as NodeJS.ErrnoException;
	if (error.code === 'ENOENT' && String(error.path || '').includes('/build/')) {
		console.error('Missing built asset', error.path);
		return;
	}
	console.error(err);
	process.exit(1);
});

attachWss(server);

server.listen(port, host, () => {
	console.log(`Komatose listening on http://${host}:${port}`);
	warmupOcr();
	ensureAiUser().catch((err) => console.error('AI/OCR user setup failed', err));
	startKomatoseGpu().catch((err) => console.error('Komatose GPU startup failed', err));
});

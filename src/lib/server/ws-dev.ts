import type { Plugin } from 'vite';
import { attachWss } from './realtime';

export function scanWsPlugin(): Plugin {
	return {
		name: 'scan-ws',
		configureServer(server) {
			if (server.httpServer) attachWss(server.httpServer);
		},
		configurePreviewServer(server) {
			if (server.httpServer) attachWss(server.httpServer);
		}
	};
}

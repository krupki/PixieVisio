import { defineConfig } from 'vite';

export default defineConfig(async () => {
	// dynamic import to support ESM-only plugins when Vite runs in CJS environment
	const react = (await import('@vitejs/plugin-react')).default;

	return {
		plugins: [react()],
		server: { port: 3000 }
	};
});

import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const dependencies = fileURLToPath(new URL("../../../../excalidraw-cloudflare/node_modules/", import.meta.url));
const backend = process.env.YAOS_SPIKE_BACKEND ?? "https://yaos-excalidraw-spike-20260909.kavin.me.cloudflare.dev";

export default {
	root,
	resolve: {
		alias: [
			{ find: "@excalidraw/excalidraw/index.css", replacement: path.join(dependencies, "@excalidraw/excalidraw/dist/dev/index.css") },
			{ find: /^@excalidraw\/excalidraw$/, replacement: path.join(dependencies, "@excalidraw/excalidraw") },
			{ find: /^react$/, replacement: path.join(dependencies, "react") },
			{ find: /^react\/(.+)$/, replacement: `${path.join(dependencies, "react")}/$1` },
			{ find: /^react-dom$/, replacement: path.join(dependencies, "react-dom") },
			{ find: /^react-dom\/(.+)$/, replacement: `${path.join(dependencies, "react-dom")}/$1` },
		],
	},
	server: {
		host: "127.0.0.1",
		port: 4181,
		strictPort: true,
		fs: {
			allow: [fileURLToPath(new URL("../../../../", import.meta.url))],
		},
		proxy: {
			"/api": {
				target: backend,
				changeOrigin: true,
				rewrite: (requestPath) => requestPath.replace(/^\/api/, ""),
			},
		},
	},
};

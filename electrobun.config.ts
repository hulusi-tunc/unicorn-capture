import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Prisma",
		identifier: "studio.unicorn.capture",
		version: "0.0.1",
	},
	runtime: {
		exitOnLastWindowClosed: false,
	},
	build: {
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			mainview: {
				entrypoint: "src/view/index.ts",
			},
		},
		copy: {
			"src/view/index.html": "views/mainview/index.html",
			"src/view/styles/tokens.css": "views/mainview/tokens.css",
			"src/view/styles/components.css": "views/mainview/components.css",
			"assets/icons/logo.svg": "views/mainview/logo.svg",
			"assets/icons/iphone-17.png": "views/mainview/iphone-17.png",
			"assets/icons/iphone-17-dark.png": "views/mainview/iphone-17-dark.png",
			"samples/devices.yaml": "samples/devices.yaml",
		},
		mac: {
			bundleCEF: false,
			icons: "assets/Prisma.iconset",
		},
	},
} satisfies ElectrobunConfig;

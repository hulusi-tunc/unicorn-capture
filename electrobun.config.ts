import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Unicorn Studio",
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
			"assets/icons/ipad-11.png": "views/mainview/ipad-11.png",
			"assets/icons/ipad-11-portrait.png": "views/mainview/ipad-11-portrait.png",
			"assets/icons/ipad-13.png": "views/mainview/ipad-13.png",
			"assets/icons/ipad-13-portrait.png": "views/mainview/ipad-13-portrait.png",
			"assets/icons/ipad-mini.png": "views/mainview/ipad-mini.png",
			"assets/icons/ipad-mini-portrait.png": "views/mainview/ipad-mini-portrait.png",
			"samples/devices.yaml": "samples/devices.yaml",
		},
		// Auto-update: when set, the running app polls
		// `${baseUrl}/<env>-macos-<arch>-update.json` for fresh update.json
		// files matching the artifacts/ filename pattern that
		// build:canary / build:stable already produce. Override per-machine
		// via env var so a fresh clone on a CI worker doesn't accidentally
		// inherit the publish URL.
		release: {
			baseUrl: process.env.ELECTROBUN_RELEASE_BASE_URL ?? "",
			generatePatch: true,
		},
		mac: {
			bundleCEF: false,
			icons: "assets/UnicornStudio.iconset",
			// Codesign + notarize gate on env vars: ELECTROBUN_DEVELOPER_ID
			// must be set (the keychain identity from Developer ID Application
			// cert). Notarize uses ELECTROBUN_APPLEID + ELECTROBUN_APPLEIDPASS
			// (app-specific password) + ELECTROBUN_TEAMID. We toggle both
			// flags via env so a missing cert in CI doesn't fail the build —
			// the unsigned .app + DMG are still produced for inspection.
			codesign: process.env.ELECTROBUN_DEVELOPER_ID ? true : false,
			notarize:
				process.env.ELECTROBUN_DEVELOPER_ID &&
				process.env.ELECTROBUN_APPLEID &&
				process.env.ELECTROBUN_APPLEIDPASS &&
				process.env.ELECTROBUN_TEAMID
					? true
					: false,
			// Hardened runtime entitlements. Keep the surface minimal until we
			// hit a feature that actually needs an exception (mic, camera,
			// network-server, etc.). All snap captures go through xcrun simctl
			// (process spawn, no privileged API), so the JIT + child-process
			// entitlements are enough.
			entitlements: {
				"com.apple.security.cs.allow-jit": true,
				"com.apple.security.cs.allow-unsigned-executable-memory": true,
				"com.apple.security.cs.disable-library-validation": true,
				"com.apple.security.cs.allow-dyld-environment-variables": true,
			},
		},
	},
} satisfies ElectrobunConfig;

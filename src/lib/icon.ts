// Tiny wrapper around the vanilla `lucide` package so the rest of the app
// only deals with names + sizes. Same icon set as the gallery web platform
// (lucide-react), so visual parity is automatic.

import {
	Activity,
	ArrowLeft,
	Camera,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	CornerDownRight,
	createElement as lucideCreateElement,
	Folder,
	Globe,
	Image as ImageIcon,
	Keyboard,
	Loader2,
	Moon,
	PanelLeftClose,
	PanelLeftOpen,
	PanelRightClose,
	PanelRightOpen,
	Play,
	Plus,
	RefreshCw,
	RotateCcw,
	Search,
	Settings,
	Smartphone,
	Sparkles,
	SunMedium,
	Trash2,
	Upload,
	X,
	Zap,
	ZapOff,
} from "lucide";

// Allow-list of icons we actually use. Add new ones here as needed.
export const ICONS = {
	activity: Activity,
	"arrow-left": ArrowLeft,
	camera: Camera,
	"chevron-down": ChevronDown,
	"chevron-left": ChevronLeft,
	"chevron-right": ChevronRight,
	"chevron-up": ChevronUp,
	"corner-down-right": CornerDownRight,
	folder: Folder,
	globe: Globe,
	image: ImageIcon,
	keyboard: Keyboard,
	loader: Loader2,
	moon: Moon,
	"panel-left-close": PanelLeftClose,
	"panel-left-open": PanelLeftOpen,
	"panel-right-close": PanelRightClose,
	"panel-right-open": PanelRightOpen,
	play: Play,
	plus: Plus,
	"refresh-cw": RefreshCw,
	"rotate-ccw": RotateCcw,
	search: Search,
	settings: Settings,
	smartphone: Smartphone,
	sparkles: Sparkles,
	"sun-medium": SunMedium,
	trash: Trash2,
	upload: Upload,
	x: X,
	zap: Zap,
	"zap-off": ZapOff,
};

export type IconName = keyof typeof ICONS;

export interface IconOpts {
	size?: number;
	strokeWidth?: number;
	className?: string;
}

/** Build a Lucide SVG element. Defaults: 16px, stroke 1.75. */
export function icon(name: IconName, opts: IconOpts = {}): SVGElement {
	const node = ICONS[name] as Parameters<typeof lucideCreateElement>[0];
	const size = opts.size ?? 16;
	const el = lucideCreateElement(node, {
		width: size,
		height: size,
		"stroke-width": opts.strokeWidth ?? 1.75,
	}) as unknown as SVGElement;
	el.classList.add("ic");
	if (opts.className) el.classList.add(opts.className);
	el.setAttribute("aria-hidden", "true");
	return el;
}

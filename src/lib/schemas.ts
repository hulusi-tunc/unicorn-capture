import yaml from "js-yaml";
import { z } from "zod";

type SpecField =
	| "url"
	| "selector"
	| "value"
	| "ms"
	| "timeout"
	| "delay"
	| "x"
	| "y"
	| "name"
	| "fullPage"
	| "script"
	| "waitUntil";
interface ActionDef {
	fields: readonly SpecField[];
	required: readonly SpecField[];
}

export const ACTION_SPEC: Record<string, ActionDef> = {
	navigate: { fields: ["url", "waitUntil", "timeout"], required: ["url"] },
	click: { fields: ["selector", "x", "y", "timeout"], required: [] },
	type: {
		fields: ["selector", "value", "delay", "timeout"],
		required: ["selector", "value"],
	},
	select: {
		fields: ["selector", "value", "timeout"],
		required: ["selector", "value"],
	},
	wait: { fields: ["ms", "selector", "timeout"], required: [] },
	assert: { fields: ["selector"], required: ["selector"] },
	screenshot: { fields: ["name", "fullPage"], required: [] },
	scroll: { fields: ["selector", "x", "y", "timeout"], required: [] },
	hover: { fields: ["selector", "timeout"], required: ["selector"] },
	evaluate: { fields: ["script"], required: ["script"] },
};

export const ACTION_TYPES = [
	"navigate",
	"click",
	"type",
	"select",
	"wait",
	"assert",
	"screenshot",
	"scroll",
	"hover",
	"evaluate",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

const actionTypeSchema = z.enum(ACTION_TYPES);

export const flowStepSchema: z.ZodType<any> = z.lazy(() =>
	z
		.object({
			action: actionTypeSchema,
			selector: z.string().optional(),
			value: z.string().optional(),
			url: z.string().optional(),
			ms: z.number().int().positive().optional(),
			timeout: z.number().int().positive().optional(),
			name: z.string().optional(),
			fullPage: z.boolean().optional(),
			x: z.number().optional(),
			y: z.number().optional(),
			script: z.string().optional(),
			waitUntil: z.string().optional(),
			delay: z.number().int().nonnegative().optional(),
			steps: z.array(flowStepSchema).optional(),
		})
		.superRefine((step, ctx) => {
			const spec = ACTION_SPEC[step.action as ActionType];
			if (!spec) return;
			for (const field of spec.required) {
				if ((step as any)[field] === undefined) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: `${step.action}: missing required field '${field}'`,
						path: [field],
					});
				}
			}
			if (step.action === "wait" && step.ms === undefined && !step.selector) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "wait: requires 'ms' or 'selector'",
					path: [],
				});
			}
			if (
				step.action === "scroll" &&
				step.x === undefined &&
				step.y === undefined &&
				!step.selector
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "scroll: requires 'x', 'y', or 'selector'",
					path: [],
				});
			}
		}),
);

export const flowSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	takeScreenshots: z.boolean().optional(),
	steps: z.array(flowStepSchema).min(1),
});

export const scenarioSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	takeScreenshots: z.boolean().optional(),
	flows: z.array(flowSchema).min(1),
});

export const DEVICE_CATEGORIES = [
	"mobile-small",
	"mobile",
	"mobile-large",
	"foldable-folded",
	"foldable-open",
	"tablet-small",
	"tablet",
	"laptop",
	"desktop",
	"ultrawide",
	"custom",
] as const;
export type DeviceCategory = (typeof DEVICE_CATEGORIES)[number];

export const deviceSchema = z.object({
	name: z.string().min(1),
	category: z.enum(DEVICE_CATEGORIES).optional(),
	viewport: z.object({
		width: z.number().int().positive(),
		height: z.number().int().positive(),
	}),
	userAgent: z.string().optional(),
	locale: z.string().optional(),
	timezoneId: z.string().optional(),
	colorScheme: z.enum(["light", "dark"]).optional(),
	deviceScaleFactor: z.number().positive().optional(),
	hasTouch: z.boolean().optional(),
	isMobile: z.boolean().optional(),
	extraHttpHeaders: z.record(z.string()).optional(),
});

export const deviceConfigSchema = z.object({
	devices: z.array(deviceSchema).min(1),
});

export type FlowStep = z.infer<typeof flowStepSchema>;
export type Flow = z.infer<typeof flowSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type DeviceConfig = z.infer<typeof deviceConfigSchema>;

export type Result<T, E = string> =
	| { ok: true; value: T }
	| { ok: false; error: E };

function parseWith<T>(
	schema: z.ZodType<T>,
	raw: string,
	format: "yaml" | "json" = "yaml",
): Result<T> {
	try {
		const parsed = format === "yaml" ? yaml.load(raw) : JSON.parse(raw);
		const r = schema.safeParse(parsed);
		if (!r.success) {
			return {
				ok: false,
				error: r.error.issues
					.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("; "),
			};
		}
		return { ok: true, value: r.data };
	} catch (e: any) {
		return { ok: false, error: `Parse error: ${e.message}` };
	}
}

export const validateScenario = (
	raw: string,
	format: "yaml" | "json" = "yaml",
) => parseWith(scenarioSchema, raw, format);
export const validateDeviceConfig = (
	raw: string,
	format: "yaml" | "json" = "yaml",
) => parseWith(deviceConfigSchema, raw, format);

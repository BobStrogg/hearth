/**
 * Session settings: ACP config options (session/set_config_option) plus the older `modes`
 * (session/set_mode) and unstable `models` (session/set_model) shapes, normalised into one list
 * of config options for the UI. Per the spec, when an agent sends configOptions those win; the
 * legacy modes/models only fill a category (mode/model) the config options don't cover, so an
 * agent that advertises e.g. its model as a config option but its mode only as `modes` still
 * gets both pills. Config options are keyed by `id` (spec); `configId` is accepted too because
 * early Hearth releases (and some agents) used it.
 */
export interface SelectChoice { value: string; name: string; description?: string | null; group?: string }
export interface UiOption {
  id: string; name: string; description?: string | null; category?: string | null;
  type: "select" | "boolean"; value: string | boolean; choices?: SelectChoice[];
  /** How to set it: ACP config option, legacy mode, or legacy model. */
  via: "config" | "mode" | "model";
}
export interface RawSettings {
  configOptions?: unknown[] | null;
  modes?: { currentModeId: string; availableModes: { id: string; name: string; description?: string | null }[] } | null;
  models?: { currentModelId: string; availableModels: { modelId: string; name: string; description?: string | null }[] } | null;
}
export const MODE_ID = "_hearth_mode", MODEL_ID = "_hearth_model";

type Any = Record<string, unknown>;
/** The option's id: spec `id`, or the non-standard `configId` some agents send. */
export const optId = (o: unknown): string | null => {
  const a = o as Any | null;
  return typeof a?.id === "string" ? a.id : typeof a?.configId === "string" ? a.configId : null;
};
/** A select value: a string id, or `{ value: "id" }` as some agents wrap it. */
const selVal = (v: unknown): string | null => typeof v === "string" ? v : typeof (v as Any)?.value === "string" ? (v as Any).value as string : null;
function flatten(opts: unknown): SelectChoice[] {
  const out: SelectChoice[] = [];
  if (!Array.isArray(opts)) return out;
  for (const o of opts as Any[]) {
    if (Array.isArray(o?.options)) { for (const c of o.options as Any[]) if (typeof c?.value === "string") out.push({ value: c.value, name: String(c.name ?? c.value), description: (c.description as string) ?? null, group: String(o.name ?? o.group ?? o.groupId ?? "") }); }
    else if (typeof o?.value === "string") out.push({ value: o.value, name: String(o.name ?? o.value), description: (o.description as string) ?? null });
  }
  return out;
}

export function normalize(raw: RawSettings): UiOption[] {
  const out: UiOption[] = [];
  if (Array.isArray(raw.configOptions)) {
    for (const o of raw.configOptions as Any[]) {
      const id = optId(o);
      if (!id) continue;
      const base = { id, name: String(o.name ?? id), description: (o.description as string) ?? null, category: (o.category as string) ?? null, via: "config" as const };
      const sv = selVal(o.currentValue);
      if (o.type === "select" && sv !== null) { const choices = flatten(o.options); if (choices.length) out.push({ ...base, type: "select", value: sv, choices }); }
      else if (o.type === "boolean" && typeof o.currentValue === "boolean") out.push({ ...base, type: "boolean", value: o.currentValue });
      // unknown option types are skipped (forward compatible)
    }
  }
  const has = (cat: string) => out.some((o) => o.category === cat);
  const m = raw.modes;
  if (!has("mode") && m && Array.isArray(m.availableModes) && m.availableModes.length)
    out.push({ id: MODE_ID, name: "Mode", category: "mode", type: "select", value: m.currentModeId, via: "mode",
      choices: m.availableModes.map((x) => ({ value: x.id, name: x.name ?? x.id, description: x.description ?? null })) });
  const md = raw.models;
  if (!has("model") && md && Array.isArray(md.availableModels) && md.availableModels.length)
    out.push({ id: MODEL_ID, name: "Model", category: "model", type: "select", value: md.currentModelId, via: "model",
      choices: md.availableModels.map((x) => ({ value: x.modelId, name: x.name ?? x.modelId, description: x.description ?? null })) });
  return out;
}

/** Merge a session/new|load|resume|set_config_option response (or update) into stored raw settings. */
export function absorb(cur: RawSettings, r: Any | undefined | null): RawSettings {
  if (!r) return cur;
  const next = { ...cur };
  if (Array.isArray(r.configOptions)) next.configOptions = r.configOptions;
  if (r.modes && typeof r.modes === "object") next.modes = r.modes as RawSettings["modes"];
  if (r.models && typeof r.models === "object") next.models = r.models as RawSettings["models"];
  return next;
}

/** Apply a session/update notification; returns null if it isn't settings-related. */
export function applyUpdate(cur: RawSettings, u: Any): RawSettings | null {
  switch (u?.sessionUpdate) {
    case "config_option_update": return Array.isArray(u.configOptions) ? { ...cur, configOptions: u.configOptions } : null;
    case "current_mode_update": {
      const id = u.currentModeId as string;
      const next = { ...cur };
      if (cur.modes) next.modes = { ...cur.modes, currentModeId: id };
      if (Array.isArray(cur.configOptions)) next.configOptions = cur.configOptions.map((o) => (o as Any).category === "mode" && (o as Any).type === "select" ? { ...(o as Any), currentValue: id } : o);
      return next;
    }
    case "current_model_update": return cur.models ? { ...cur, models: { ...cur.models, currentModelId: String(u.currentModelId ?? u.modelId) } } : null;
    default: return null;
  }
}

/** Optimistically set a value locally (legacy modes/models have no response payload). */
export function setLocal(cur: RawSettings, opt: UiOption, value: string | boolean): RawSettings {
  if (opt.via === "mode" && cur.modes) return { ...cur, modes: { ...cur.modes, currentModeId: String(value) } };
  if (opt.via === "model" && cur.models) return { ...cur, models: { ...cur.models, currentModelId: String(value) } };
  if (opt.via === "config" && Array.isArray(cur.configOptions)) return { ...cur, configOptions: cur.configOptions.map((o) => optId(o) === opt.id ? { ...(o as Any), currentValue: value } : o) };
  return cur;
}

/** Is `value` valid for this option? */
export function valid(opt: UiOption, value: unknown): value is string | boolean {
  if (opt.type === "boolean") return typeof value === "boolean";
  return typeof value === "string" && !!opt.choices?.some((c) => c.value === value);
}

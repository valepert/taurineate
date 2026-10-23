import { invoke } from "@tauri-apps/api/core";

export type Engine = "potrace" | "autotrace";

export interface OptionSpec {
  flag: string;
  label: string;
  kind: "number" | "bool" | "color";
  default?: number | string;
  optional: boolean;
  enabled: boolean;
  min?: number;
  max?: number;
  step?: number;
  integer: boolean;
  help: string;
}

export interface Descriptor {
  engine: Engine;
  label: string;
  description: string;
  threshold: boolean;
  options: OptionSpec[];
}

export interface OptionValue {
  enabled: boolean;
  value: number | string | null;
}

export type Values = Record<string, OptionValue>;

/** What a preset stores, and what each engine tab keeps as state. */
export interface EngineSettings {
  values: Values;
  threshold: number;
}

export type TracerSource = "custom" | "env" | "path" | "standard" | "loginShell";

export interface TracerInfo {
  engine: Engine;
  path: string | null;
  version: string | null;
  source: TracerSource | null;
  /** e.g. TAURINEATE_POTRACE */
  envVar: string;
  customPath: string | null;
  warnings: string[];
  error: string | null;
}

export interface TraceResult {
  svg: string;
  bytes: number;
  paths: number;
  colors: string[];
  millis: number;
  command: string;
}

export interface LoadedImage {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  histogram: number[];
}

export const api = {
  descriptors: () => invoke<Descriptor[]>("get_descriptors"),
  detectTracers: () => invoke<TracerInfo[]>("detect_tracers"),
  setTracerPath: (engine: Engine, path: string | null) => invoke<TracerInfo>("set_tracer_path", { engine, path }),
  loadImage: (path: string) => invoke<LoadedImage>("load_image", { path }),
  /** `output` completes the displayed command; the file is only written when `write` is true (Run). */
  trace: (engine: Engine, input: string, settings: EngineSettings, output: string | null, write: boolean) =>
    invoke<TraceResult>("trace", {
      request: { engine, input, values: settings.values, threshold: settings.threshold, output },
      output: write ? output : null,
    }),
  fileSize: (path: string) => invoke<number | null>("file_size", { path }),
  listPresets: (engine: Engine) => invoke<Record<string, EngineSettings>>("list_presets", { engine }),
  savePreset: (engine: Engine, name: string, settings: EngineSettings) =>
    invoke<Record<string, EngineSettings>>("save_preset", { engine, name, settings }),
  deletePreset: (engine: Engine, name: string) => invoke<Record<string, EngineSettings>>("delete_preset", { engine, name }),
};

export function defaultSettings(desc: Descriptor): EngineSettings {
  const values: Values = {};
  for (const o of desc.options) {
    values[o.flag] = { enabled: o.optional || o.kind === "bool" ? o.enabled : true, value: o.default ?? null };
  }
  return { values, threshold: 50 };
}

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}b`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)}kb` : `${(kb / 1024).toFixed(1)}mb`;
}

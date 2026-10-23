import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, defaultSettings, Descriptor, Engine, EngineSettings, formatSize, LoadedImage, TracerInfo } from "./api";
import { Histogram } from "./histogram";
import { hasProblem, renderPrograms, WARNING_SIGN } from "./programs";
import { infoButton, renderOptions } from "./settings";
import { Viewer } from "./viewer";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "pnm", "pbm", "pgm", "ppm"];
const RECENT_KEY = "taurineate.recentColors";
const DEFAULT_PRESET = "default";
/** Select value for the "name*" entry shown while the settings differ from the selected profile. */
const MODIFIED = "\u0000modified";

const state = {
  descriptors: [] as Descriptor[],
  tracers: {} as Record<Engine, TracerInfo>,
  active: "autotrace" as Engine,
  /** The Programs tab replaces the engine panel while it's open. */
  view: "engine" as "engine" | "programs",
  settings: {} as Record<Engine, EngineSettings>,
  presets: {} as Record<Engine, Record<string, EngineSettings>>,
  presetSelected: {} as Record<Engine, string>,
  input: null as string | null,
  image: null as LoadedImage | null,
  output: null as string | null,
  outputDerived: true,
  resultColors: [] as string[],
  recentColors: loadRecent(),
  seq: 0,
};

const viewer = new Viewer($("results"));
const histogram = new Histogram($("histogram"), $("histogram-info"), (t) => setThreshold(t));
const desc = () => state.descriptors.find((d) => d.engine === state.active)!;
const tracerReady = () => !!state.tracers[state.active]?.path && !state.tracers[state.active]?.error;

// ---------- rendering ----------

function renderTabs() {
  const tab = (label: string, note: string, warn: boolean, selected: boolean, onClick: () => void) => {
    const b = document.createElement("button");
    b.role = "tab";
    b.className = "tab";
    b.setAttribute("aria-selected", String(selected));
    b.append(Object.assign(document.createElement("span"), { textContent: label }));
    if (note) b.append(Object.assign(document.createElement("small"), { className: warn ? "warn" : "", textContent: note }));
    b.addEventListener("click", onClick);
    return b;
  };
  const engineTabs = state.descriptors.map((d) => {
    const t = state.tracers[d.engine];
    return tab(d.label, t?.version ?? "not found", hasProblem(t), state.view === "engine" && d.engine === state.active, () => switchTab(d.engine));
  });
  const anyProblem = state.descriptors.some((d) => hasProblem(state.tracers[d.engine]));
  const programs = tab("Programs", anyProblem ? WARNING_SIGN : "", anyProblem, state.view === "programs", openPrograms);
  programs.classList.add("tab-programs");
  $("tabs").replaceChildren(...engineTabs, programs);
}

function renderProgramsPanel() {
  renderPrograms($("programs-panel"), state.descriptors, state.tracers, {
    choose: chooseTracer,
    automatic: (engine) => setTracer(engine, null),
    searchAgain,
  });
}

function applyView() {
  $("engine-panel").hidden = state.view !== "engine";
  $("programs-panel").hidden = state.view !== "programs";
}

function renderPanel() {
  const d = desc();
  $("engine-missing").hidden = tracerReady();
  $("engine-missing-text").textContent = `${d.label} isn't set up.`;

  renderOptions($("options"), d, state.settings[d.engine], {
    resultColors: state.resultColors,
    recentColors: state.recentColors,
    onChange: onSettingsChanged,
    onColorPicked: rememberColor,
  });

  $("threshold-group").hidden = !d.threshold;
  const th = state.settings[d.engine].threshold;
  $<HTMLInputElement>("threshold-num").value = String(th);
  $<HTMLInputElement>("threshold-range").value = String(th);
  syncThresholdView();

  renderPresets();
}

/** "default" is built in and read-only; a modified profile shows as "name*" next to its clean entry, which reverts. */
function renderPresets() {
  const select = $<HTMLSelectElement>("preset-load");
  const names = Object.keys(state.presets[state.active] ?? {});
  const selected = state.presetSelected[state.active] ?? DEFAULT_PRESET;
  const modified = isModified(state.active);
  select.replaceChildren(
    ...[DEFAULT_PRESET, ...names].flatMap((n) => [
      ...(modified && n === selected ? [new Option(`${n}*`, MODIFIED, false, true)] : []),
      new Option(n, n, false, !modified && n === selected),
    ]),
  );
  select.title = modified ? `Changed from "${selected}". Choose "${selected}" to revert.` : "";
  $<HTMLButtonElement>("preset-delete").disabled = selected === DEFAULT_PRESET;
}

/** The settings a profile stands for: the built-in defaults, or a saved preset filled in with them. */
function profileSettings(engine: Engine, name: string): EngineSettings {
  const preset = state.presets[engine]?.[name];
  const d = state.descriptors.find((x) => x.engine === engine)!;
  return name === DEFAULT_PRESET || !preset ? defaultSettings(d) : withDefaults(engine, preset);
}

/** Compares values, not edits, so moving a slider back to its saved value clears the "*". */
function isModified(engine: Engine): boolean {
  const saved = profileSettings(engine, state.presetSelected[engine] ?? DEFAULT_PRESET);
  return canonical(saved) !== canonical(state.settings[engine]);
}

function canonical(s: EngineSettings): string {
  const values = Object.keys(s.values)
    .sort()
    .map((k) => {
      const v = s.values[k];
      return [k, v.enabled, v.value === null ? null : String(v.value).toUpperCase()];
    });
  return JSON.stringify([s.threshold, values]);
}

function renderFiles() {
  $<HTMLInputElement>("input-path").value = state.input ?? "";
  $<HTMLInputElement>("output-path").value = state.output ?? "";
  $("input-size").textContent = formatSize(state.image?.bytes);
}

async function refreshOutputSize() {
  $("output-size").textContent = state.output ? formatSize(await api.fileSize(state.output)) : "";
}

function showError(message: string | null) {
  $("error").hidden = !message;
  $("error-text").textContent = message ?? "";
}

// ---------- tracing ----------

let debounce: number | undefined;

function onSettingsChanged() {
  syncThresholdView();
  renderPresets();
  if (!$<HTMLInputElement>("live").checked) return;
  clearTimeout(debounce);
  debounce = window.setTimeout(() => runTrace(false), 250);
}

/** Live preview traces in memory; Run (write=true) also writes the output file. */
async function runTrace(write: boolean) {
  clearTimeout(debounce);
  if (!state.input) {
    if (write) showError("Choose an input file first.");
    return;
  }
  if (!tracerReady()) {
    if (write) showError(`${state.active} is not available. Set it up in the Programs tab.`);
    return;
  }
  if (write && !state.output) {
    showError("Choose an output file first.");
    return;
  }
  const seq = ++state.seq;
  $("spinner").hidden = false;
  try {
    const result = await api.trace(state.active, state.input, state.settings[state.active], state.output, write);
    if (seq !== state.seq) return;
    viewer.push(result);
    state.resultColors = result.colors;
    $("command").textContent = result.command;
    $("command-box").hidden = false;
    showError(null);
    if (write) await refreshOutputSize();
  } catch (e) {
    if (seq === state.seq && String(e) !== "cancelled") showError(String(e));
  } finally {
    if (seq === state.seq) $("spinner").hidden = true;
  }
}

// ---------- actions ----------

function switchTab(engine: Engine) {
  if (engine === state.active && state.view === "engine") return;
  state.active = engine;
  state.view = "engine";
  applyView();
  renderTabs();
  renderPanel();
  if ($<HTMLInputElement>("live").checked) runTrace(false);
}

function openPrograms() {
  state.view = "programs";
  applyView();
  renderTabs();
  renderProgramsPanel();
}

/** After installing a tracer: resolve both again without restarting the app. */
async function searchAgain() {
  for (const t of await api.detectTracers()) state.tracers[t.engine] = t;
  renderTabs();
  renderProgramsPanel();
  renderPanel();
}

async function setInput(path: string) {
  try {
    const image = await api.loadImage(path);
    state.input = path;
    state.image = image;
    if (state.outputDerived || !state.output) {
      state.output = path.replace(/\.[^./\\]+$/, "") + ".svg";
      state.outputDerived = true;
    }
    viewer.clear();
    viewer.setImage(image.width, image.height);
    histogram.setBins(image.histogram);
    viewer.setOverlay($<HTMLInputElement>("overlay").checked ? image.dataUrl : null);
    renderFiles();
    await refreshOutputSize();
    showError(null);
    if ($<HTMLInputElement>("live").checked) runTrace(false);
  } catch (e) {
    showError(String(e));
  }
}

async function pickInput() {
  const path = await open({ multiple: false, filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] });
  if (typeof path === "string") await setInput(path);
}

async function pickOutput() {
  const path = await save({ defaultPath: state.output ?? undefined, filters: [{ name: "SVG", extensions: ["svg"] }] });
  if (path) {
    state.output = path;
    state.outputDerived = false;
    renderFiles();
    await refreshOutputSize();
  }
}

/** Choose a binary (checked by the backend before it's saved), or `null` to go back to automatic search. */
async function setTracer(engine: Engine, path: string | null) {
  try {
    state.tracers[engine] = await api.setTracerPath(engine, path);
    showError(null);
  } catch (e) {
    showError(String(e));
    return;
  }
  renderTabs();
  renderProgramsPanel();
  renderPanel();
}

async function chooseTracer(engine: Engine) {
  const path = await open({ multiple: false, title: `Choose the ${engine} program` });
  if (typeof path === "string") await setTracer(engine, path);
}

/** Fill in any options a stored preset doesn't know about. */
function withDefaults(engine: Engine, s: EngineSettings): EngineSettings {
  const base = defaultSettings(state.descriptors.find((d) => d.engine === engine)!);
  return { threshold: s.threshold ?? base.threshold, values: { ...base.values, ...structuredClone(s.values) } };
}

function loadPreset(name: string) {
  if (name === MODIFIED) return;
  state.settings[state.active] = profileSettings(state.active, name);
  state.presetSelected[state.active] = name;
  renderPanel();
  onSettingsChanged();
}

async function savePreset() {
  const dialog = $<HTMLDialogElement>("preset-dialog");
  const input = $<HTMLInputElement>("preset-name");
  const current = state.presetSelected[state.active];
  // Suggest overwriting a saved profile; "default" always needs a new name.
  input.value = current && current !== DEFAULT_PRESET ? current : "";
  input.setCustomValidity("");
  input.oninput = () =>
    input.setCustomValidity(input.value.trim() === DEFAULT_PRESET ? '"default" is built in. Choose another name.' : "");
  dialog.showModal();
  dialog.onclose = async () => {
    const name = input.value.trim();
    if (dialog.returnValue !== "save" || !name || name === DEFAULT_PRESET) return;
    state.presets[state.active] = await api.savePreset(state.active, name, state.settings[state.active]);
    state.presetSelected[state.active] = name;
    renderPresets();
  };
}

async function deletePreset() {
  const name = state.presetSelected[state.active];
  if (!name || name === DEFAULT_PRESET) return;
  state.presets[state.active] = await api.deletePreset(state.active, name);
  state.presetSelected[state.active] = DEFAULT_PRESET;
  renderPresets();
}

function viewSource(which: "current" | "previous") {
  const result = viewer[which].result;
  if (!result) return;
  $("source-title").textContent = `SVG source — ${which} (${formatSize(result.bytes)})`;
  $("source-text").textContent = result.svg;
  $<HTMLDialogElement>("source-dialog").showModal();
}

function rememberColor(hex: string) {
  state.recentColors = [hex, ...state.recentColors.filter((c) => c !== hex)].slice(0, 16);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(state.recentColors));
  } catch {
    /* storage unavailable: recent colors just aren't remembered */
  }
}

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/** From the number field, the slider or the histogram; keeps the other two in sync. */
function setThreshold(value: number, from?: HTMLInputElement) {
  if (Number.isNaN(value)) return;
  const v = Math.min(100, Math.max(0, Math.round(value)));
  for (const id of ["threshold-num", "threshold-range"]) {
    const el = $<HTMLInputElement>(id);
    if (el !== from) el.value = String(v);
  }
  if (v === state.settings[state.active].threshold) return;
  state.settings[state.active].threshold = v;
  syncThresholdView();
  onSettingsChanged();
}

/** Histogram and hint depend on the threshold and on the engine's invert option, if it has one. */
function syncThresholdView() {
  const s = state.settings[state.active];
  const invert = !!s.values.invert?.enabled;
  histogram.setThreshold(s.threshold, invert);
  $("threshold-hint").textContent = invert
    ? "Invert is on: lighter pixels are traced."
    : "Darker pixels are traced.";
}

// ---------- wiring ----------

function wire() {
  for (const cell of document.querySelectorAll<HTMLElement>("[data-help]")) cell.append(infoButton(cell.dataset.help!));
  $("pick-input").addEventListener("click", pickInput);
  $("pick-output").addEventListener("click", pickOutput);
  $<HTMLInputElement>("input-path").addEventListener("change", (e) => setInput((e.target as HTMLInputElement).value.trim()));
  $<HTMLInputElement>("output-path").addEventListener("change", (e) => {
    state.output = (e.target as HTMLInputElement).value.trim() || null;
    state.outputDerived = false;
    refreshOutputSize();
  });
  $("engine-setup").addEventListener("click", openPrograms);
  $("run").addEventListener("click", () => runTrace(true));
  $("error-close").addEventListener("click", () => showError(null));
  $("live").addEventListener("change", (e) => (e.target as HTMLInputElement).checked && runTrace(false));
  $("overlay").addEventListener("change", (e) =>
    viewer.setOverlay((e.target as HTMLInputElement).checked ? (state.image?.dataUrl ?? null) : null),
  );

  const num = $<HTMLInputElement>("threshold-num");
  const range = $<HTMLInputElement>("threshold-range");
  num.addEventListener("input", () => num.value !== "" && setThreshold(Number(num.value), num));
  range.addEventListener("input", () => setThreshold(Number(range.value), range));
  histogram.setBins(null);

  $("preset-save").addEventListener("click", savePreset);
  $("preset-delete").addEventListener("click", deletePreset);
  $<HTMLSelectElement>("preset-load").addEventListener("change", (e) => loadPreset((e.target as HTMLSelectElement).value));

  viewer.onViewSource = viewSource;
  $("source-close").addEventListener("click", () => $<HTMLDialogElement>("source-dialog").close());
  const copyCommand = $("command-copy");
  const copyIcon = copyCommand.innerHTML;
  copyCommand.addEventListener("click", async () => {
    await navigator.clipboard.writeText($("command").textContent ?? "");
    copyCommand.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>';
    copyCommand.setAttribute("aria-label", "Copied");
    setTimeout(() => {
      copyCommand.innerHTML = copyIcon;
      copyCommand.setAttribute("aria-label", "Copy command");
    }, 1200);
  });
  $("source-copy").addEventListener("click", () => navigator.clipboard.writeText($("source-text").textContent ?? ""));

  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === "o") (e.preventDefault(), pickInput());
    if (e.key === "Enter") (e.preventDefault(), runTrace(true));
  });

  getCurrentWebview().onDragDropEvent((e) => {
    document.body.classList.toggle("dropping", e.payload.type === "enter" || e.payload.type === "over");
    if (e.payload.type === "drop" && e.payload.paths[0]) setInput(e.payload.paths[0]);
  });

  // Drag the divider between results and settings.
  const split = $("vsplit");
  split.addEventListener("pointerdown", (e) => {
    split.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) =>
      document.documentElement.style.setProperty("--side", `${Math.min(720, Math.max(380, innerWidth - m.clientX))}px`);
    const up = () => {
      split.removeEventListener("pointermove", move);
      split.removeEventListener("pointerup", up);
      viewer.reset();
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", up);
  });
}

async function init() {
  wire();
  try {
    state.descriptors = await api.descriptors();
    for (const d of state.descriptors) {
      state.settings[d.engine] = defaultSettings(d);
      state.presetSelected[d.engine] = DEFAULT_PRESET;
      state.presets[d.engine] = await api.listPresets(d.engine);
    }
    for (const t of await api.detectTracers()) state.tracers[t.engine] = t;
    state.active = state.descriptors[0].engine;
    renderTabs();
    renderPanel();
    renderFiles();
  } catch (e) {
    showError(String(e));
  }
}

init();

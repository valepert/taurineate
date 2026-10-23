import { Descriptor, EngineSettings, OptionSpec, OptionValue } from "./api";

export interface OptionsContext {
  /** Fill colors in the last result, offered by the color popover (Delineate's palette). */
  resultColors: string[];
  recentColors: string[];
  onChange: () => void;
  onColorPicked: (hex: string) => void;
}

/**
 * Builds Delineate's three-column grid: label | enable checkbox (optional options) | value control.
 * Bool options only have the checkbox; numbers get a spinner and a slider kept in sync.
 */
export function renderOptions(grid: HTMLElement, desc: Descriptor, settings: EngineSettings, ctx: OptionsContext) {
  grid.replaceChildren();
  for (const spec of desc.options) {
    const value = (settings.values[spec.flag] ??= { enabled: spec.enabled, value: spec.default ?? null });
    grid.append(...optionRow(spec, value, ctx));
  }
}

function optionRow(spec: OptionSpec, state: OptionValue, ctx: OptionsContext): HTMLElement[] {
  const labelCell = document.createElement("div");
  labelCell.className = "opt-label-cell";
  const label = document.createElement(spec.kind === "color" ? "button" : "span");
  label.className = spec.kind === "color" ? "label-button" : "opt-label";
  label.textContent = spec.label;
  labelCell.append(label, infoButton(spec.help, defaultText(spec)));

  const enableCell = document.createElement("div");
  enableCell.className = "opt-enable";
  const control = document.createElement("div");
  control.className = "opt-control";

  const hasCheckbox = spec.optional || spec.kind === "bool";
  if (hasCheckbox) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.enabled;
    cb.setAttribute("aria-label", spec.kind === "bool" ? spec.label : `Use ${spec.label}`);
    cb.addEventListener("change", () => {
      state.enabled = cb.checked;
      control.classList.toggle("disabled", !cb.checked);
      ctx.onChange();
    });
    enableCell.append(cb);
  }

  if (spec.kind === "number") {
    control.append(...numberControl(spec, state, ctx.onChange));
  } else if (spec.kind === "color") {
    const hex = colorControl(spec, state, ctx);
    control.append(hex);
    label.addEventListener("click", () =>
      openColorPopover(label, String(state.value ?? "FFFFFF"), ctx, (picked) => {
        state.value = picked;
        state.enabled = true;
        hex.value = picked;
        syncEnabled();
        ctx.onColorPicked(picked);
        ctx.onChange();
      }),
    );
  }

  const syncEnabled = () => {
    const cb = enableCell.querySelector("input");
    if (cb) cb.checked = state.enabled;
    control.classList.toggle("disabled", hasCheckbox && !state.enabled && spec.kind !== "bool");
  };
  syncEnabled();
  return [labelCell, enableCell, control];
}

/** "Default: 60", "Default: on", or "Default: off (256 when on)", taken from the descriptor. */
function defaultText(spec: OptionSpec): string {
  if (spec.kind === "bool") return `Default: ${spec.enabled ? "on" : "off"}`;
  const value = String(spec.default ?? "");
  if (spec.optional && !spec.enabled) return `Default: off (${value} when on)`;
  return `Default: ${value}`;
}

/** A visible "i" that shows a short help text (and an optional muted note) right away on hover or focus. */
export function infoButton(help: string, note?: string): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "info";
  b.textContent = "i";
  b.setAttribute("aria-label", note ? `${help} ${note}` : help);
  const show = () => showTip(b, help, note);
  b.addEventListener("mouseenter", show);
  b.addEventListener("focus", show);
  b.addEventListener("click", show);
  b.addEventListener("mouseleave", hideTip);
  b.addEventListener("blur", hideTip);
  return b;
}

let tip: HTMLElement | null = null;

function showTip(anchor: HTMLElement, text: string, note?: string) {
  tip ??= Object.assign(document.createElement("div"), { className: "tip", role: "tooltip" });
  tip.textContent = text;
  if (note) tip.append(Object.assign(document.createElement("div"), { className: "tip-note", textContent: note }));
  document.body.append(tip);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left - 12, innerWidth - tip.offsetWidth - 8));
  const below = r.bottom + 8 + tip.offsetHeight < innerHeight;
  tip.style.left = `${left}px`;
  tip.style.top = `${below ? r.bottom + 8 : r.top - tip.offsetHeight - 8}px`;
}

function hideTip() {
  tip?.remove();
}

function numberControl(spec: OptionSpec, state: OptionValue, onChange: () => void): HTMLElement[] {
  const num = document.createElement("input");
  num.type = "number";
  const range = document.createElement("input");
  range.type = "range";
  for (const el of [num, range]) {
    el.min = String(spec.min ?? 0);
    el.max = String(spec.max ?? 100);
    el.step = String(spec.step ?? 1);
    el.value = String(state.value ?? spec.default ?? 0);
  }
  num.setAttribute("aria-label", spec.label);
  range.setAttribute("aria-label", `${spec.label} slider`);
  range.tabIndex = -1;
  const set = (raw: string, from: HTMLInputElement) => {
    const n = Number(raw);
    if (raw === "" || Number.isNaN(n)) return;
    state.value = n;
    if (from !== num) num.value = raw;
    if (from !== range) range.value = raw;
    onChange();
  };
  num.addEventListener("input", () => set(num.value, num));
  range.addEventListener("input", () => set(range.value, range));
  return [num, range];
}

function colorControl(spec: OptionSpec, state: OptionValue, ctx: OptionsContext): HTMLInputElement {
  const hex = document.createElement("input");
  hex.type = "text";
  hex.className = "hex";
  hex.value = String(state.value ?? spec.default ?? "");
  hex.maxLength = 7;
  hex.spellcheck = false;
  hex.setAttribute("aria-label", `${spec.label} hex`);
  const list = document.createElement("datalist");
  list.id = `history-${spec.flag}`;
  for (const c of ctx.recentColors) list.append(new Option(c));
  hex.setAttribute("list", list.id);
  hex.addEventListener("change", () => {
    const v = hex.value.trim().replace(/^#/, "").toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(v)) {
      hex.classList.add("invalid");
      return;
    }
    hex.classList.remove("invalid");
    hex.value = v;
    state.value = v;
    ctx.onColorPicked(v);
    ctx.onChange();
  });
  queueMicrotask(() => hex.after(list));
  return hex;
}

/** Native color input plus "in last result" and "recent" swatches, anchored under `anchor`. */
function openColorPopover(anchor: HTMLElement, current: string, ctx: OptionsContext, pick: (hex: string) => void) {
  document.querySelector(".popover")?.remove();
  const pop = document.createElement("div");
  pop.className = "popover";
  pop.innerHTML = `
    <div class="pop-row"><input type="color" aria-label="Pick a color" /><code></code></div>
    <div class="pop-title">In last result</div><div class="swatches result"></div>
    <div class="pop-title">Recent</div><div class="swatches recent"></div>`;
  const input = pop.querySelector("input")!;
  const code = pop.querySelector("code")!;
  input.value = `#${current}`;
  code.textContent = current;
  input.addEventListener("input", () => (code.textContent = input.value.slice(1).toUpperCase()));
  input.addEventListener("change", () => done(input.value.slice(1).toUpperCase()));

  const fill = (sel: string, colors: string[], empty: string) => {
    const box = pop.querySelector(sel)!;
    if (!colors.length) box.append(Object.assign(document.createElement("span"), { className: "muted", textContent: empty }));
    for (const c of colors.slice(0, 48)) {
      const b = document.createElement("button");
      b.className = "swatch";
      b.style.background = `#${c}`;
      b.title = c;
      b.setAttribute("aria-label", c);
      b.addEventListener("click", () => done(c));
      box.append(b);
    }
  };
  fill(".result", ctx.resultColors, "Trace an image first");
  fill(".recent", ctx.recentColors, "None yet");

  const close = (e?: PointerEvent) => {
    if (e && pop.contains(e.target as Node)) return;
    pop.remove();
    document.removeEventListener("pointerdown", close);
  };
  const done = (hex: string) => {
    pick(hex);
    close();
  };
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, innerWidth - pop.offsetWidth - 8)}px`;
  pop.style.top = `${r.bottom + 6}px`;
  setTimeout(() => document.addEventListener("pointerdown", close));
}

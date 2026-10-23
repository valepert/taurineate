import { Descriptor, Engine, TracerInfo } from "./api";

export interface ProgramHandlers {
  choose: (engine: Engine) => void;
  automatic: (engine: Engine) => void;
  searchAgain: () => void;
}

const SOURCE_TEXT: Record<string, (t: TracerInfo) => string> = {
  custom: () => "Chosen by you.",
  env: (t) => `From $${t.envVar}.`,
  path: () => "Found on PATH.",
  standard: (t) => `Found in ${t.path!.replace(/\/[^/]+$/, "")}.`,
  loginShell: () => "Found on your login shell's PATH.",
};

/** Only a program that doesn't work counts; a skipped variable or chosen path is just noted on its card. */
export function hasProblem(t: TracerInfo | undefined): boolean {
  return !t?.path;
}

export const WARNING_SIGN = "⚠";

/** The Programs tab: which binary each tracer uses, and how to change it. (Search order and env vars are in the README.) */
export function renderPrograms(root: HTMLElement, descriptors: Descriptor[], tracers: Record<string, TracerInfo>, on: ProgramHandlers) {
  const again = Object.assign(document.createElement("button"), { textContent: "Search again", className: "search-again" });
  again.addEventListener("click", on.searchAgain);
  root.replaceChildren(...descriptors.map((d) => card(d, tracers[d.engine], on)), again);
}

function card(d: Descriptor, t: TracerInfo | undefined, on: ProgramHandlers): HTMLElement {
  const found = !!t?.path;
  const el = document.createElement("article");
  el.className = `program-card${found ? "" : " not-found"}`;

  const title = document.createElement("header");
  title.append(
    Object.assign(document.createElement("strong"), { textContent: d.label }),
    Object.assign(document.createElement("small"), { className: found ? "" : "warn", textContent: found ? t!.version : "not found" }),
  );

  const path = found ? [Object.assign(document.createElement("code"), { className: "tracer-path", textContent: t!.path, title: t!.path })] : [];

  const note = document.createElement("p");
  note.className = "tracer-note";
  const line = (text: string, cls = "") => note.append(Object.assign(document.createElement("span"), { className: cls, textContent: text }));
  if (found && t?.source) line(SOURCE_TEXT[t.source](t));
  for (const w of t?.warnings ?? []) line(w, "skipped");
  if (!found) {
    const install = navigator.userAgent.includes("Mac") ? `brew install ${d.engine}` : `sudo apt install ${d.engine}`;
    line(`Install it with ${install}, or choose the program.`);
  }

  const choose = Object.assign(document.createElement("button"), { textContent: "Choose…" });
  choose.addEventListener("click", () => on.choose(d.engine));
  // Always shown, like Delete settings: disabled while the program is found automatically.
  const auto = Object.assign(document.createElement("button"), {
    textContent: "Use automatic",
    disabled: !t?.customPath,
    title: t?.customPath ? "Forget the chosen program and search automatically" : "Already found automatically",
  });
  auto.addEventListener("click", () => on.automatic(d.engine));
  const actions = document.createElement("div");
  actions.className = "tracer-actions";
  actions.append(choose, auto);

  el.append(title, ...path, note, actions);
  return el;
}

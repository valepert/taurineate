import { TraceResult, formatSize } from "./api";

/** One result pane: header, zoomable viewport, status bar (size · paths · time). */
class ResultPane {
  readonly el: HTMLElement;
  readonly viewport: HTMLElement;
  readonly content: HTMLElement;
  private readonly svgImg: HTMLImageElement;
  private readonly overlayImg: HTMLImageElement;
  private readonly status: HTMLElement;
  private readonly empty: HTMLElement;
  private svgUrl: string | null = null;
  result: TraceResult | null = null;

  constructor(readonly title: string) {
    this.el = document.createElement("section");
    this.el.className = "pane";
    this.el.innerHTML = `
      <header class="pane-head">
        <button class="collapse" title="Collapse / expand" aria-label="Collapse ${title}"></button>
        <span class="pane-title">${title}</span>
      </header>
      <div class="viewport">
        <div class="content"><img class="svg" alt="" /><img class="overlay" alt="" /></div>
        <div class="empty">${title === "Current" ? "Open an image to start" : "The previous result appears here"}</div>
      </div>
      <footer class="status"></footer>`;
    this.viewport = this.el.querySelector(".viewport")!;
    this.content = this.el.querySelector(".content")!;
    this.svgImg = this.el.querySelector("img.svg")!;
    this.overlayImg = this.el.querySelector("img.overlay")!;
    this.status = this.el.querySelector(".status")!;
    this.empty = this.el.querySelector(".empty")!;
    this.el.querySelector(".collapse")!.addEventListener("click", () => {
      this.el.classList.toggle("collapsed");
      this.el.dispatchEvent(new CustomEvent("pane-toggle", { bubbles: true }));
    });
  }

  setResult(result: TraceResult | null) {
    this.result = result;
    if (this.svgUrl) URL.revokeObjectURL(this.svgUrl);
    this.svgUrl = result ? URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" })) : null;
    this.svgImg.src = this.svgUrl ?? "";
    this.svgImg.hidden = !result;
    this.empty.hidden = !!result;
    this.status.textContent = result
      ? `${formatSize(result.bytes)} · ${result.paths.toLocaleString()} ${result.paths === 1 ? "path" : "paths"} · ${result.millis} ms`
      : "";
  }

  setSize(w: number, h: number) {
    for (const img of [this.svgImg, this.overlayImg]) {
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
    }
  }

  setOverlay(url: string | null) {
    this.overlayImg.src = url ?? "";
    this.overlayImg.hidden = !url;
  }
}

/** Current (top) and Previous (bottom), with zoom and pan kept in sync. */
export class Viewer {
  readonly current = new ResultPane("Current");
  readonly previous = new ResultPane("Previous");
  private view = { scale: 1, x: 0, y: 0 };
  private size = { w: 0, h: 0 };
  private menu: HTMLElement;
  onViewSource: (pane: "current" | "previous") => void = () => {};

  constructor(readonly root: HTMLElement) {
    const splitter = document.createElement("div");
    splitter.className = "splitter horizontal";
    root.append(this.current.el, splitter, this.previous.el);
    this.initSplitter(splitter);
    for (const pane of this.panes) this.initPanZoom(pane);
    root.addEventListener("pane-toggle", () => this.layoutRows());

    this.menu = document.createElement("div");
    this.menu.className = "menu";
    this.menu.hidden = true;
    this.menu.innerHTML = `
      <button data-act="in">Zoom in</button>
      <button data-act="out">Zoom out</button>
      <button data-act="reset">Reset</button>
      <hr /><button data-act="source">View source</button>`;
    document.body.append(this.menu);
    document.addEventListener("pointerdown", (e) => {
      if (!this.menu.contains(e.target as Node)) this.menu.hidden = true;
    });
  }

  private get panes() {
    return [this.current, this.previous];
  }

  /** A new result moves the current one down to Previous. */
  push(result: TraceResult) {
    if (this.current.result) this.previous.setResult(this.current.result);
    this.current.setResult(result);
  }

  clear() {
    for (const p of this.panes) p.setResult(null);
  }

  setImage(width: number, height: number) {
    this.size = { w: width, h: height };
    for (const p of this.panes) p.setSize(width, height);
    this.reset();
  }

  setOverlay(url: string | null) {
    this.current.setOverlay(url);
  }

  zoomBy(factor: number, cx?: number, cy?: number) {
    const vp = this.current.viewport.getBoundingClientRect();
    const px = cx ?? vp.width / 2;
    const py = cy ?? vp.height / 2;
    const scale = Math.min(64, Math.max(0.02, this.view.scale * factor));
    const k = scale / this.view.scale;
    this.view = { scale, x: px - (px - this.view.x) * k, y: py - (py - this.view.y) * k };
    this.apply();
  }

  /** Fit the image in the current pane (Delineate's "reset"). */
  reset() {
    const vp = this.current.viewport.getBoundingClientRect();
    if (!this.size.w || !vp.width || !vp.height) return;
    const scale = Math.min(vp.width / this.size.w, vp.height / this.size.h) * 0.95;
    this.view = { scale, x: (vp.width - this.size.w * scale) / 2, y: (vp.height - this.size.h * scale) / 2 };
    this.apply();
  }

  private apply() {
    const { scale, x, y } = this.view;
    for (const p of this.panes) p.content.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  private initPanZoom(pane: ResultPane) {
    const vp = pane.viewport;
    vp.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = vp.getBoundingClientRect();
        this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
    vp.addEventListener("dblclick", () => this.reset());
    vp.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      vp.setPointerCapture(e.pointerId);
      vp.classList.add("dragging");
      let last = { x: e.clientX, y: e.clientY };
      const move = (m: PointerEvent) => {
        this.view.x += m.clientX - last.x;
        this.view.y += m.clientY - last.y;
        last = { x: m.clientX, y: m.clientY };
        this.apply();
      };
      const up = () => {
        vp.classList.remove("dragging");
        vp.removeEventListener("pointermove", move);
        vp.removeEventListener("pointerup", up);
      };
      vp.addEventListener("pointermove", move);
      vp.addEventListener("pointerup", up);
    });
    vp.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openMenu(e.clientX, e.clientY, pane === this.current ? "current" : "previous");
    });
  }

  private openMenu(x: number, y: number, which: "current" | "previous") {
    const m = this.menu;
    m.hidden = false;
    m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 8)}px`;
    m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 8)}px`;
    (m.querySelector('[data-act="source"]') as HTMLButtonElement).disabled = !this[which].result;
    m.onclick = (e) => {
      const act = (e.target as HTMLElement).dataset.act;
      if (!act) return;
      m.hidden = true;
      if (act === "in") this.zoomBy(1.25);
      if (act === "out") this.zoomBy(0.8);
      if (act === "reset") this.reset();
      if (act === "source") this.onViewSource(which);
    };
  }

  /** Drag the splitter between the panes, like Delineate's split pane. */
  private initSplitter(splitter: HTMLElement) {
    splitter.addEventListener("pointerdown", (e) => {
      splitter.setPointerCapture(e.pointerId);
      const rect = this.root.getBoundingClientRect();
      const move = (m: PointerEvent) => {
        const ratio = Math.min(0.85, Math.max(0.15, (m.clientY - rect.top) / rect.height));
        this.root.style.setProperty("--split", `${ratio}`);
        for (const p of this.panes) p.el.classList.remove("collapsed");
        this.layoutRows();
      };
      const up = () => {
        splitter.removeEventListener("pointermove", move);
        splitter.removeEventListener("pointerup", up);
      };
      splitter.addEventListener("pointermove", move);
      splitter.addEventListener("pointerup", up);
    });
  }

  private layoutRows() {
    const [a, b] = this.panes.map((p) => p.el.classList.contains("collapsed"));
    const split = this.root.style.getPropertyValue("--split") || "0.6";
    this.root.style.gridTemplateRows =
      a && b ? "auto 6px auto" : a ? "auto 6px 1fr" : b ? "1fr 6px auto" : `${split}fr 6px ${1 - Number(split)}fr`;
  }
}

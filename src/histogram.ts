const SVG_NS = "http://www.w3.org/2000/svg";
const HEIGHT = 64;

/**
 * Brightness histogram for the potrace threshold. The bars that will be traced are drawn
 * dark: those darker than the threshold, or lighter when invert is on. Click or drag to set it.
 */
export class Histogram {
  private bins: number[] | null = null;
  private threshold = 50;
  private invert = false;
  private readonly svg: SVGSVGElement;
  private readonly bars: SVGRectElement[] = [];
  private readonly marker: SVGLineElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly info: HTMLElement,
    private readonly onPick: (threshold: number) => void,
  ) {
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("viewBox", `0 0 256 ${HEIGHT}`);
    this.svg.setAttribute("preserveAspectRatio", "none");
    for (let i = 0; i < 256; i++) {
      const r = document.createElementNS(SVG_NS, "rect");
      r.setAttribute("x", String(i));
      r.setAttribute("width", "1.05");
      this.bars.push(r);
      this.svg.append(r);
    }
    this.marker = document.createElementNS(SVG_NS, "line");
    this.marker.setAttribute("y1", "0");
    this.marker.setAttribute("y2", String(HEIGHT));
    this.marker.setAttribute("class", "marker");
    this.marker.setAttribute("vector-effect", "non-scaling-stroke");
    this.svg.append(this.marker);
    root.append(this.svg);

    root.addEventListener("pointerdown", (e) => {
      if (!this.bins) return;
      root.setPointerCapture(e.pointerId);
      const pick = (ev: PointerEvent) => {
        const r = root.getBoundingClientRect();
        this.onPick(Math.round(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * 100));
      };
      pick(e);
      const up = () => {
        root.removeEventListener("pointermove", pick);
        root.removeEventListener("pointerup", up);
      };
      root.addEventListener("pointermove", pick);
      root.addEventListener("pointerup", up);
    });
  }

  setBins(bins: number[] | null) {
    this.bins = bins;
    this.root.hidden = !bins;
    // Square-root scale, so a big white background doesn't flatten everything else.
    const max = Math.sqrt(Math.max(1, ...(bins ?? [1])));
    this.bars.forEach((r, i) => {
      const h = bins ? (Math.sqrt(bins[i]) / max) * HEIGHT : 0;
      r.setAttribute("y", String(HEIGHT - h));
      r.setAttribute("height", String(h));
    });
    this.update();
  }

  setThreshold(threshold: number, invert: boolean) {
    this.threshold = threshold;
    this.invert = invert;
    this.update();
  }

  private update() {
    const cutoff = (this.threshold / 100) * 255;
    const traced = (i: number) => (i < cutoff) !== this.invert;
    this.bars.forEach((r, i) => r.setAttribute("class", traced(i) ? "dark" : "light"));
    this.marker.setAttribute("x1", String(cutoff));
    this.marker.setAttribute("x2", String(cutoff));
    if (!this.bins) {
      this.info.textContent = "Open an image to see its brightness histogram.";
      return;
    }
    const total = this.bins.reduce((a, b) => a + b, 0) || 1;
    const count = this.bins.reduce((a, n, i) => (traced(i) ? a + n : a), 0);
    const side = this.invert ? "lighter than the threshold, inverted" : "darker than the threshold";
    this.info.textContent = `${((count / total) * 100).toFixed(1)}% of pixels traced (${side})`;
  }
}

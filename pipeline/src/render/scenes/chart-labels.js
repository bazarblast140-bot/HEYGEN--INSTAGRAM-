// Chart axis labels that never clip. Loaded by board.html (classic script) and
// imported by the tests (side effect: globalThis.ChartLabels). No exports, so
// the same file works in the browser page and in Node.
//
// The 3 Oct preview cut "Operating profit" to "Operating prof": the label was
// sliced to 14 characters and drawn at one fixed size. Now a label keeps every
// character; if it is wider than its bar slot it wraps onto two lines (split at
// the space that balances the lines), and only then shrinks, down to MIN.
(function attach(root) {
  const MAX_SIZE = 26;
  const MIN_SIZE = 16;

  /** Two-line splits of a label at each space, most balanced first. */
  function splits(label, measure, size) {
    const words = String(label).split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 1; i < words.length; i += 1) {
      const a = words.slice(0, i).join(' '); const b = words.slice(i).join(' ');
      out.push({ lines: [a, b], width: Math.max(measure(a, size), measure(b, size)) });
    }
    return out.sort((x, y) => x.width - y.width);
  }

  /**
   * { lines, size } so that every line is at most maxWidth wide.
   * measure(str, size) → pixel width. One line is preferred, then two lines,
   * at the largest size from `size` down to MIN_SIZE.
   */
  function fitLabel(label, maxWidth, measure, { size = MAX_SIZE, min = MIN_SIZE } = {}) {
    const str = String(label ?? '').trim();
    if (!str) return { lines: [''], size };
    for (let s = size; s >= min; s -= 1) {
      if (measure(str, s) <= maxWidth) return { lines: [str], size: s };
      const best = splits(str, measure, s)[0];
      if (best && best.width <= maxWidth) return { lines: best.lines, size: s };
    }
    const best = splits(str, measure, min)[0];
    return { lines: best ? best.lines : [str], size: min, overflow: true };
  }

  root.ChartLabels = { fitLabel, MAX_SIZE, MIN_SIZE };
}(typeof window !== 'undefined' ? window : globalThis));

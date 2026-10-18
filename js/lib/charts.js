// @ts-check
/**
 * `charts.js` — the two dependency-free chart helpers a Game's own statistics view draws with:
 * a cumulative `sparkline()` and a horizontal `bars()` row.
 *
 * Both are pure functions of plain numbers and both return an inline-SVG **string** — no charting
 * library, no DOM access, no global state, nothing to configure beyond a size. A Game computed its
 * own numbers, from data only it understands, and hands them over here; that is the whole
 * interface. It pulls nothing in and touches nothing outside its own arguments, which is also why
 * it runs unchanged inside Node and in a browser.
 *
 * Every chart is `aria-hidden="true"` and carries no text: it is decoration for a number, never the
 * only carrier of meaning. The caller appends it next to a written summary ("78% · ▲6") and reads
 * the chart as a shape, not as the data. A caller draws it inside a node it already sized — `.spark`
 * carries its height in `styles.css` and `.bars` carries it as an attribute (one `h`-tall rect per
 * value) — so nothing here guesses at a layout it cannot see.
 */

/**
 * A cumulative line over `vals`, or `''` when there are fewer than two — one point is not a line,
 * so the caller's text summary carries that case instead of a chart.
 *
 * A flat series (every value equal) draws a straight line along the bottom: the span falls back to
 * `1` so the division can never produce `NaN` or a zero-height viewBox.
 *
 * @param {number[]} vals
 * @param {{ w?: number, h?: number }} [options]
 * @returns {string}
 */
export function sparkline(vals, { w = 300, h = 56 } = {}) {
  if (!Array.isArray(vals) || vals.length < 2) return '';
  const lo = Math.min(...vals);
  const span = Math.max(...vals) - lo || 1;
  const x = (/** @type {number} */ i) => ((i / (vals.length - 1)) * w).toFixed(1);
  const y = (/** @type {number} */ v) => (h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1);
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  return (
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark" aria-hidden="true">` +
    `<polyline fill="none" stroke="currentColor" stroke-width="2" ` +
    `vector-effect="non-scaling-stroke" stroke-linejoin="round" points="${pts}"/></svg>`
  );
}

/**
 * One horizontal bar per value, stacked top to bottom — the caller owns the order (weakest first,
 * in the documented statistics view). `min`/`max` map the value range onto the full width, so the
 * default `0..100` draws a percentage directly; a value outside the range clamps to an empty or
 * full bar instead of escaping the viewBox. An empty range (`max === min`) draws a full bar for
 * anything at or above the ceiling rather than dividing by zero.
 *
 * @param {number[]} vals
 * @param {{ w?: number, h?: number, gap?: number, min?: number, max?: number }} [options]
 * @returns {string}
 */
export function bars(vals, { w = 240, h = 6, gap = 8, min = 0, max = 100 } = {}) {
  if (!Array.isArray(vals) || vals.length === 0) return '';
  const span = max - min;
  const total = vals.length * h + (vals.length - 1) * gap;
  const rects = vals
    .map((v, i) => {
      const raw = span > 0 ? (v - min) / span : v >= max ? 1 : 0;
      const ratio = Math.min(1, Math.max(0, raw));
      const width = (ratio * w).toFixed(1);
      return `<rect x="0" y="${i * (h + gap)}" width="${width}" height="${h}" rx="3"/>`;
    })
    .join('');
  return (
    `<svg viewBox="0 0 ${w} ${total}" preserveAspectRatio="none" height="${total}" ` +
    `class="bars" fill="currentColor" aria-hidden="true">${rects}</svg>`
  );
}

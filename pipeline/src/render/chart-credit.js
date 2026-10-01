/** Source and date printed on a chart. Sample data stays labelled as sample. */
export function chartCredit(series, summary) {
  if (series?.synthetic) return 'SAMPLE DATA';
  const source = series?.source || 'market data';
  const date = summary?.date || '';
  return date ? `${source} · ${date}` : source;
}

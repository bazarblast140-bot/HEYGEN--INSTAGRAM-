// Reviewer edits to a generated carousel, applied with no model call.
//
// A preview run is reviewed; the reviewer asks for small, exact changes (swap
// one chart, change one caption word). The spec that run generated is
// re-rendered with these edits and goes through the full quality gate again.
// Every edit must hit its target exactly, or the re-render stops: an edit that
// silently matched nothing would publish something nobody reviewed.
//
// Edit file (JSON):
//   { "edits": [
//       { "op": "calc", "slide": 8, "calc": { "type": "contribution_split", ... } },
//       { "op": "text", "slide": 3, "field": "headline", "value": "..." },
//       { "op": "caption_replace", "from": "उछला", "to": "बढ़ गया" },
//       { "op": "cover_photo", "queries": [...], "mustHave": [...], "avoid": [...] } ] }

const FIELDS = new Set(['headline', 'subline']);

function slideAt(spec, n) {
  const i = Number(n) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= (spec.slides || []).length) throw new Error(`edit names slide ${n}, which does not exist`);
  return i;
}

/** { spec, applied: [human-readable lines] }. Throws on any edit that does not apply. */
export function applyEdits(spec, edits = []) {
  const list = Array.isArray(edits) ? edits : edits?.edits;
  if (!Array.isArray(list)) throw new Error('edits must be a list (or { "edits": [...] })');
  let out = { ...spec, slides: (spec.slides || []).map((s) => ({ ...s })) };
  const applied = [];
  for (const e of list) {
    if (e?.op === 'calc') {
      const i = slideAt(out, e.slide);
      if (!e.calc || typeof e.calc !== 'object' || !e.calc.type) throw new Error(`slide ${e.slide}: calc edit needs a calc with a type`);
      if (out.slides[i].cta || i === 0) throw new Error(`slide ${e.slide} is the cover or the follow card — it carries no calc`);
      const before = out.slides[i].calc?.type || 'none';
      out.slides[i].calc = { ...e.calc };
      applied.push(`slide ${e.slide}: calc ${before} → ${e.calc.type}`);
    } else if (e?.op === 'text') {
      const i = slideAt(out, e.slide);
      if (!FIELDS.has(e.field)) throw new Error(`slide ${e.slide}: text edit field must be headline or subline`);
      if (typeof e.value !== 'string' || !e.value.trim()) throw new Error(`slide ${e.slide}: text edit needs a value`);
      out.slides[i][e.field] = e.value;
      applied.push(`slide ${e.slide}: ${e.field} → "${e.value}"`);
    } else if (e?.op === 'caption_replace') {
      const cap = String(out.caption || '');
      if (!e.from || !cap.includes(e.from)) throw new Error(`caption does not contain "${e.from}"`);
      out = { ...out, caption: cap.split(e.from).join(String(e.to ?? '')) };
      applied.push(`caption: "${e.from}" → "${e.to}"`);
    } else if (e?.op === 'cover_photo') {
      const queries = (Array.isArray(e.queries) ? e.queries : []).filter((q) => typeof q === 'string' && q.trim());
      if (!queries.length) throw new Error('cover_photo edit needs at least one query');
      out = { ...out, coverPhoto: { queries, mustHave: e.mustHave || [], avoid: e.avoid || [] } };
      applied.push(`cover photo: search ${queries.map((q) => `"${q}"`).join(', ')}`);
    } else {
      throw new Error(`unknown edit op "${e?.op}" — use calc, text, caption_replace or cover_photo`);
    }
  }
  return { spec: out, applied };
}

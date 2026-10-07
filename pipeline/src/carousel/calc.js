// Every financial figure on a carousel is computed here, never by the model.
//
// The model returns structured inputs per slide ({ type: 'emi', principal,
// rate, years }); this module turns them into figures (EMI, total interest,
// SIP value, CAGR ...), a chart the renderer can draw, and a footnote that is
// literally true ("Calculation: standard EMI formula"). The live post that
// prompted this said "₹50 लाख, 8.5%, 20 साल ... कुल ब्याज लगभग ₹52 लाख";
// the formula says ₹54.14 लाख, and nothing in the pipeline could tell.
//
// Formulas (standard, no rounding until display):
//   EMI      = P·r·(1+r)^n / ((1+r)^n − 1),   r = annual% / 12 / 100, n = months
//   SIP FV   = M·((1+i)^n − 1)/i·(1+i)        (payment at the start of each month)
//   Lump sum = A·(1+r)^y
//   CAGR     = (end/start)^(1/y) − 1
//   Real value after inflation = A / (1+r)^y
//   Recovery after a loss L    = 1/(1−L) − 1

/** Footnote for a compare chart (news: values from the fetched items; finance: from the worked example). */
export const COMPARE_NOTE = 'Calculation: gap and ratio computed from the values shown';
export const EXAMPLE_COMPARE_NOTE = 'Calculation: every value computed from the worked example; gap and ratio computed';

export const UNITS = { INR: '₹', PCT: '%', NUM: '', YEARS: 'years', MONTHS: 'months' };

const num = (v) => (typeof v === 'string' ? Number(v.replace(/[,₹\s%]/g, '')) : Number(v));
const finite = (v) => Number.isFinite(v);

export function emi(principal, annualRate, years) {
  const P = num(principal);
  const n = Math.round(num(years) * 12);
  const r = num(annualRate) / 12 / 100;
  if (!(P > 0) || !(n > 0) || !(r >= 0)) throw new Error('emi needs principal > 0, rate >= 0, years > 0');
  if (r === 0) return P / n;
  const g = (1 + r) ** n;
  return (P * r * g) / (g - 1);
}

/** Month-by-month schedule; yearly rows for charts. */
export function amortization(principal, annualRate, years) {
  const P = num(principal);
  const n = Math.round(num(years) * 12);
  const r = num(annualRate) / 12 / 100;
  const pay = emi(P, annualRate, years);
  let balance = P;
  const yearly = [];
  let yi = 0;
  let yp = 0;
  for (let m = 1; m <= n; m += 1) {
    const interest = balance * r;
    const principalPart = pay - interest;
    balance = Math.max(0, balance - principalPart);
    yi += interest;
    yp += principalPart;
    if (m % 12 === 0 || m === n) {
      yearly.push({ year: Math.ceil(m / 12), interest: yi, principal: yp, balance });
      yi = 0;
      yp = 0;
    }
  }
  return { emi: pay, months: n, yearly };
}

export function sipFutureValue(monthly, annualRate, years) {
  const M = num(monthly);
  const n = Math.round(num(years) * 12);
  const i = num(annualRate) / 12 / 100;
  if (!(M > 0) || !(n > 0) || !(i >= 0)) throw new Error('sip needs monthly > 0, rate >= 0, years > 0');
  if (i === 0) return M * n;
  return M * (((1 + i) ** n - 1) / i) * (1 + i);
}

export const lumpsum = (amount, rate, years) => num(amount) * (1 + num(rate) / 100) ** num(years);
export const cagr = (start, end, years) => ((num(end) / num(start)) ** (1 / num(years)) - 1) * 100;
export const realValue = (amount, rate, years) => num(amount) / (1 + num(rate) / 100) ** num(years);
export const pctChange = (from, to) => ((num(to) - num(from)) / num(from)) * 100;
export const recoveryNeeded = (lossPct) => (1 / (1 - num(lossPct) / 100) - 1) * 100;

// ---------------------------------------------------------------- formatting

const IN = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** ₹43,391 · ₹54.14 लाख · ₹1.2 करोड़ — Indian grouping, lakh/crore words. */
export function formatINR(value, { words = true } = {}) {
  const v = Number(value);
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (words && a >= 1e7) return `${sign}₹${trim(a / 1e7, 2)} करोड़`;
  if (words && a >= 1e5) return `${sign}₹${trim(a / 1e5, 2)} लाख`;
  return `${sign}₹${IN.format(Math.round(a))}`;
}

export function formatPct(value, digits = 1) {
  return `${trim(Number(value), digits)}%`;
}

function trim(v, digits) {
  return Number(v.toFixed(digits)).toString();
}

/** Short axis labels: 5L, 1.2Cr, 40K. Latin only, always fits. */
export function shortINR(value) {
  const a = Math.abs(Number(value));
  const sign = value < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}₹${trim(a / 1e7, 1)}Cr`;
  if (a >= 1e5) return `${sign}₹${trim(a / 1e5, 1)}L`;
  if (a >= 1e3) return `${sign}₹${trim(a / 1e3, 1)}K`;
  return `${sign}₹${Math.round(a)}`;
}

// ---------------------------------------------------------------- calc types

const fig = (key, label, value, unit, text) => ({ key, label, value, unit, text });
const inr = (key, label, value) => fig(key, label, value, UNITS.INR, formatINR(value));
const pct = (key, label, value, d = 1) => fig(key, label, value, UNITS.PCT, formatPct(value, d));
const plain = (key, label, value, unit = UNITS.NUM, text) => fig(key, label, value, unit, text ?? String(value));

function need(calc, ...keys) {
  const missing = keys.filter((k) => !finite(num(calc[k])));
  if (missing.length) throw new Error(`${calc.type} needs ${missing.join(', ')}`);
}

function range(name, v, lo, hi) {
  if (!(v >= lo && v <= hi)) throw new Error(`${name} ${v} is outside ${lo}–${hi}`);
}

const TYPES = {
  emi(c) {
    need(c, 'principal', 'rate', 'years');
    const P = num(c.principal); const R = num(c.rate); const Y = num(c.years);
    range('rate', R, 0.1, 40); range('years', Y, 0.5, 40); range('principal', P, 1000, 1e10);
    const { emi: e, months, yearly } = amortization(P, R, Y);
    const total = e * months;
    const interest = total - P;
    const view = ['balance', 'yearly', 'split'].includes(c.view) ? c.view : 'split';
    const chart = view === 'balance'
      ? { kind: 'line', title: 'Outstanding loan balance', xLabel: 'year', unit: 'INR',
        series: [{ name: 'balance', color: 'blue', points: [[0, P], ...yearly.map((y) => [y.year, y.balance])] }] }
      : view === 'yearly'
        ? { kind: 'stackbars', title: 'Har saal EMI: interest vs principal', unit: 'INR',
          labels: yearly.map((y) => `Y${y.year}`),
          stacks: [{ name: 'interest', color: 'red', values: yearly.map((y) => y.interest) },
            { name: 'principal', color: 'green', values: yearly.map((y) => y.principal) }] }
        : { kind: 'split', title: 'Total payment split', unit: 'INR',
          parts: [{ name: 'Loan amount', color: 'blue', value: P }, { name: 'Interest', color: 'red', value: interest }] };
    return {
      inputs: [inr('principal', 'Loan', P), pct('rate', 'Interest rate', R, 2), plain('years', 'Tenure', Y, UNITS.YEARS, `${Y} saal`)],
      figures: [
        inr('emi', 'EMI', e), inr('totalInterest', 'Total interest', interest), inr('totalPayment', 'Total payment', total),
        plain('months', 'EMIs', months, UNITS.MONTHS), pct('interestShare', 'Interest share', (interest / total) * 100),
        pct('interestToLoan', 'Interest vs loan', (interest / P) * 100),
        inr('firstYearInterest', 'Year-1 interest', yearly[0].interest), inr('firstYearPrincipal', 'Year-1 principal', yearly[0].principal),
      ],
      highlight: ['emi', 'totalInterest', 'totalPayment'],
      chart,
      note: 'Calculation: standard EMI formula (monthly reducing balance)',
    };
  },
  emi_compare(c) {
    need(c, 'principal', 'rate');
    const P = num(c.principal); const R = num(c.rate);
    const years = (Array.isArray(c.years) ? c.years : [c.years]).map(num).filter(finite).slice(0, 4);
    if (years.length < 2) throw new Error('emi_compare needs years: [15, 20, ...] (2–4 tenures)');
    range('rate', R, 0.1, 40); years.forEach((y) => range('years', y, 0.5, 40));
    const rows = years.map((y) => { const e = emi(P, R, y); return { y, emi: e, interest: e * Math.round(y * 12) - P }; });
    return {
      inputs: [inr('principal', 'Loan', P), pct('rate', 'Interest rate', R, 2),
        ...years.map((y, i) => plain(`years${i}`, 'Tenure', y, UNITS.YEARS, `${y} saal`))],
      figures: rows.flatMap((r, i) => [inr(`emi${i}`, `EMI ${r.y}y`, r.emi), inr(`interest${i}`, `Interest ${r.y}y`, r.interest),
        plain(`months${i}`, `EMIs ${r.y}y`, Math.round(r.y * 12), UNITS.MONTHS)])
        .concat([inr('interestSaved', 'Interest difference', Math.max(...rows.map((r) => r.interest)) - Math.min(...rows.map((r) => r.interest))),
          inr('emiDifference', 'EMI difference', Math.max(...rows.map((r) => r.emi)) - Math.min(...rows.map((r) => r.emi)))]),
      highlight: ['emi0', `emi${rows.length - 1}`, 'interestSaved'],
      chart: { kind: 'groupbars', title: 'Tenure vs total interest', unit: 'INR', labels: rows.map((r) => `${r.y} yrs`),
        groups: [{ name: 'total interest', color: 'red', values: rows.map((r) => r.interest) }] },
      note: 'Calculation: standard EMI formula (monthly reducing balance) for each tenure',
    };
  },
  operating_leverage(c) {
    need(c, 'sales', 'variableCost', 'fixedCost', 'salesChangePct');
    const S = num(c.sales); const V = num(c.variableCost); const F = num(c.fixedCost); const ch = num(c.salesChangePct);
    range('salesChangePct', ch, -90, 300);
    const C = S - V; const E = C - F;
    if (!(S > 0) || !(V >= 0) || !(F >= 0)) throw new Error('operating_leverage needs sales > 0, costs >= 0');
    if (!(E > 0)) throw new Error('operating_leverage needs operating profit (sales − variable − fixed) > 0');
    const dol = C / E; const profitChange = ch * dol;
    const newSales = S * (1 + ch / 100); const newEbit = C * (1 + ch / 100) - F;
    const unit = c.unit === 'INR' ? UNITS.INR : UNITS.NUM;
    const val = (k, l, v) => (unit === UNITS.INR ? inr(k, l, v) : plain(k, l, v, UNITS.NUM, trim(v, 2)));
    return {
      inputs: [val('sales', 'Sales', S), val('variableCost', 'Variable cost', V), val('fixedCost', 'Fixed cost', F), pct('salesChangePct', 'Sales change', ch, 2)],
      figures: [val('contribution', 'Contribution', C), val('ebit', 'Operating profit', E), plain('dol', 'Operating leverage', dol, UNITS.NUM, `${trim(dol, 2)}x`),
        pct('profitChangePct', 'Profit change', profitChange), val('newSales', 'New sales', newSales), val('newEbit', 'New operating profit', newEbit),
        pct('contributionMargin', 'Contribution margin', (C / S) * 100), pct('ebitMargin', 'Operating margin', (E / S) * 100),
        val('totalCost', 'Total cost', V + F), val('newTotalCost', 'New total cost', V * (1 + ch / 100) + F)],
      highlight: ['salesChangePct', 'dol', 'profitChangePct'],
      chart: { kind: 'bars', title: 'Sales change vs operating profit change', unit: 'PCT', labels: ['Sales', 'Operating profit'],
        values: [ch, profitChange], colors: [ch >= 0 ? 'blue' : 'red', profitChange >= 0 ? 'green' : 'red'] },
      note: 'Calculation: operating leverage = contribution ÷ operating profit; profit change = sales change × leverage',
    };
  },
  // Where the contribution goes: fixed cost first, operating profit is what is
  // left. contribution = sales − variable cost; profit = contribution − fixed.
  contribution_split(c) {
    need(c, 'sales', 'variableCost', 'fixedCost');
    const S = num(c.sales); const V = num(c.variableCost); const F = num(c.fixedCost);
    if (!(S > 0) || !(V >= 0) || !(F >= 0)) throw new Error('contribution_split needs sales > 0, costs >= 0');
    const C = S - V; const E = C - F;
    if (!(C > 0)) throw new Error('contribution_split needs contribution (sales − variable cost) > 0');
    if (!(E >= 0)) throw new Error('contribution_split needs operating profit (contribution − fixed cost) >= 0');
    const unit = c.unit === 'INR' ? UNITS.INR : UNITS.NUM;
    const val = (k, l, v) => (unit === UNITS.INR ? inr(k, l, v) : plain(k, l, v, UNITS.NUM, trim(v, 2)));
    return {
      inputs: [val('sales', 'Sales', S), val('variableCost', 'Variable cost', V), val('fixedCost', 'Fixed cost', F)],
      figures: [val('contribution', 'Contribution', C), val('ebit', 'Operating profit', E),
        pct('fixedSharePct', 'Fixed cost share', (F / C) * 100), pct('profitSharePct', 'Profit share', (E / C) * 100)],
      highlight: ['contribution', 'fixedCost', 'ebit'],
      chart: { kind: 'stackbars', title: 'Where contribution goes', unit: unit === UNITS.INR ? 'INR' : 'NUM', labels: ['Contribution'],
        stacks: [{ name: 'Fixed cost', color: 'red', values: [F] }, { name: 'Operating profit', color: 'green', values: [E] }] },
      note: 'Calculation: contribution = sales − variable cost; operating profit = contribution − fixed cost',
    };
  },
  margin(c) {
    need(c, 'revenue', 'cost');
    const Rv = num(c.revenue); const Co = num(c.cost);
    if (!(Rv > 0) || !(Co >= 0)) throw new Error('margin needs revenue > 0, cost >= 0');
    const unit = c.unit === 'INR' ? UNITS.INR : UNITS.NUM;
    const val = (k, l, v) => (unit === UNITS.INR ? inr(k, l, v) : plain(k, l, v, UNITS.NUM, trim(v, 2)));
    const P = Rv - Co;
    return {
      inputs: [val('revenue', String(c.revenueLabel || 'Revenue').slice(0, 18), Rv), val('cost', String(c.costLabel || 'Cost').slice(0, 18), Co)],
      figures: [val('profit', 'Profit', P), pct('marginPct', 'Margin', (P / Rv) * 100)],
      highlight: ['revenue', 'profit', 'marginPct'],
      chart: { kind: 'split', title: 'Where each rupee of revenue goes', unit: unit === UNITS.INR ? 'INR' : 'NUM',
        parts: [{ name: String(c.costLabel || 'Cost').slice(0, 18), color: 'red', value: Co }, { name: 'Profit', color: 'green', value: Math.max(P, 0) }] },
      note: 'Calculation: margin = (revenue − cost) ÷ revenue',
    };
  },
  sip(c) {
    need(c, 'monthly', 'rate', 'years');
    const M = num(c.monthly); const R = num(c.rate); const Y = num(c.years);
    range('rate', R, 0, 30); range('years', Y, 1, 50); range('monthly', M, 100, 1e8);
    const points = []; const invested = [];
    for (let y = 0; y <= Y; y += 1) {
      points.push([y, y === 0 ? 0 : sipFutureValue(M, R, y)]);
      invested.push([y, M * 12 * y]);
    }
    const fv = sipFutureValue(M, R, Y); const inv = M * 12 * Y;
    return {
      inputs: [inr('monthly', 'Monthly SIP', M), pct('rate', 'Assumed return', R, 2), plain('years', 'Years', Y, UNITS.YEARS, `${Y} saal`)],
      figures: [inr('value', 'Final value', fv), inr('invested', 'Invested', inv), inr('gain', 'Gain', fv - inv),
        plain('months', 'Installments', Y * 12, UNITS.MONTHS), pct('gainPct', 'Gain vs invested', ((fv - inv) / inv) * 100)],
      highlight: ['invested', 'value', 'gain'],
      chart: { kind: 'line', title: 'SIP growth', xLabel: 'year', unit: 'INR',
        series: [{ name: 'value', color: 'green', points }, { name: 'invested', color: 'muted', points: invested }] },
      note: `Calculation: SIP future value, monthly compounding at an assumed ${formatPct(R, 2)} a year (not guaranteed)`,
    };
  },
  lumpsum(c) {
    need(c, 'amount', 'rate', 'years');
    const A = num(c.amount); const R = num(c.rate); const Y = num(c.years);
    range('rate', R, -50, 50); range('years', Y, 1, 60);
    const points = []; for (let y = 0; y <= Y; y += 1) points.push([y, lumpsum(A, R, y)]);
    const fv = lumpsum(A, R, Y);
    return {
      inputs: [inr('amount', 'Amount', A), pct('rate', 'Rate', R, 2), plain('years', 'Years', Y, UNITS.YEARS, `${Y} saal`)],
      figures: [inr('value', 'Final value', fv), inr('gain', 'Gain', fv - A), plain('multiple', 'Multiple', fv / A, UNITS.NUM, `${trim(fv / A, 2)}x`),
        pct('gainPct', 'Gain', ((fv - A) / A) * 100)],
      highlight: ['amount', 'value', 'multiple'],
      chart: { kind: 'line', title: 'Compounding', xLabel: 'year', unit: 'INR', series: [{ name: 'value', color: 'green', points }] },
      note: `Calculation: compound growth at ${formatPct(R, 2)} a year`,
    };
  },
  // Expense ratio: the same money at the same gross return, minus two expense
  // ratios (e.g. 1% regular vs 0.2% direct). Code computes the net returns,
  // both final values and the gap; the model only names the inputs.
  expense_ratio(c) {
    need(c, 'rate', 'years');
    const sip = finite(num(c.monthly)) && !finite(num(c.amount));
    const base = sip ? num(c.monthly) : num(c.amount);
    if (!finite(base)) throw new Error('expense_ratio needs amount (lumpsum) or monthly (SIP)');
    const R = num(c.rate); const Y = num(c.years);
    const exp = (Array.isArray(c.expenses) ? c.expenses : [c.expense0, c.expense1]).map(num).filter(finite).slice(0, 3);
    if (exp.length < 2) throw new Error('expense_ratio needs expenses: [higher, lower] (percent a year)');
    range('rate', R, 1, 30); range('years', Y, 1, 50); range(sip ? 'monthly' : 'amount', base, 100, 1e10);
    exp.forEach((e) => range('expense ratio', e, 0, 3));
    if (new Set(exp).size !== exp.length) throw new Error('expense ratios must differ');
    const grow = (net, y) => (sip ? (y === 0 ? 0 : sipFutureValue(base, net, y)) : lumpsum(base, net, y));
    const nets = exp.map((e) => R - e);
    const values = nets.map((n) => grow(n, Y));
    const hi = values.indexOf(Math.max(...values)); const lo = values.indexOf(Math.min(...values));
    const tag = (e) => `${trim(e, 2)}% expense`;
    const series = exp.map((e, i) => {
      const points = []; for (let y = 0; y <= Y; y += 1) points.push([y, grow(nets[i], y)]);
      return { name: tag(e), color: i === lo ? 'red' : i === hi ? 'green' : 'blue', points };
    });
    const invested = sip ? base * 12 * Y : base;
    return {
      inputs: [inr(sip ? 'monthly' : 'amount', sip ? 'Monthly SIP' : 'Amount', base), pct('rate', 'Gross return', R, 2),
        plain('years', 'Years', Y, UNITS.YEARS, `${Y} saal`), ...exp.map((e, i) => pct(`expense${i}`, 'Expense ratio', e, 2))],
      figures: [...nets.map((n, i) => pct(`net${i}`, 'Net return', n, 2)),
        ...values.map((v, i) => inr(`value${i}`, `Value @${trim(exp[i], 2)}%`, v)),
        inr('gap', 'Difference', values[hi] - values[lo]), pct('gapPct', 'Extra corpus', ((values[hi] - values[lo]) / values[lo]) * 100),
        inr('invested', 'Invested', invested)],
      highlight: [`value${lo}`, `value${hi}`, 'gap'],
      chart: { kind: 'line', title: 'Expense ratio ka asar', xLabel: 'year', unit: 'INR', series },
      note: `Calculation: ${sip ? 'SIP future value' : 'compound growth'} at (assumed ${formatPct(R, 2)} − expense ratio) a year (not guaranteed)`,
    };
  },
  cagr(c) {
    need(c, 'start', 'end', 'years');
    const S = num(c.start); const E = num(c.end); const Y = num(c.years);
    if (!(S > 0 && E > 0)) throw new Error('cagr needs start and end > 0');
    range('years', Y, 0.5, 100);
    const g = cagr(S, E, Y);
    const unit = c.unit === 'points' ? UNITS.NUM : UNITS.INR;
    const val = (k, l, v) => (unit === UNITS.INR ? inr(k, l, v) : plain(k, l, v, UNITS.NUM, IN.format(Math.round(v))));
    const points = []; for (let y = 0; y <= Math.ceil(Y); y += 1) points.push([Math.min(y, Y), S * (1 + g / 100) ** Math.min(y, Y)]);
    return {
      inputs: [val('start', 'Start', S), val('end', 'End', E), plain('years', 'Years', Y, UNITS.YEARS, `${Y} saal`)],
      figures: [pct('cagr', 'CAGR', g), pct('totalChange', 'Total change', pctChange(S, E)), plain('multiple', 'Multiple', E / S, UNITS.NUM, `${trim(E / S, 2)}x`)],
      highlight: ['start', 'end', 'cagr'],
      chart: { kind: 'line', title: 'CAGR path', xLabel: 'year', unit: unit === UNITS.INR ? 'INR' : 'NUM', series: [{ name: 'path', color: 'green', points }] },
      note: 'Calculation: CAGR = (end/start)^(1/years) − 1',
    };
  },
  inflation(c) {
    need(c, 'amount', 'rate', 'years');
    const A = num(c.amount); const R = num(c.rate); const Y = num(c.years);
    range('rate', R, 0, 30); range('years', Y, 1, 60);
    const points = []; for (let y = 0; y <= Y; y += 1) points.push([y, realValue(A, R, y)]);
    const real = realValue(A, R, Y); const future = lumpsum(A, R, Y);
    return {
      inputs: [inr('amount', 'Amount', A), pct('rate', 'Inflation', R, 2), plain('years', 'Years', Y, UNITS.YEARS, `${Y} saal`)],
      figures: [inr('realValue', 'Value in today\'s money', real), inr('futureCost', 'Future cost', future),
        pct('powerLost', 'Purchasing power lost', ((A - real) / A) * 100)],
      highlight: ['amount', 'realValue', 'futureCost'],
      chart: { kind: 'line', title: 'Purchasing power', xLabel: 'year', unit: 'INR', series: [{ name: 'real value', color: 'red', points }] },
      note: `Calculation: value ÷ (1 + ${formatPct(R, 2)})^years`,
    };
  },
  change(c) {
    need(c, 'from', 'to');
    const F = num(c.from); const T = num(c.to);
    if (!(F !== 0)) throw new Error('change needs from ≠ 0');
    const unit = c.unit === 'INR' ? UNITS.INR : c.unit === '%' ? UNITS.PCT : UNITS.NUM;
    const mk = (k, l, v) => (unit === UNITS.INR ? inr(k, l, v) : unit === UNITS.PCT ? pct(k, l, v, 2) : plain(k, l, v, UNITS.NUM, trim(v, 2)));
    const labels = [String(c.fromLabel || 'Before').slice(0, 18), String(c.toLabel || 'After').slice(0, 18)];
    const points = unit === UNITS.PCT;
    return {
      inputs: [mk('from', labels[0], F), mk('to', labels[1], T)],
      figures: [pct('changePct', 'Change', pctChange(F, T)),
        points ? plain('difference', 'Change (pts)', T - F, UNITS.NUM, `${T - F >= 0 ? '+' : ''}${trim(T - F, 2)} pts`) : mk('difference', 'Difference', T - F)],
      highlight: ['from', 'to', points ? 'difference' : 'changePct'],
      chart: { kind: 'bars', title: c.title || 'Change', unit: unit === UNITS.INR ? 'INR' : unit === UNITS.PCT ? 'PCT' : 'NUM',
        labels, values: [F, T], colors: ['muted', T >= F ? 'green' : 'red'] },
      note: 'Calculation: change = (new − old) ÷ old',
    };
  },
  drawdown(c) {
    const losses = (Array.isArray(c.losses) ? c.losses : [c.loss]).map(num).filter(finite);
    if (!losses.length) throw new Error('drawdown needs loss (percent)');
    losses.forEach((l) => range('loss', l, 1, 95));
    const rec = losses.map(recoveryNeeded);
    return {
      inputs: losses.map((l, i) => pct(`loss${i}`, 'Loss', l, 1)),
      figures: rec.map((r, i) => pct(`recovery${i}`, 'Gain needed to recover', r, 1)),
      highlight: [`loss${losses.length - 1}`, `recovery${losses.length - 1}`],
      chart: { kind: 'groupbars', title: 'Loss vs gain needed to recover', unit: 'PCT',
        labels: losses.map((l) => `-${trim(l, 1)}%`),
        groups: [{ name: 'loss', color: 'red', values: losses }, { name: 'gain needed', color: 'green', values: rec }] },
      note: 'Calculation: gain needed = 1 ÷ (1 − loss) − 1',
    };
  },
  position(c) {
    need(c, 'capital', 'riskPct', 'entry', 'stop');
    const C = num(c.capital); const RP = num(c.riskPct); const E = num(c.entry); const S = num(c.stop);
    range('riskPct', RP, 0.1, 10);
    const per = Math.abs(E - S);
    if (!(per > 0)) throw new Error('position needs entry ≠ stop');
    const risk = (C * RP) / 100; const qty = Math.floor(risk / per); const value = qty * E;
    return {
      inputs: [inr('capital', 'Capital', C), pct('riskPct', 'Risk per trade', RP, 2), inr('entry', 'Entry', E), inr('stop', 'Stop-loss', S)],
      figures: [inr('riskAmount', 'Max risk', risk), inr('perShare', 'Risk per share', per), plain('qty', 'Quantity', qty, UNITS.NUM, `${qty}`),
        inr('positionValue', 'Position value', value), pct('positionPct', 'Of capital', (value / C) * 100)],
      highlight: ['riskAmount', 'qty', 'positionValue'],
      chart: { kind: 'bars', title: 'Capital vs position vs risk', unit: 'INR', labels: ['Capital', 'Position', 'Max risk'],
        values: [C, value, risk], colors: ['muted', 'blue', 'red'] },
      note: 'Calculation: quantity = (capital × risk%) ÷ (entry − stop)',
    };
  },
  expectancy(c) {
    need(c, 'winRate', 'reward', 'risk');
    const W = num(c.winRate); const RW = num(c.reward); const RK = num(c.risk);
    range('winRate', W, 1, 99);
    const exp = (W / 100) * RW - (1 - W / 100) * RK;
    const be = (RK / (RK + RW)) * 100;
    return {
      inputs: [pct('winRate', 'Win rate', W, 1), plain('reward', 'Reward', RW), plain('risk', 'Risk', RK)],
      figures: [plain('expectancy', 'Expectancy per trade', exp, UNITS.NUM, trim(exp, 2)), pct('breakevenWinRate', 'Break-even win rate', be)],
      highlight: ['winRate', 'breakevenWinRate', 'expectancy'],
      chart: { kind: 'bars', title: 'Win rate vs break-even', unit: 'PCT', labels: ['Win rate', 'Break-even'], values: [W, be], colors: [W >= be ? 'green' : 'red', 'muted'] },
      note: 'Calculation: expectancy = win% × reward − loss% × risk',
    };
  },
  option(c) {
    need(c, 'strike', 'premium');
    const K = num(c.strike); const Pm = num(c.premium); const lot = finite(num(c.lot)) && num(c.lot) > 0 ? num(c.lot) : 1;
    const side = ['long_call', 'long_put'].includes(c.kind) ? c.kind : 'long_call';
    const call = side === 'long_call';
    const pay = (s) => ((call ? Math.max(0, s - K) : Math.max(0, K - s)) - Pm) * lot;
    const lo = K * 0.9; const hi = K * 1.1;
    const points = []; for (let i = 0; i <= 40; i += 1) { const s = lo + ((hi - lo) * i) / 40; points.push([s, pay(s)]); }
    const be = call ? K + Pm : K - Pm;
    return {
      inputs: [plain('strike', 'Strike', K, UNITS.NUM, IN.format(K)), inr('premium', 'Premium', Pm), plain('lot', 'Lot', lot)],
      figures: [plain('breakeven', 'Break-even', be, UNITS.NUM, trim(be, 2)), inr('maxLoss', 'Max loss', Pm * lot)],
      highlight: ['strike', 'breakeven', 'maxLoss'],
      chart: { kind: 'payoff', title: `${call ? 'Call' : 'Put'} buyer payoff at expiry`, unit: 'INR', strike: K, breakeven: be,
        series: [{ name: 'payoff', color: 'green', points }] },
      note: 'Calculation: payoff at expiry minus premium paid',
    };
  },
  compare(c) {
    const items = (Array.isArray(c.items) ? c.items : []).filter((it) => it && finite(num(it.value))).slice(0, 5);
    if (items.length < 2) throw new Error('compare needs 2–5 items with label and value');
    const unit = c.unit === 'INR' ? UNITS.INR : c.unit === '%' ? UNITS.PCT : UNITS.NUM;
    const mk = (k, l, v) => (unit === UNITS.INR ? inr(k, l, v) : unit === UNITS.PCT ? pct(k, l, v, 2) : plain(k, l, v, UNITS.NUM, trim(v, 2)));
    const vals = items.map((it) => num(it.value));
    const max = Math.max(...vals); const min = Math.min(...vals);
    return {
      inputs: items.map((it, i) => mk(`item${i}`, String(it.label || `#${i + 1}`).slice(0, 18), vals[i])),
      figures: [mk('gap', 'Gap', max - min), ...(min > 0 ? [plain('ratio', 'Ratio', max / min, UNITS.NUM, `${trim(max / min, 2)}x`), pct('gapPct', 'Gap %', ((max - min) / min) * 100)] : [])],
      highlight: ['item0', 'item1', 'gap'],
      chart: { kind: 'bars', title: c.title || 'Comparison', unit: unit === UNITS.INR ? 'INR' : unit === UNITS.PCT ? 'PCT' : 'NUM',
        labels: items.map((it, i) => String(it.label || `#${i + 1}`).slice(0, 28)), values: vals,
        colors: vals.map((v) => (v === max ? 'yellow' : 'blue')) },
      note: COMPARE_NOTE,
    };
  },
};

export const CALC_TYPES = Object.keys(TYPES);

/**
 * { ok, type, inputs, figures, highlight, chart, note } or { ok:false, error }.
 * Never throws: a bad calc is a reason to ask again, not a crash.
 */
export function computeCalc(calc) {
  if (!calc || typeof calc !== 'object' || Array.isArray(calc)) return { ok: false, error: 'no calc' };
  const type = String(calc.type || '').toLowerCase();
  const fn = TYPES[type];
  if (!fn) return { ok: false, error: `unknown calc type "${calc.type}" — use one of ${CALC_TYPES.join(', ')}` };
  try {
    const out = fn({ ...calc, type });
    const all = [...out.inputs, ...out.figures];
    for (const f of all) if (!finite(f.value)) throw new Error(`${f.key} is not a number`);
    return { ok: true, type, ...out, all };
  } catch (err) {
    return { ok: false, error: `${type}: ${err.message}` };
  }
}

/** The 2–3 figures a slide shows in its code-written figure strip. */
export function figureStrip(result) {
  if (!result?.ok) return [];
  return result.highlight.map((k) => result.all.find((f) => f.key === k)).filter(Boolean)
    .map((f) => ({ label: f.label, text: f.text }));
}

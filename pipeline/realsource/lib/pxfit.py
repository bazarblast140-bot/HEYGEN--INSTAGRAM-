"""Price -> pixel fit for the 5m screenshot.

The old fit started from ordinary least squares over every (price, pixel) pair and
then kept pairs within 4 px of it. A few gross outliers (a hover run that spans two
candles after a missed legend reading, a candle hidden under the crosshair label or
the live price tag) pull an OLS line far enough off that most GOOD pairs fall outside
4 px: 23 Oct 2026 run 39923059630 kept 36/178 and the check failed although the axis
was fine. Start instead from a robust Theil-Sen line (median of pairwise slopes,
median intercept), which ignores up to ~29% outliers, then filter and refit by OLS.
The acceptance thresholds (max residual 4 px, keep >= 70%) are unchanged."""

def ols(ps):
    n = len(ps); mx = sum(p for p, _ in ps) / n; my = sum(v for _, v in ps) / n
    b = sum((p - mx) * (v - my) for p, v in ps) / sum((p - mx) ** 2 for p, _ in ps)
    return my - b * mx, b

def _med(xs):
    xs = sorted(xs); n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2

def theil_sen(ps):
    sl = [(ps[j][1] - ps[i][1]) / (ps[j][0] - ps[i][0]) for i in range(len(ps)) for j in range(i + 1, len(ps)) if abs(ps[j][0] - ps[i][0]) > 1e-9]
    b = _med(sl)
    return _med([v - b * p for p, v in ps]), b

def robust_fit(ps, keep_px=4):
    a, b = theil_sen(ps)
    kept = [pp for pp in ps if abs(pp[1] - (a + b * pp[0])) <= keep_px]
    if len(kept) >= 3: a, b = ols(kept)
    else: kept = kept or ps
    res = [abs(v - (a + b * p)) for p, v in kept]
    return a, b, kept, res

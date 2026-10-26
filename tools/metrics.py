"""Scoring rules and calibration for probabilistic forecasts.

All functions take a list of probability vectors and a list of outcome indexes
(0 = domicile, 1 = nul, 2 = extérieur for football). Nothing here is fitted:
these are the yardsticks used to judge both the model and the market.
"""
from __future__ import annotations
import math
import random

EPS = 1e-15


def brier(probs, outcome):
    """Multi-class Brier score: sum over classes of (p - y)^2. 0 = parfait, 2 = pire."""
    return sum((p - (1.0 if i == outcome else 0.0)) ** 2 for i, p in enumerate(probs))


def log_loss(probs, outcome):
    """Negative natural log of the probability given to what actually happened."""
    return -math.log(min(1.0, max(EPS, probs[outcome])))


def rps(probs, outcome):
    """Ranked Probability Score for ordered outcomes (domicile < nul < extérieur)."""
    n = len(probs)
    if n < 2:
        return 0.0
    cum_p = cum_y = total = 0.0
    for i in range(n - 1):
        cum_p += probs[i]
        cum_y += 1.0 if i == outcome else 0.0
        total += (cum_p - cum_y) ** 2
    return total / (n - 1)


def mean(values):
    values = list(values)
    return sum(values) / len(values) if values else None


def score_all(prob_list, outcomes):
    """Average Brier, log loss and RPS (plus hit rate) over a set of forecasts."""
    n = len(outcomes)
    if n == 0:
        return {'n': 0, 'brier': None, 'log_loss': None, 'rps': None, 'hit_rate': None}
    hits = sum(1 for p, y in zip(prob_list, outcomes) if max(range(len(p)), key=p.__getitem__) == y)
    return {
        'n': n,
        'brier': round(mean(brier(p, y) for p, y in zip(prob_list, outcomes)), 5),
        'log_loss': round(mean(log_loss(p, y) for p, y in zip(prob_list, outcomes)), 5),
        'rps': round(mean(rps(p, y) for p, y in zip(prob_list, outcomes)), 5),
        'hit_rate': round(hits / n, 4),
    }


def wilson(successes, n, z=1.645):
    """Wilson score interval for a binomial proportion (90 % by default)."""
    if n == 0:
        return (0.0, 1.0)
    phat = successes / n
    denom = 1 + z * z / n
    centre = (phat + z * z / (2 * n)) / denom
    half = z * math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def calibration(prob_list, outcomes, bins=10):
    """Reliability table: every (probability, happened?) pair is binned.

    Returns per-bin mean forecast, observed frequency with a 90 % Wilson
    interval, and the Expected Calibration Error (weighted |forecast - observed|).
    """
    buckets = [[0, 0.0, 0] for _ in range(bins)]  # count, sum p, hits
    for probs, y in zip(prob_list, outcomes):
        for i, p in enumerate(probs):
            b = min(bins - 1, int(p * bins))
            buckets[b][0] += 1
            buckets[b][1] += p
            buckets[b][2] += 1 if i == y else 0
    table, total, ece = [], sum(b[0] for b in buckets), 0.0
    for i, (count, sum_p, hits) in enumerate(buckets):
        if count == 0:
            continue
        mean_p, freq = sum_p / count, hits / count
        lo, hi = wilson(hits, count)
        ece += count / total * abs(mean_p - freq)
        table.append({'bin': [round(i / bins, 2), round((i + 1) / bins, 2)], 'count': count,
                      'mean_forecast': round(mean_p, 4), 'observed': round(freq, 4),
                      'observed_low': round(lo, 4), 'observed_high': round(hi, 4)})
    return {'bins': table, 'ece': round(ece, 4) if total else None, 'pairs': total}


def paired_bootstrap(loss_a, loss_b, iterations=2000, seed=7):
    """Bootstrap the mean difference (a - b) of per-match losses.

    Returns the observed mean difference, a 90 % interval, and the share of
    resamples where a is strictly better (lower loss) than b.
    """
    n = len(loss_a)
    if n == 0 or n != len(loss_b):
        return None
    diffs = [a - b for a, b in zip(loss_a, loss_b)]
    rng = random.Random(seed)
    means = []
    for _ in range(iterations):
        s = 0.0
        for _ in range(n):
            s += diffs[rng.randrange(n)]
        means.append(s / n)
    means.sort()
    return {'mean_diff': round(sum(diffs) / n, 6),
            'ci90': [round(means[int(0.05 * iterations)], 6), round(means[int(0.95 * iterations) - 1], 6)],
            'p_a_better': round(sum(1 for m in means if m < -1e-12) / iterations, 4)}


def bootstrap_mean_ci(values, iterations=2000, seed=11):
    n = len(values)
    if n == 0:
        return None
    rng = random.Random(seed)
    means = sorted(sum(values[rng.randrange(n)] for _ in range(n)) / n for _ in range(iterations))
    return [round(means[int(0.05 * iterations)], 5), round(means[int(0.95 * iterations) - 1], 5)]

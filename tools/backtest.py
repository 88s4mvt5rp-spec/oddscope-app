"""Chronological (walk-forward) validation of the model against real results and the market.

Rules that keep the evaluation honest:
  * every forecast is produced by a model fitted only on matches played
    strictly before the forecast date (checked and reported);
  * hyper-parameters, the de-margining method and the model/market blend weight
    are chosen on a validation period, then frozen and scored on a later test
    period that played no part in any choice;
  * the model is compared with the market's pre-match prices (what you could
    see before kick-off) and with closing prices (the market's final word).
"""
from __future__ import annotations
from datetime import timedelta
from engine import devig, DEVIG_METHODS
from metrics import score_all, calibration, paired_bootstrap, log_loss, bootstrap_mean_ci
from model import DixonColes, outcome_index

GRID = [(hl, pr) for hl in (120, 240, 480) for pr in (2.0, 6.0)]
WEIGHTS = [round(i * 0.05, 2) for i in range(21)]
REFIT_DAYS = 7
EDGE_THRESHOLD = 0.02
MIN_PREDICTIONS = 150


def market_probs(odds, method='shin'):
    if not odds:
        return None
    return list(devig({0: odds[0], 1: odds[1], 2: odds[2]}, method).values())


def blend(model, market, w):
    p = [(1 - w) * market[i] + w * model[i] for i in range(3)]
    s = sum(p)
    return [x / s for x in p]


def walk_forward(matches, half_life, prior, burn_in, refit_days=REFIT_DAYS):
    """Forecast every match after the burn-in using only earlier matches."""
    preds, skipped = [], 0
    i, n, warm = burn_in, len(matches), None
    while i < n:
        as_of = matches[i]['date']
        window_end = as_of + timedelta(days=refit_days)
        model = DixonColes(half_life, prior).fit(matches, as_of=as_of, warm=warm)
        warm = model
        while i < n and matches[i]['date'] < window_end:
            m = matches[i]
            p = model.predict(m['home'], m['away'])
            if p is None:
                skipped += 1
            else:
                preds.append({'date': m['date'], 'home': m['home'], 'away': m['away'],
                              'y': outcome_index(m['hg'], m['ag']), 'model': p['probs'],
                              'train_until': model.last_date,
                              'odds_open': m.get('odds_open'), 'odds_close': m.get('odds_close'),
                              'odds_max': m.get('odds_max')})
            i += 1
    return preds, skipped


def _losses(preds, key):
    return [log_loss(p[key], p['y']) for p in preds]


def value_simulation(preds, prob_key, odds_key, threshold=EDGE_THRESHOLD):
    """Flat 1-unit stakes where prob x odds - 1 > threshold. Historical, not a promise."""
    returns = []
    for p in preds:
        odds = p.get(odds_key)
        probs = p.get(prob_key)
        if not odds or not probs:
            continue
        for k in range(3):
            if probs[k] * odds[k] - 1 > threshold:
                returns.append(odds[k] - 1 if p['y'] == k else -1.0)
    if not returns:
        return {'bets': 0, 'roi': None, 'roi_ci90': None}
    return {'bets': len(returns), 'roi': round(sum(returns) / len(returns), 4),
            'roi_ci90': bootstrap_mean_ci(returns), 'wins': sum(1 for r in returns if r > 0)}


def run_backtest(matches, burn_in_matches=None, progress=None):
    matches = sorted(matches, key=lambda m: m['date'])
    if len(matches) < 400:
        raise ValueError(f'{len(matches)} matchs : il en faut au moins 400 (≈ 1 saison et demie) pour un backtest sérieux.')
    burn_in = burn_in_matches or max(250, len(matches) // 4)

    # 1) Walk-forward forecasts for each hyper-parameter candidate.
    runs = {}
    for idx, (hl, pr) in enumerate(GRID):
        if progress:
            progress(f'Configuration {idx + 1}/{len(GRID)}')
        runs[(hl, pr)] = walk_forward(matches, hl, pr, burn_in)
    first_preds = runs[GRID[0]][0]
    if len(first_preds) < MIN_PREDICTIONS:
        raise ValueError('Trop peu de prévisions exploitables pour valider le modèle.')

    # Common split date so every configuration is judged on the same period.
    split_date = first_preds[len(first_preds) // 2]['date']

    def split(preds):
        return [p for p in preds if p['date'] < split_date], [p for p in preds if p['date'] >= split_date]

    # 2) Choose hyper-parameters on validation only.
    grid_report = []
    for cfg, (preds, skipped) in runs.items():
        val, _ = split(preds)
        s = score_all([p['model'] for p in val], [p['y'] for p in val])
        grid_report.append({'half_life_days': cfg[0], 'prior_matches': cfg[1], 'val_log_loss': s['log_loss'],
                            'val_n': s['n']})
    best_cfg = min(runs, key=lambda c: next(g['val_log_loss'] for g in grid_report
                                            if (g['half_life_days'], g['prior_matches']) == c))
    preds, skipped = runs[best_cfg]
    leak_free = all(p['train_until'] < p['date'] for p in preds)

    # Keep matches that have pre-match market prices so all competitors face the same games.
    with_open = [p for p in preds if p['odds_open']]
    val, test = split(with_open)
    if len(val) < 60 or len(test) < 60:
        raise ValueError('Pas assez de matchs avec cotes historiques pour comparer au marché.')

    # 3) De-margining method chosen on validation (pre-match prices).
    devig_report = {}
    for method in DEVIG_METHODS:
        probs = [market_probs(p['odds_open'], method) for p in val]
        devig_report[method] = score_all(probs, [p['y'] for p in val])['log_loss']
    method = min(devig_report, key=devig_report.get)
    for p in with_open:
        p['market_open'] = market_probs(p['odds_open'], method)
        p['market_close'] = market_probs(p['odds_close'], method) if p['odds_close'] else None

    # 4) Blend weight chosen on validation.
    weight_curve = []
    for w in WEIGHTS:
        ll = sum(log_loss(blend(p['model'], p['market_open'], w), p['y']) for p in val) / len(val)
        weight_curve.append({'weight': w, 'val_log_loss': round(ll, 5)})
    best_w = min(weight_curve, key=lambda x: x['val_log_loss'])['weight']
    for p in with_open:
        p['blend'] = blend(p['model'], p['market_open'], best_w)

    # 5) Naive reference: home/draw/away frequencies known before the test period.
    known = [m for m in matches if m['date'] < split_date]
    freq = [sum(1 for m in known if outcome_index(m['hg'], m['ag']) == k) / len(known) for k in range(3)]
    for p in with_open:
        p['naive'] = freq

    # 6) Score on the untouched test period.
    ys = [p['y'] for p in test]
    competitors = {'model': 'Modèle Dixon-Coles seul', 'market_open': 'Marché avant-match (moyenne)',
                   'blend': f'Combinaison retenue ({round(best_w * 100)} % modèle)', 'naive': 'Référence naïve (fréquences)'}
    table = {k: {'label': lbl, **score_all([p[k] for p in test], ys)} for k, lbl in competitors.items()}
    closing = [p for p in test if p['market_close']]
    if len(closing) >= 60:
        table['market_close'] = {'label': 'Marché à la clôture (information finale, non disponible avant)',
                                 **score_all([p['market_close'] for p in closing], [p['y'] for p in closing])}

    model_vs_market = paired_bootstrap(_losses(test, 'model'), _losses(test, 'market_open'))
    blend_vs_market = paired_bootstrap(_losses(test, 'blend'), _losses(test, 'market_open'))
    model_vs_naive = paired_bootstrap(_losses(test, 'model'), _losses(test, 'naive'))
    validated = bool(best_w > 0 and blend_vs_market and blend_vs_market['mean_diff'] < 0
                     and blend_vs_market['p_a_better'] >= 0.90)
    live_weight = best_w if validated else 0.0
    if validated:
        decision = (f'Validé : sur {len(test)} matchs de test jamais utilisés, la combinaison à {round(best_w*100)} % '
                    f'modèle bat le marché avant-match (probabilité bootstrap {round(blend_vs_market["p_a_better"]*100)} %). '
                    'Le modèle est intégré avec ce poids.')
    elif best_w == 0:
        decision = ('Non validé : sur la période de validation, ajouter le modèle au marché n’améliore pas la '
                    'log loss. Le modèle reste affiché à titre indicatif, avec un poids de 0 % dans les estimations.')
    else:
        decision = ('Non validé : le gain observé en validation ne se confirme pas avec assez de certitude sur la '
                    'période de test. Poids appliqué : 0 %. Le modèle reste affiché à titre indicatif.')

    def calib(key, rows):
        return calibration([p[key] for p in rows], [p['y'] for p in rows])

    return {
        'matches_total': len(matches), 'burn_in_matches': burn_in, 'predictions': len(preds),
        'skipped_unknown_teams': skipped, 'leak_free': leak_free,
        'periods': {'data_start': matches[0]['date'].isoformat(), 'data_end': matches[-1]['date'].isoformat(),
                    'validation_start': val[0]['date'].isoformat(), 'validation_end': val[-1]['date'].isoformat(),
                    'test_start': test[0]['date'].isoformat(), 'test_end': test[-1]['date'].isoformat(),
                    'validation_n': len(val), 'test_n': len(test)},
        'config': {'half_life_days': best_cfg[0], 'prior_matches': best_cfg[1], 'devig_method': method,
                   'blend_weight_validation': best_w, 'refit_days': REFIT_DAYS},
        'grid': grid_report, 'devig_validation_log_loss': devig_report, 'weight_curve': weight_curve,
        'test_metrics': table,
        'comparisons': {'model_vs_market_open': model_vs_market, 'blend_vs_market_open': blend_vs_market,
                        'model_vs_naive': model_vs_naive},
        'calibration': {'model': calib('model', test), 'market_open': calib('market_open', test),
                        'blend': calib('blend', test)},
        'value_simulation': {
            'threshold': EDGE_THRESHOLD,
            'market_best_price': value_simulation(test, 'market_open', 'odds_max'),
            'blend_best_price': value_simulation(test, 'blend', 'odds_max'),
            'model_best_price': value_simulation(test, 'model', 'odds_max'),
            'note': ('Simulation historique à mise fixe sur la meilleure cote relevée par football-data '
                     '(souvent plus haute que ce qui est réellement jouable en France). Ce n’est pas une promesse.'),
        },
        'validated': validated, 'live_weight': live_weight, 'decision': decision,
    }

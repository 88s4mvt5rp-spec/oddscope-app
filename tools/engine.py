"""Market analysis: margin removal, consensus, best prices, uncertainty, ranking.

Indicative only. A positive theoretical gap is a disagreement between one
price and an estimate, never a guaranteed profit.
"""
from __future__ import annotations
from datetime import datetime, timezone
from math import isfinite, sqrt
from statistics import median, pstdev

STALE_MINUTES = 45          # a bookmaker this far behind the freshest one is ignored
OBSOLETE_MINUTES = 60       # the whole snapshot is considered obsolete past this age
MIN_CONSENSUS_BOOKS = 3     # minimum bookmakers to build a reference without a sharp book
MIN_RELIABILITY_TO_RANK = 50
SHARP_BOOKS = {'pinnacle', 'betfair_ex_eu', 'betfair_ex_uk', 'betfair_ex_au', 'matchbook', 'smarkets'}
DEVIG_METHODS = ('shin', 'power', 'multiplicative')
Z90 = 1.645


def parse_date(value):
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)
    except ValueError:
        return None


def is_french_book(key):
    return str(key).endswith('_fr')


# --------------------------------------------------------------------------- margin removal

def overround(prices):
    return sum(1.0 / p for p in prices.values()) - 1.0


def devig_multiplicative(prices):
    implied = {o: 1.0 / p for o, p in prices.items()}
    total = sum(implied.values())
    return {o: q / total for o, q in implied.items()}


def devig_power(prices):
    """Find k such that sum((1/odds)^k) = 1. Shrinks longshots more than favourites."""
    implied = {o: 1.0 / p for o, p in prices.items()}
    if sum(implied.values()) <= 1.0:
        return devig_multiplicative(prices)
    lo, hi = 1.0, 10.0
    for _ in range(100):
        k = (lo + hi) / 2
        if sum(q ** k for q in implied.values()) > 1.0:
            lo = k
        else:
            hi = k
    k = (lo + hi) / 2
    probs = {o: q ** k for o, q in implied.items()}
    total = sum(probs.values())
    return {o: p / total for o, p in probs.items()}


def devig_shin(prices):
    """Shin (1993) model: margin attributed to a share z of insider money."""
    implied = {o: 1.0 / p for o, p in prices.items()}
    s = sum(implied.values())
    if s <= 1.0 or len(implied) < 2:
        return devig_multiplicative(prices)

    def probs_for(z):
        return {o: (sqrt(z * z + 4 * (1 - z) * q * q / s) - z) / (2 * (1 - z)) for o, q in implied.items()}

    lo, hi = 0.0, 0.4
    for _ in range(100):
        z = (lo + hi) / 2
        if sum(probs_for(z).values()) > 1.0:
            lo = z
        else:
            hi = z
    probs = probs_for((lo + hi) / 2)
    total = sum(probs.values())
    return {o: p / total for o, p in probs.items()}


def devig(prices, method='shin'):
    if method == 'power':
        return devig_power(prices)
    if method == 'multiplicative':
        return devig_multiplicative(prices)
    return devig_shin(prices)


# --------------------------------------------------------------------------- parsing

def extract_book(book, wanted):
    """Normalise one bookmaker's h2h prices, rejecting incomplete or absurd markets."""
    for market in book.get('markets', []) or []:
        if market.get('key') != 'h2h':
            continue
        values = {}
        for item in market.get('outcomes', []) or []:
            name = str(item.get('name', ''))
            try:
                price = float(item.get('price'))
            except (ValueError, TypeError):
                continue
            if isfinite(price) and 1.001 < price < 1000 and name in wanted:
                values[name] = price
        if set(values) == set(wanted):
            # A real book always has a margin >= about -2 %; below that the feed is broken.
            if overround(values) < -0.02 or overround(values) > 0.35:
                return None
            return values
    return None


def outcome_label(outcome, home, away):
    if outcome == 'Draw':
        return 'Nul'
    if outcome == home:
        return '1 · ' + home
    if outcome == away:
        return '2 · ' + away
    return outcome


# --------------------------------------------------------------------------- market reference

def market_reference(books, outcomes, method='shin', exclude_key=None):
    """Margin-free probability estimate from the market, optionally leaving one book out.

    Sharp books (Pinnacle, exchanges) are preferred when present; otherwise the
    median of the de-margined books is used. Returns probs, standard errors
    (a rough measure of how much the estimate could move) and dispersion.
    """
    pool = [b for b in books if b['key'] != exclude_key]
    if not pool:
        return None
    devigged = [devig(b['odds'], method) for b in pool]
    dispersion = {o: (pstdev([d[o] for d in devigged]) if len(devigged) > 1 else 0.0) for o in outcomes}
    sharp = [d for b, d in zip(pool, devigged) if b['key'] in SHARP_BOOKS]
    if sharp:
        raw = {o: sum(d[o] for d in sharp) / len(sharp) for o in outcomes}
        if len(sharp) > 1:
            se = {o: max(0.010, pstdev([d[o] for d in sharp]) / sqrt(len(sharp))) for o in outcomes}
        else:
            se = {o: 0.012 for o in outcomes}
        source = 'sharp'
    elif len(pool) >= MIN_CONSENSUS_BOOKS:
        raw = {o: median(d[o] for d in devigged) for o in outcomes}
        inflate = 1.25 if len(pool) == MIN_CONSENSUS_BOOKS else 1.0
        se = {o: inflate * max(0.015, 1.2533 * dispersion[o] / sqrt(len(pool))) for o in outcomes}
        source = 'consensus'
    else:
        return None
    total = sum(raw.values())
    return {'probs': {o: raw[o] / total for o in outcomes}, 'se': se, 'dispersion': dispersion,
            'n': len(pool), 'n_sharp': len(sharp), 'source': source}


def combine(market, model_probs, model_se, weight):
    """Linear pool of market and model with a validated weight (0 = market only)."""
    out_p, out_se = {}, {}
    for o, p in market['probs'].items():
        if model_probs is not None and weight > 0:
            out_p[o] = (1 - weight) * p + weight * model_probs[o]
            out_se[o] = sqrt(((1 - weight) * market['se'][o]) ** 2 + (weight * model_se[o]) ** 2)
        else:
            out_p[o], out_se[o] = p, market['se'][o]
    total = sum(out_p.values())
    return {o: v / total for o, v in out_p.items()}, out_se


def clip(p):
    return min(0.999, max(0.001, p))


# --------------------------------------------------------------------------- scoring of data quality

def reliability(n_books, n_sharp, max_age, snapshot_age, mean_dispersion, model_state):
    score, flags = 0, []
    score += round(35 * min(n_books, 8) / 8)
    if n_books < 4:
        flags.append(f'Seulement {n_books} bookmaker(s) exploitables')
    if max_age is None or max_age > OBSOLETE_MINUTES:
        flags.append('Cotes du fournisseur anciennes de plus d’une heure')
    elif max_age <= 10:
        score += 20
    elif max_age <= 30:
        score += 15
    else:
        score += 8
    if snapshot_age is not None and snapshot_age > OBSOLETE_MINUTES:
        score -= 20
        flags.append(f'Dernière actualisation il y a {int(snapshot_age)} min : données obsolètes')
    if n_sharp:
        score += 15
    else:
        flags.append('Aucune référence « sharp » (Pinnacle, exchange) : estimation moins précise')
    if mean_dispersion < 0.015:
        score += 20
    elif mean_dispersion < 0.03:
        score += 12
    elif mean_dispersion < 0.05:
        score += 5
        flags.append('Désaccord notable entre bookmakers')
    else:
        flags.append('Fort désaccord entre bookmakers (cote erronée ou information récente ?)')
    if model_state == 'validated':
        score += 10
    elif model_state == 'available':
        score += 3
    score = max(0, min(100, score))
    label = ('Élevée' if score >= 70 else 'Moyenne' if score >= MIN_RELIABILITY_TO_RANK
             else 'Faible' if score >= 30 else 'Insuffisante')
    return {'score': score, 'label': label, 'flags': flags}


def uncertainty_label(width_pts):
    if width_pts < 4:
        return 'Faible'
    if width_pts < 8:
        return 'Modérée'
    return 'Élevée'


# --------------------------------------------------------------------------- main analysis

def analyze_event(ev, now, sport_name='', model_predict=None, model_weight=0.0, books_filter=None,
                  method='shin', snapshot_age=None, demo=False):
    """Analyse one event. Returns (analysis dict, None) or (None, skip reason)."""
    start = parse_date(ev.get('commence_time'))
    if start is None:
        return None, 'invalid'
    if start <= now:
        return None, 'started'
    home, away = str(ev.get('home_team', '')), str(ev.get('away_team', ''))
    if not home or not away or home == away:
        return None, 'invalid'
    sport_key = str(ev.get('sport_key', ''))
    draw_exists = any(out.get('name') == 'Draw'
                      for b in ev.get('bookmakers', []) or []
                      for m in b.get('markets', []) or [] if m.get('key') == 'h2h'
                      for out in m.get('outcomes', []) or [])
    is_soccer = sport_key.startswith('soccer_')
    if is_soccer and not draw_exists:
        return None, 'invalid'          # football without the draw = partial feed
    outcomes = [home, 'Draw', away] if draw_exists else [home, away]

    books = []
    for b in ev.get('bookmakers', []) or []:
        odds = extract_book(b, outcomes)
        updated = parse_date(b.get('last_update'))
        key = str(b.get('key', ''))
        if odds is None or updated is None or not key:
            continue
        books.append({'key': key, 'title': str(b.get('title') or key), 'odds': odds, 'updated': updated})
    books = list({b['key']: b for b in books}.values())
    if not books:
        return None, 'insufficient_books'
    newest = max(b['updated'] for b in books)
    fresh = []
    for b in books:
        b['age_minutes'] = round(max(0.0, (now - b['updated']).total_seconds() / 60), 1)
        b['lag_minutes'] = (newest - b['updated']).total_seconds() / 60
        b['stale'] = b['lag_minutes'] > STALE_MINUTES and not demo
        b['overround'] = overround(b['odds'])
        b['is_sharp'] = b['key'] in SHARP_BOOKS
        b['is_fr'] = is_french_book(b['key'])
        b['selected'] = books_filter is None or b['key'] in books_filter
        if not b['stale']:
            fresh.append(b)

    market = market_reference(fresh, outcomes, method)
    if market is None:
        return None, 'insufficient_books'

    model_pred, model_reason = (None, 'Modèle disponible uniquement pour les championnats de football couverts')
    if model_predict is not None and is_soccer and len(outcomes) == 3:
        model_pred, model_reason = model_predict(home, away)
    model_probs = model_se = None
    if model_pred:
        model_probs = dict(zip(outcomes, model_pred['probs']))
        model_se = dict(zip(outcomes, model_pred['se']))
    weight = model_weight if model_probs else 0.0
    retained, retained_se = combine(market, model_probs, model_se, weight)

    selected = [b for b in fresh if b['selected']]
    best = {}
    for o in outcomes:
        if selected:
            top = max(selected, key=lambda b: b['odds'][o])
            best[o] = {'price': top['odds'][o], 'bookmaker': top['title'], 'key': top['key']}

    analysis = []
    for o in outcomes:
        if o not in best:
            continue
        # Leave the bookmaker offering the price out of its own reference.
        loo = market_reference(fresh, outcomes, method, exclude_key=best[o]['key'])
        if loo is None:
            continue
        p_ref, se_ref = combine(loo, model_probs, model_se, weight)
        p, se = p_ref[o], se_ref[o]
        lo, hi = clip(p - Z90 * se), clip(p + Z90 * se)
        price = best[o]['price']
        analysis.append({
            'outcome': o, 'label': outcome_label(o, home, away),
            'best_price': price, 'best_book': best[o]['bookmaker'], 'best_book_key': best[o]['key'],
            'reference_books': loo['n'], 'reference_source': loo['source'],
            'probability': round(p, 4), 'p_low': round(lo, 4), 'p_high': round(hi, 4),
            'fair_odds': round(1 / p, 3), 'edge': round(p * price - 1, 4),
            'edge_low': round(lo * price - 1, 4), 'edge_high': round(hi * price - 1, 4),
            'significant': lo * price - 1 > 0,
        })

    max_age = max(b['age_minutes'] for b in fresh)
    mean_disp = sum(market['dispersion'].values()) / len(outcomes)
    model_state = ('validated' if model_probs and weight > 0 else 'available' if model_probs else 'none')
    rel = reliability(len(fresh), market['n_sharp'], max_age, snapshot_age, mean_disp, model_state)
    stale_books = [b['title'] for b in books if b['stale']]
    if stale_books:
        rel['flags'].append('Ignorés car en retard sur les autres : ' + ', '.join(stale_books))
    if not selected:
        rel['flags'].append('Aucun des bookmakers filtrés ne propose ce match')
    if model_pred is None and is_soccer:
        rel['flags'].append(model_reason)
    width = max((retained_se[o] * 2 * Z90 for o in outcomes), default=0) * 100
    best_margin = (sum(1 / best[o]['price'] for o in outcomes) - 1) if len(best) == len(outcomes) else None
    top_gap = max(analysis, key=lambda a: a['edge'], default=None)
    eligible = (rel['score'] >= MIN_RELIABILITY_TO_RANK and bool(analysis)
                and (snapshot_age is None or snapshot_age <= OBSOLETE_MINUTES)
                and max_age <= OBSOLETE_MINUTES)

    return {
        'id': str(ev.get('id', '')), 'sport_key': sport_key,
        'sport_title': sport_name or str(ev.get('sport_title', 'Sport')),
        'home': home, 'away': away, 'start': start.isoformat(),
        'outcomes': outcomes, 'labels': {o: outcome_label(o, home, away) for o in outcomes},
        'bookmakers': [{'key': b['key'], 'title': b['title'], 'odds': b['odds'], 'age_minutes': b['age_minutes'],
                        'overround': round(b['overround'], 4), 'stale': b['stale'], 'is_sharp': b['is_sharp'],
                        'is_fr': b['is_fr'], 'selected': b['selected']}
                       for b in sorted(books, key=lambda v: (not v['is_fr'], v['title']))],
        'books_used': len(fresh), 'books_selected': len(selected),
        'best': best,
        'best_margin': round(best_margin, 4) if best_margin is not None else None,
        'market': {'probs': {o: round(market['probs'][o], 4) for o in outcomes},
                   'se': {o: round(market['se'][o], 4) for o in outcomes},
                   'dispersion': {o: round(market['dispersion'][o], 4) for o in outcomes},
                   'source': market['source'], 'n': market['n'], 'n_sharp': market['n_sharp'],
                   'method': method},
        'model': ({'probs': {o: round(model_probs[o], 4) for o in outcomes},
                   'low': dict(zip(outcomes, model_pred['low'])), 'high': dict(zip(outcomes, model_pred['high'])),
                   'xg_home': model_pred.get('xg_home'), 'xg_away': model_pred.get('xg_away'),
                   'matched': model_pred.get('matched'), 'weight': weight}
                  if model_probs else None),
        'model_status': (('Validé hors échantillon, poids %d %%' % round(weight * 100)) if model_state == 'validated'
                         else 'Affiché, non utilisé (non validé contre le marché)' if model_state == 'available'
                         else model_reason),
        'retained': {'probs': {o: round(retained[o], 4) for o in outcomes},
                     'low': {o: round(clip(retained[o] - Z90 * retained_se[o]), 4) for o in outcomes},
                     'high': {o: round(clip(retained[o] + Z90 * retained_se[o]), 4) for o in outcomes},
                     'model_weight': weight},
        'analysis': analysis,
        'top_gap': top_gap,
        'reliability': rel,
        'uncertainty': {'width_pts': round(width, 1), 'label': uncertainty_label(width)},
        'eligible': eligible,
        'max_age_minutes': max_age,
    }, None


def analyze_events(events, sport_name='', model_predict=None, model_weight=0.0, books_filter=None,
                   method='shin', now=None, snapshot_age=None, demo=False):
    now = now or datetime.now(timezone.utc)
    analysed, skipped = [], {'started': 0, 'insufficient_books': 0, 'invalid': 0}
    book_titles = {}
    for ev in events or []:
        result, reason = analyze_event(ev, now, sport_name, model_predict, model_weight, books_filter,
                                       method, snapshot_age, demo)
        if result is None:
            skipped[reason] += 1
            continue
        for b in result['bookmakers']:
            book_titles[b['key']] = {'key': b['key'], 'title': b['title'], 'is_fr': b['is_fr'],
                                     'is_sharp': b['is_sharp']}
        analysed.append(result)
    analysed.sort(key=lambda e: e['start'])

    # Ranking: only sufficiently reliable events, only positive gaps, ordered by the
    # pessimistic end of the gap so a precise small gap beats a vague large one.
    ranking = []
    for e in analysed:
        if not e['eligible']:
            continue
        for a in e['analysis']:
            if a['edge'] > 0:
                ranking.append({**a, 'event_id': e['id'], 'home': e['home'], 'away': e['away'],
                                'start': e['start'], 'sport_title': e['sport_title'],
                                'reliability': e['reliability']['score'],
                                'reliability_label': e['reliability']['label'],
                                'uncertainty': e['uncertainty']['label'],
                                'model_weight': e['retained']['model_weight']})
    ranking.sort(key=lambda r: (r['edge_low'], r['edge']), reverse=True)
    return {
        'events': analysed,
        'ranking': ranking,
        'bookmakers': sorted(book_titles.values(), key=lambda b: (not b['is_fr'], b['title'])),
        'stats': {'matches': len(analysed), 'eligible': sum(1 for e in analysed if e['eligible']),
                  'bookmakers': len(book_titles), 'opportunities': len(ranking),
                  'significant': sum(1 for r in ranking if r['significant']),
                  'raw_events': len(events or [])},
        'skipped': skipped,
    }

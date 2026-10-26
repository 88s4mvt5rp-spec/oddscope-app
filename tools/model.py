"""Independent football model: time-weighted Dixon-Coles Poisson ratings.

Each team gets an attack and a defence rating, plus a league-wide home
advantage, fitted by weighted maximum likelihood on past results only
(recent matches weigh more: recent form). A low-score correction (rho) fixes
the classic Poisson under-estimation of 0-0 / 1-1. Ratings are shrunk towards
the league average, so a team with few matches stays close to average.

Nothing here is pre-trained: the model only knows the CSV results it is given.
"""
from __future__ import annotations
import csv
import io
import math
import random
import re
import unicodedata
from datetime import datetime, date

MAX_GOALS = 10
RHO_GRID = [x / 100 for x in range(-20, 11, 2)]


def norm(name):
    name = unicodedata.normalize('NFKD', str(name or ''))
    name = ''.join(x for x in name if not unicodedata.combining(x))
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9]+', ' ', name.casefold())).strip()


def to_date(s):
    s = str(s).strip()
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%d/%m/%y', '%Y/%m/%d', '%d-%m-%Y'):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        raise ValueError('Dates acceptées : AAAA-MM-JJ ou JJ/MM/AAAA')


def _float(row, col):
    if not col:
        return None
    try:
        v = float(str(row.get(col, '')).replace(',', '.'))
        return v if v > 1.0 and math.isfinite(v) else None
    except ValueError:
        return None


ODDS_COLUMNS = {
    # pre-match prices (available before kick-off, collected days before)
    'open': [('AvgH', 'AvgD', 'AvgA'), ('BbAvH', 'BbAvD', 'BbAvA'), ('B365H', 'B365D', 'B365A'),
             ('PSH', 'PSD', 'PSA')],
    'max': [('MaxH', 'MaxD', 'MaxA'), ('BbMxH', 'BbMxD', 'BbMxA')],
    # closing prices (known only at kick-off: used for comparison, never as a model input)
    'close': [('AvgCH', 'AvgCD', 'AvgCA'), ('PSCH', 'PSCD', 'PSCA'), ('B365CH', 'B365CD', 'B365CA')],
}


def parse_csv(content, min_rows=60, today=None):
    """Parse a results CSV (own format or football-data.co.uk). Returns sorted match dicts."""
    if not isinstance(content, str) or len(content) > 5_000_000:
        raise ValueError('CSV manquant ou trop volumineux (5 Mo maximum).')
    sample = content.lstrip('﻿')
    if not sample.strip():
        raise ValueError('CSV vide.')
    try:
        dialect = csv.Sniffer().sniff(sample[:4096], delimiters=',;\t')
        reader = csv.DictReader(io.StringIO(sample), dialect=dialect)
    except csv.Error:
        reader = csv.DictReader(io.StringIO(sample))
    fields = [h for h in (reader.fieldnames or []) if h]
    keys = {norm(h).replace(' ', ''): h for h in fields}
    possible = {
        'date': ['date', 'matchdate'],
        'home': ['hometeam', 'home', 'hometeamname', 'domicile', 'equipedomicile'],
        'away': ['awayteam', 'away', 'awayteamname', 'exterieur', 'equipeexterieur'],
        'hg': ['fthg', 'homegoals', 'hg', 'butdomicile', 'butsdomicile'],
        'ag': ['ftag', 'awaygoals', 'ag', 'butexterieur', 'butsexterieur'],
    }
    mapped = {}
    for field, aliases in possible.items():
        mapped[field] = next((keys[a] for a in aliases if a in keys), None)
        if mapped[field] is None:
            raise ValueError('Colonnes nécessaires : date, home_team, away_team, home_goals, away_goals '
                             '(ou Date, HomeTeam, AwayTeam, FTHG, FTAG).')
    odds_cols = {}
    for kind, options in ODDS_COLUMNS.items():
        odds_cols[kind] = next((opt for opt in options if all(c in fields for c in opt)), None)
    today = today or date.today()
    rows = []
    for row in reader:
        try:
            d = to_date(row[mapped['date']])
            home_raw, away_raw = str(row[mapped['home']]).strip(), str(row[mapped['away']]).strip()
            hg, ag = int(row[mapped['hg']]), int(row[mapped['ag']])
        except (ValueError, TypeError, KeyError):
            continue
        if not home_raw or not away_raw or norm(home_raw) == norm(away_raw):
            continue
        if min(hg, ag) < 0 or max(hg, ag) > 30 or d > today:
            continue
        match = {'date': d, 'home': home_raw, 'away': away_raw, 'hg': hg, 'ag': ag}
        for kind, cols in odds_cols.items():
            if cols:
                vals = [_float(row, c) for c in cols]
                match['odds_' + kind] = vals if all(vals) else None
        rows.append(match)
    rows.sort(key=lambda m: m['date'])
    if len(rows) < min_rows:
        raise ValueError(f'{len(rows)} matchs valides : il en faut au moins {min_rows}. Vérifie les colonnes et les dates.')
    return rows


def outcome_index(hg, ag):
    return 0 if hg > ag else (1 if hg == ag else 2)


def _poisson_pmf(mu):
    out, p = [], math.exp(-mu)
    for k in range(MAX_GOALS + 1):
        out.append(p)
        p *= mu / (k + 1)
    return out


def _tau(h, a, lh, la, rho):
    if h == 0 and a == 0:
        return 1 - lh * la * rho
    if h == 0 and a == 1:
        return 1 + lh * rho
    if h == 1 and a == 0:
        return 1 + la * rho
    if h == 1 and a == 1:
        return 1 - rho
    return 1.0


def outcome_probs(lh, la, rho=0.0):
    """Home/draw/away probabilities from two Poisson means with Dixon-Coles correction."""
    ph, pa = _poisson_pmf(lh), _poisson_pmf(la)
    res = [0.0, 0.0, 0.0]
    for h in range(MAX_GOALS + 1):
        for a in range(MAX_GOALS + 1):
            p = ph[h] * pa[a]
            if h < 2 and a < 2:
                p *= max(0.0, _tau(h, a, lh, la, rho))
            res[0 if h > a else (1 if h == a else 2)] += p
    s = sum(res)
    return [x / s for x in res]


def score_matrix(lh, la, rho=0.0):
    """Probability of every score (h, a) up to MAX_GOALS, Dixon-Coles corrected, normalised."""
    ph, pa = _poisson_pmf(lh), _poisson_pmf(la)
    m = [[ph[h] * pa[a] * (max(0.0, _tau(h, a, lh, la, rho)) if h < 2 and a < 2 else 1.0)
          for a in range(MAX_GOALS + 1)] for h in range(MAX_GOALS + 1)]
    s = sum(map(sum, m))
    return [[x / s for x in row] for row in m]


def market_lambdas(total, p_home, p_away, rho=0.0):
    """Split an expected goal total between the teams so that the score model reproduces
    the market's home-minus-away probability. Gives a market-consistent score matrix."""
    target = p_home - p_away
    lo, hi = 0.03, 0.97
    for _ in range(50):
        r = (lo + hi) / 2
        p = outcome_probs(total * r, total * (1 - r), rho)
        if p[0] - p[2] < target:
            lo = r
        else:
            hi = r
    r = (lo + hi) / 2
    return total * r, total * (1 - r)


def derived_markets(m):
    """Secondary markets from a score matrix."""
    n = len(m)
    tot = lambda f: sum(m[h][a] for h in range(n) for a in range(n) if f(h, a))
    out = {'1': tot(lambda h, a: h > a), 'N': tot(lambda h, a: h == a), '2': tot(lambda h, a: h < a),
           'btts_yes': tot(lambda h, a: h > 0 and a > 0)}
    for line in (0.5, 1.5, 2.5, 3.5, 4.5):
        out[f'over_{line}'] = tot(lambda h, a, l=line: h + a > l)
    return out


class DixonColes:
    """Time-weighted, shrunk Dixon-Coles model.

    half_life_days: weight of a match halves every N days (recent form).
    prior_matches: shrinkage strength, in "matches at league average".
    """

    def __init__(self, half_life_days=180, prior_matches=4.0, min_team_matches=5, iterations=60):
        self.half_life = half_life_days
        self.prior = prior_matches
        self.min_team_matches = min_team_matches
        self.iterations = iterations
        self.fitted = False

    def config(self):
        return {'half_life_days': self.half_life, 'prior_matches': self.prior}

    def fit(self, matches, as_of=None, warm=None):
        """Fit on matches strictly before `as_of` (all matches when None)."""
        rows = [m for m in matches if as_of is None or m['date'] < as_of]
        if len(rows) < 30:
            raise ValueError('Pas assez de matchs pour ajuster le modèle (30 minimum).')
        ref_date = as_of or rows[-1]['date']
        data = []
        teams = {}
        for m in rows:
            w = 0.5 ** ((ref_date - m['date']).days / self.half_life)
            if w < 1e-3:
                continue
            h, a = norm(m['home']), norm(m['away'])
            teams.setdefault(h, m['home'])
            teams.setdefault(a, m['away'])
            data.append((h, a, m['hg'], m['ag'], w))
        self.display = teams
        tw = sum(d[4] for d in data)
        avg = sum(w * (hg + ag) for _, _, hg, ag, w in data) / (2 * tw)
        att = {t: 1.0 for t in teams}
        dfn = {t: 1.0 for t in teams}
        home_adv, base = 1.25, avg
        if warm:
            att.update({t: v for t, v in warm.att.items() if t in att})
            dfn.update({t: v for t, v in warm.dfn.items() if t in dfn})
            home_adv, base = warm.home_adv, warm.base
        k = self.prior * avg
        weighted_n = {t: 0.0 for t in teams}
        for h, a, _, _, w in data:
            weighted_n[h] += w
            weighted_n[a] += w
        for _ in range(self.iterations):
            # attack: goals scored / goals expected with attack = 1, both shrunk to 1 via k
            num = {t: k for t in teams}
            den = {t: k for t in teams}
            for h, a, hg, ag, w in data:
                num[h] += w * hg
                den[h] += w * base * home_adv * dfn[a]
                num[a] += w * ag
                den[a] += w * base * dfn[h]
            new_att = {t: num[t] / den[t] for t in teams}
            num = {t: k for t in teams}
            den = {t: k for t in teams}
            for h, a, hg, ag, w in data:
                num[a] += w * hg
                den[a] += w * base * home_adv * new_att[h]
                num[h] += w * ag
                den[h] += w * base * new_att[a]
            new_dfn = {t: num[t] / den[t] for t in teams}
            ga = math.exp(sum(math.log(v) for v in new_att.values()) / len(teams))
            gd = math.exp(sum(math.log(v) for v in new_dfn.values()) / len(teams))
            new_att = {t: v / ga for t, v in new_att.items()}
            new_dfn = {t: v / gd for t, v in new_dfn.items()}
            hn = sum(w * hg for _, _, hg, _, w in data)
            hd = sum(w * base * new_att[h] * new_dfn[a] for h, a, _, _, w in data)
            home_adv = hn / hd
            tot_n = sum(w * (hg + ag) for _, _, hg, ag, w in data)
            tot_d = sum(w * (home_adv * new_att[h] * new_dfn[a] + new_att[a] * new_dfn[h]) for h, a, _, _, w in data)
            base = tot_n / tot_d
            delta = max(max(abs(new_att[t] - att[t]), abs(new_dfn[t] - dfn[t])) for t in teams)
            att, dfn = new_att, new_dfn
            if delta < 1e-5:
                break
        self.att, self.dfn, self.home_adv, self.base = att, dfn, home_adv, base
        # Low-score correction, chosen by weighted likelihood on the same data.
        best_rho, best_ll = 0.0, -1e18
        lows = [(hg, ag, w, *self._lambdas(h, a)) for h, a, hg, ag, w in data if hg < 2 and ag < 2]
        for rho in RHO_GRID:
            ll = 0.0
            for hg, ag, w, lh, la in lows:
                t = _tau(hg, ag, lh, la, rho)
                if t <= 0:
                    ll = -1e18
                    break
                ll += w * math.log(t)
            if ll > best_ll:
                best_ll, best_rho = ll, rho
        self.rho = best_rho
        # Approximate standard errors of log-ratings (Poisson information + prior).
        scored = {t: k for t in teams}
        conceded = {t: k for t in teams}
        for h, a, hg, ag, w in data:
            scored[h] += w * hg
            scored[a] += w * ag
            conceded[h] += w * ag
            conceded[a] += w * hg
        self.se_att = {t: 1 / math.sqrt(max(scored[t], 1e-6)) for t in teams}
        self.se_dfn = {t: 1 / math.sqrt(max(conceded[t], 1e-6)) for t in teams}
        self.team_n = {t: 0 for t in teams}
        for m in rows:
            self.team_n[norm(m['home'])] = self.team_n.get(norm(m['home']), 0) + 1
            self.team_n[norm(m['away'])] = self.team_n.get(norm(m['away']), 0) + 1
        self.weighted_n = weighted_n
        self.n_matches = len(rows)
        self.last_date = rows[-1]['date']
        self.matches = rows
        self.fitted = True
        return self

    def _lambdas(self, h, a):
        lh = self.base * self.home_adv * self.att[h] * self.dfn[a]
        la = self.base * self.att[a] * self.dfn[h]
        return max(0.05, min(6.0, lh)), max(0.05, min(6.0, la))

    def knows(self, team):
        t = norm(team)
        return t in self.att and self.team_n.get(t, 0) >= self.min_team_matches

    def predict(self, home, away, intervals=False, draws=200, seed=3):
        """Probabilities [home, draw, away] or None if a team is unknown / too little data."""
        h, a = norm(home), norm(away)
        if not (self.knows(h) and self.knows(a)):
            return None
        lh, la = self._lambdas(h, a)
        probs = outcome_probs(lh, la, self.rho)
        out = {'probs': probs, 'xg_home': round(lh, 2), 'xg_away': round(la, 2)}
        if intervals:
            # Propagate rating uncertainty by simulation (parameter uncertainty only;
            # injuries, line-ups and news are not in the data and add more).
            rng = random.Random(seed)
            sh = math.sqrt(self.se_att[h] ** 2 + self.se_dfn[a] ** 2)
            sa = math.sqrt(self.se_att[a] ** 2 + self.se_dfn[h] ** 2)
            sims = [outcome_probs(lh * math.exp(rng.gauss(0, sh)), la * math.exp(rng.gauss(0, sa)), self.rho)
                    for _ in range(draws)]
            out['low'], out['high'], out['se'] = [], [], []
            for i in range(3):
                col = sorted(s[i] for s in sims)
                mean_i = sum(col) / draws
                out['low'].append(round(col[int(0.05 * draws)], 4))
                out['high'].append(round(col[int(0.95 * draws) - 1], 4))
                out['se'].append(math.sqrt(sum((c - mean_i) ** 2 for c in col) / draws))
        return out

    def team_profile(self, team, last=5):
        """Recent form and home/away record from the raw results (descriptive only)."""
        t = norm(team)
        games = [m for m in self.matches if norm(m['home']) == t or norm(m['away']) == t]
        if not games:
            return None

        def summary(subset):
            w = d = l = gf = ga = 0
            for m in subset:
                at_home = norm(m['home']) == t
                f, c = (m['hg'], m['ag']) if at_home else (m['ag'], m['hg'])
                gf += f
                ga += c
                w += f > c
                d += f == c
                l += f < c
            n = len(subset)
            return {'played': n, 'w': w, 'd': d, 'l': l, 'gf': gf, 'ga': ga,
                    'ppg': round((3 * w + d) / n, 2) if n else None}

        recent = games[-last:]
        form = []
        for m in reversed(recent):
            at_home = norm(m['home']) == t
            f, c = (m['hg'], m['ag']) if at_home else (m['ag'], m['hg'])
            form.append({'date': m['date'].isoformat(), 'opponent': m['away'] if at_home else m['home'],
                         'venue': 'D' if at_home else 'E', 'score': f'{f}-{c}',
                         'result': 'V' if f > c else ('N' if f == c else 'D')})
        season_cut = games[-1]['date'].replace(year=games[-1]['date'].year - 1)
        last_year = [m for m in games if m['date'] > season_cut]
        return {
            'name': self.display.get(t, team),
            'attack': round(self.att.get(t, 1.0), 3), 'defence': round(self.dfn.get(t, 1.0), 3),
            'matches_in_data': len(games), 'last_match': games[-1]['date'].isoformat(),
            'form': form,
            'last5': summary(recent),
            'home_12m': summary([m for m in last_year if norm(m['home']) == t]),
            'away_12m': summary([m for m in last_year if norm(m['away']) == t]),
        }

    def info(self):
        return {'fitted': self.fitted, 'matches': getattr(self, 'n_matches', 0),
                'teams': len(getattr(self, 'att', {})), 'home_advantage': round(getattr(self, 'home_adv', 0), 3),
                'rho': getattr(self, 'rho', None), 'last_date': getattr(self, 'last_date', None) and self.last_date.isoformat(),
                **self.config()}

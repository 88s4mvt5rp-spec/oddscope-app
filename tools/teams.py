"""Matching team names between the odds feed and the historical results.

The Odds API says "Paris Saint Germain", football-data.co.uk says "Paris SG".
A wrong match would silently feed the model the wrong team, so the matcher is
conservative: exact alias first, then a fuzzy match only when it is clear-cut.
"""
from __future__ import annotations
import difflib
from model import norm

STOP = {'fc', 'cf', 'sc', 'ac', 'as', 'afc', 'ogc', 'rc', 'ssc', 'us', 'sv', 'vfb', 'vfl', 'tsg', 'fsv',
        'club', 'calcio', 'cd', 'ud', 'sd', 'rcd', 'ca', 'cs', 'sk', 'fk', 'bk', 'if', 'the', 'de', 'football'}

ALIASES = {
    # France
    'paris saint germain': 'paris sg', 'psg': 'paris sg', 'olympique lyonnais': 'lyon',
    'olympique de marseille': 'marseille', 'olympique marseille': 'marseille', 'stade rennais': 'rennes',
    'stade brestois 29': 'brest', 'stade brestois': 'brest', 'rc lens': 'lens', 'losc lille': 'lille',
    'as saint etienne': 'st etienne', 'saint etienne': 'st etienne', 'le mans fc': 'le mans',
    'rc strasbourg': 'strasbourg', 'rc strasbourg alsace': 'strasbourg', 'stade de reims': 'reims',
    'as monaco': 'monaco', 'ogc nice': 'nice', 'fc nantes': 'nantes', 'aj auxerre': 'auxerre',
    'sco angers': 'angers', 'angers sco': 'angers', 'fc lorient': 'lorient', 'fc metz': 'metz',
    'estac troyes': 'troyes', 'clermont foot': 'clermont', 'montpellier hsc': 'montpellier',
    'toulouse fc': 'toulouse', 'le havre ac': 'le havre', 'havre ac': 'le havre', 'paris fc': 'paris fc',
    # England
    'manchester united': 'man united', 'manchester city': 'man city', 'nottingham forest': 'nott m forest',
    'wolverhampton wanderers': 'wolves', 'tottenham hotspur': 'tottenham', 'brighton and hove albion': 'brighton',
    'newcastle united': 'newcastle', 'west ham united': 'west ham', 'leicester city': 'leicester',
    'leeds united': 'leeds', 'afc bournemouth': 'bournemouth', 'ipswich town': 'ipswich',
    'sheffield united': 'sheffield united', 'sheffield wednesday': 'sheffield weds', 'luton town': 'luton',
    'west bromwich albion': 'west brom', 'queens park rangers': 'qpr', 'stoke city': 'stoke',
    'swansea city': 'swansea', 'cardiff city': 'cardiff', 'hull city': 'hull', 'norwich city': 'norwich',
    'coventry city': 'coventry', 'preston north end': 'preston', 'blackburn rovers': 'blackburn',
    'plymouth argyle': 'plymouth', 'oxford united': 'oxford', 'derby county': 'derby',
    # Spain
    'atletico madrid': 'ath madrid', 'athletic bilbao': 'ath bilbao', 'athletic club': 'ath bilbao',
    'real betis': 'betis', 'celta vigo': 'celta', 'rayo vallecano': 'vallecano', 'real sociedad': 'sociedad',
    'espanyol': 'espanol', 'rcd espanyol': 'espanol', 'deportivo alaves': 'alaves', 'cadiz cf': 'cadiz',
    'real valladolid': 'valladolid', 'cd leganes': 'leganes', 'ud las palmas': 'las palmas', 'real oviedo': 'oviedo',
    # Germany
    'bayern munich': 'bayern munich', 'fc bayern munchen': 'bayern munich', 'borussia dortmund': 'dortmund',
    'borussia monchengladbach': 'm gladbach', 'bayer leverkusen': 'leverkusen', 'eintracht frankfurt': 'ein frankfurt',
    'vfb stuttgart': 'stuttgart', 'fc st pauli': 'st pauli', 'tsg hoffenheim': 'hoffenheim',
    '1899 hoffenheim': 'hoffenheim', '1 fc heidenheim': 'heidenheim', 'fc heidenheim': 'heidenheim',
    '1 fc koln': 'fc koln', 'fc koln': 'fc koln', 'hamburger sv': 'hamburg', 'sv werder bremen': 'werder bremen',
    '1 fc union berlin': 'union berlin', 'fsv mainz 05': 'mainz', 'mainz 05': 'mainz', 'vfl wolfsburg': 'wolfsburg',
    'sc freiburg': 'freiburg', 'fc augsburg': 'augsburg', 'vfl bochum': 'bochum', 'holstein kiel': 'holstein kiel',
    # Italy
    'inter milan': 'inter', 'internazionale': 'inter', 'ac milan': 'milan', 'as roma': 'roma', 'hellas verona': 'verona',
    'ssc napoli': 'napoli', 'ss lazio': 'lazio',
    # Portugal / Netherlands
    'sporting lisbon': 'sp lisbon', 'sporting cp': 'sp lisbon', 'sc braga': 'braga', 'vitoria guimaraes': 'guimaraes',
    'psv eindhoven': 'psv eindhoven', 'az alkmaar': 'az alkmaar', 'feyenoord': 'feyenoord',
}


def key(name):
    n = norm(name)
    n = ALIASES.get(n, n)
    tokens = [t for t in n.split() if t not in STOP]
    return ' '.join(tokens) or n


def match_team(name, candidates):
    """Return (candidate, method, score) or (None, reason, score)."""
    if not candidates:
        return None, 'aucune donnée historique', 0.0
    def full(n):
        n = norm(n)
        return ALIASES.get(n, n)
    exact = [c for c in candidates if full(c) == full(name)]
    if len(exact) == 1:
        return exact[0], 'exact', 1.0
    by_key = {}
    for c in candidates:
        by_key.setdefault(key(c), []).append(c)
    k = key(name)
    if k in by_key and len(by_key[k]) == 1:
        # "Paris" must not silently become "Paris FC" when "Paris SG" also exists.
        rivals = [ck for ck in by_key if ck != k and set(k.split()) < set(ck.split())]
        if rivals:
            return None, 'nom ambigu', 0.5
        return by_key[k][0], 'exact', 1.0
    # token containment ("le mans" in "le mans fc" already handled; "lens" vs "rc lens")
    contain = [c for ck, cs in by_key.items() for c in cs
               if ck and k and (set(ck.split()) <= set(k.split()) or set(k.split()) <= set(ck.split()))]
    if len(contain) > 1:
        return None, 'nom ambigu', 0.5
    if len(contain) == 1:
        return contain[0], 'inclusion', 0.9
    scores = sorted(((difflib.SequenceMatcher(None, k, ck).ratio(), cs[0]) for ck, cs in by_key.items()),
                    reverse=True)
    best = scores[0]
    second = scores[1][0] if len(scores) > 1 else 0.0
    if best[0] >= 0.8 and best[0] - second >= 0.1:
        return best[1], 'approché', round(best[0], 3)
    return None, 'nom non reconnu dans l’historique', round(best[0], 3)

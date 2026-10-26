"""Export the fitted football models for the phone app (mobile/data/models.json).

The phone cannot download football-data.co.uk itself (no CORS), so team ratings
are fitted here and shipped as a small JSON file. Run:

    python export_mobile.py               # fit every covered league
    python export_mobile.py --backtest    # also re-run the validation (slower)
"""
from __future__ import annotations
import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backtest import run_backtest
from history import HistoryStore, LEAGUES
from model import DixonColes, norm
from storage import Storage
from teams import ALIASES, STOP

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'mobile' / 'data' / 'models.json'


def export_league(sport, store, storage, do_backtest):
    store.refresh(sport)
    matches, sources = store.load(sport)
    if len(matches) < 200:
        return None
    report = None
    if do_backtest:
        report = run_backtest(matches)
        storage.save_backtest(sport, report)
    else:
        bt = storage.latest_backtest(sport)
        report = bt['report'] if bt else None
    cfg = report['config'] if report else {'half_life_days': 240, 'prior_matches': 6.0}
    m = DixonColes(cfg['half_life_days'], cfg['prior_matches']).fit(matches)
    teams = {}
    for t, display in m.display.items():
        if not m.knows(t):
            continue
        teams[display] = {'att': round(m.att[t], 5), 'dfn': round(m.dfn[t], 5),
                          'se_att': round(m.se_att[t], 5), 'se_dfn': round(m.se_dfn[t], 5), 'n': m.team_n[t]}
    # Compact results of the last two years: form, home/away records and head-to-head
    # are computed on the phone from this list.
    cutoff = m.last_date - timedelta(days=730)
    recent = [x for x in matches if x['date'] >= cutoff]
    names = sorted({x['home'] for x in recent} | {x['away'] for x in recent})
    idx = {n: i for i, n in enumerate(names)}
    results = [[x['date'].isoformat(), idx[x['home']], idx[x['away']], x['hg'], x['ag']] for x in recent]
    validation = None
    if report:
        t = report['test_metrics']
        validation = {'validated': report['validated'], 'weight': report['live_weight'],
                      'test_n': report['periods']['test_n'], 'devig': report['config']['devig_method'],
                      'model_log_loss': t['model']['log_loss'], 'market_log_loss': t['market_open']['log_loss'],
                      'naive_log_loss': t['naive']['log_loss'], 'decision': report['decision']}
    return {'title': LEAGUES[sport][1], 'base': round(m.base, 5), 'home_adv': round(m.home_adv, 5),
            'rho': m.rho, 'matches': m.n_matches, 'last_date': m.last_date.isoformat(),
            'avg_total': round(m.base * (m.home_adv + 1), 4),
            'config': cfg, 'validation': validation, 'teams': teams, 'names': names, 'results': results}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backtest', action='store_true')
    parser.add_argument('--leagues', nargs='*')
    parser.add_argument('--out', default=str(OUT), help='fichier JSON à écrire')
    args = parser.parse_args()
    out = Path(args.out)
    store = HistoryStore(ROOT / 'data' / 'history')
    storage = Storage(ROOT / 'data' / 'oddscope.db')
    leagues = {}
    for sport in args.leagues or LEAGUES:
        try:
            data = export_league(sport, store, storage, args.backtest)
        except ValueError as e:
            print(sport, 'ignoré :', e)
            continue
        if data:
            leagues[sport] = data
            print(f"{sport}: {len(data['teams'])} équipes, {data['matches']} matchs")
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
               'source': 'football-data.co.uk', 'aliases': ALIASES, 'stop': sorted(STOP), 'leagues': leagues}
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print('Écrit :', out, f'({out.stat().st_size // 1024} Ko)')
    assert norm  # imported for parity with the JS normaliser


if __name__ == '__main__':
    main()

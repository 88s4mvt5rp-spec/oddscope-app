"""Free historical results + odds from football-data.co.uk (CSV files, no key needed).

Files are cached locally in data/history/. Finished seasons are downloaded once;
the current season is refreshed at most every 12 hours.
"""
from __future__ import annotations
import re
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path
from model import parse_csv

BASE_URL = 'https://www.football-data.co.uk/mmz4281/{season}/{code}.csv'
REFRESH_SECONDS = 12 * 3600

# The Odds API sport key -> football-data.co.uk division code
LEAGUES = {
    'soccer_france_ligue_one': ('F1', 'Ligue 1'),
    'soccer_france_ligue_two': ('F2', 'Ligue 2'),
    'soccer_epl': ('E0', 'Premier League'),
    'soccer_efl_champ': ('E1', 'Championship'),
    'soccer_england_league1': ('E2', 'League One'),
    'soccer_england_league2': ('E3', 'League Two'),
    'soccer_spain_la_liga': ('SP1', 'La Liga'),
    'soccer_spain_segunda_division': ('SP2', 'Segunda División'),
    'soccer_italy_serie_a': ('I1', 'Serie A'),
    'soccer_italy_serie_b': ('I2', 'Serie B'),
    'soccer_germany_bundesliga': ('D1', 'Bundesliga'),
    'soccer_germany_bundesliga2': ('D2', '2. Bundesliga'),
    'soccer_netherlands_eredivisie': ('N1', 'Eredivisie'),
    'soccer_portugal_primeira_liga': ('P1', 'Primeira Liga'),
    'soccer_belgium_first_div': ('B1', 'Jupiler Pro League'),
    'soccer_spl': ('SC0', 'Scottish Premiership'),
    'soccer_turkey_super_league': ('T1', 'Süper Lig'),
    'soccer_greece_super_league': ('G1', 'Super League Grèce'),
}


def season_code(start_year):
    return f'{start_year % 100:02d}{(start_year + 1) % 100:02d}'


def recent_seasons(n=5, today=None):
    today = today or date.today()
    current = today.year if today.month >= 7 else today.year - 1
    return [season_code(y) for y in range(current - n + 1, current + 1)]


class HistoryStore:
    def __init__(self, folder, opener=urllib.request.urlopen):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.opener = opener

    def path(self, code, season):
        return self.folder / f'{code}_{season}.csv'

    def custom_path(self, sport_key):
        if not re.fullmatch(r'[a-z0-9_]{3,90}', sport_key):
            raise ValueError('Sport invalide.')
        return self.folder / f'custom_{sport_key}.csv'

    def download(self, code, season, current):
        target = self.path(code, season)
        if target.exists():
            age = time.time() - target.stat().st_mtime
            if not current or age < REFRESH_SECONDS:
                return 'cache'
        url = BASE_URL.format(season=season, code=code)
        req = urllib.request.Request(url, headers={'User-Agent': 'OddscopeLocal/2.0 (usage personnel)'})
        try:
            with self.opener(req, timeout=20) as resp:
                content = resp.read()
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return 'absent'
            return 'cache' if target.exists() else f'erreur HTTP {err.code}'
        except (urllib.error.URLError, TimeoutError, OSError):
            return 'cache' if target.exists() else 'réseau indisponible'
        if len(content) < 200 or b'HomeTeam' not in content[:2000]:
            return 'cache' if target.exists() else 'fichier invalide'
        tmp = target.with_suffix('.tmp')
        tmp.write_bytes(content)
        tmp.replace(target)
        return 'téléchargé'

    def refresh(self, sport_key, seasons=None):
        if sport_key not in LEAGUES:
            raise ValueError('Championnat non couvert par football-data.co.uk.')
        code = LEAGUES[sport_key][0]
        seasons = seasons or recent_seasons()
        return {s: self.download(code, s, current=(s == seasons[-1])) for s in seasons}

    def load(self, sport_key, seasons=None):
        """All matches for a league (football-data seasons + any user CSV), sorted by date.

        Parsed results are cached until one of the files changes on disk."""
        files = []
        if sport_key in LEAGUES:
            files = [self.path(LEAGUES[sport_key][0], s) for s in seasons or recent_seasons()]
        files.append(self.custom_path(sport_key))
        signature = tuple((str(f), f.stat().st_mtime) for f in files if f.exists())
        cache = self.__dict__.setdefault('_cache', {})
        hit = cache.get(sport_key)
        if hit and hit[0] == signature:
            return [dict(m) for m in hit[1]], list(hit[2])
        matches, sources = self._load(sport_key, seasons)
        cache[sport_key] = (signature, matches, sources)
        return [dict(m) for m in matches], list(sources)

    def _load(self, sport_key, seasons=None):
        matches, sources = [], []
        if sport_key in LEAGUES:
            code = LEAGUES[sport_key][0]
            for s in seasons or recent_seasons():
                p = self.path(code, s)
                if p.exists():
                    try:
                        rows = parse_csv(p.read_text(encoding='utf-8-sig', errors='replace'), min_rows=1)
                    except ValueError:
                        continue
                    for r in rows:
                        r['season'] = s
                    matches.extend(rows)
                    sources.append({'season': s, 'matches': len(rows), 'updated': int(p.stat().st_mtime)})
        custom = self.custom_path(sport_key)
        if custom.exists():
            rows = parse_csv(custom.read_text(encoding='utf-8-sig', errors='replace'), min_rows=1)
            for r in rows:
                r['season'] = 'import'
            matches.extend(rows)
            sources.append({'season': 'import CSV', 'matches': len(rows), 'updated': int(custom.stat().st_mtime)})
        # de-duplicate (same date + teams) when a custom file overlaps football-data
        seen, unique = set(), []
        for m in sorted(matches, key=lambda m: m['date']):
            k = (m['date'], m['home'].casefold(), m['away'].casefold())
            if k not in seen:
                seen.add(k)
                unique.append(m)
        return unique, sources

    def save_custom(self, sport_key, content):
        parse_csv(content)                      # validate before storing
        self.custom_path(sport_key).write_text(content, encoding='utf-8')

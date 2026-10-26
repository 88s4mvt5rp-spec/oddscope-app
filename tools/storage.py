"""Local SQLite storage: odds snapshots, movements, API usage, tracked predictions, backtests."""
from __future__ import annotations
import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS fetches(
  id INTEGER PRIMARY KEY AUTOINCREMENT, sport_key TEXT NOT NULL, regions TEXT NOT NULL,
  fetched_at TEXT NOT NULL, n_events INTEGER, cost INTEGER, remaining INTEGER, used INTEGER,
  ok INTEGER NOT NULL, error TEXT);
CREATE INDEX IF NOT EXISTS fetches_sport ON fetches(sport_key, ok, fetched_at);
CREATE TABLE IF NOT EXISTS events(
  event_id TEXT PRIMARY KEY, sport_key TEXT, sport_title TEXT, home TEXT, away TEXT,
  commence_time TEXT, first_seen TEXT, last_seen TEXT,
  home_score INTEGER, away_score INTEGER, completed INTEGER DEFAULT 0, result_source TEXT);
CREATE TABLE IF NOT EXISTS odds(
  fetch_id INTEGER NOT NULL, event_id TEXT NOT NULL, bookmaker TEXT NOT NULL, bookmaker_title TEXT,
  outcome TEXT NOT NULL, price REAL NOT NULL, last_update TEXT);
CREATE INDEX IF NOT EXISTS odds_event ON odds(event_id, fetch_id);
CREATE INDEX IF NOT EXISTS odds_fetch ON odds(fetch_id);
CREATE TABLE IF NOT EXISTS movements(
  id INTEGER PRIMARY KEY AUTOINCREMENT, detected_at TEXT, sport_key TEXT, event_id TEXT,
  bookmaker TEXT, outcome TEXT, old_price REAL, new_price REAL, delta_prob REAL);
CREATE INDEX IF NOT EXISTS movements_sport ON movements(sport_key, detected_at);
CREATE TABLE IF NOT EXISTS predictions(
  event_id TEXT PRIMARY KEY, sport_key TEXT, home TEXT, away TEXT, commence_time TEXT,
  outcomes TEXT, first_at TEXT, last_at TEXT, first_json TEXT, last_json TEXT, n_updates INTEGER);
CREATE TABLE IF NOT EXISTS backtests(
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, sport_key TEXT, report TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
"""

MOVE_PROB_THRESHOLD = 0.025   # 2.5 points of implied probability


def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec='seconds')


class Storage:
    def __init__(self, path):
        self.path = str(path)
        if self.path != ':memory:':
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        with self.lock:
            if self.path != ':memory:':
                self.conn.execute('PRAGMA journal_mode=WAL')
            self.conn.executescript(SCHEMA)
            self.conn.commit()

    def q(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    # ----------------------------------------------------------------- settings
    def get_setting(self, key, default=None):
        rows = self.q('SELECT value FROM settings WHERE key=?', (key,))
        return json.loads(rows[0]['value']) if rows else default

    def set_setting(self, key, value):
        with self.lock:
            self.conn.execute('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                              (key, json.dumps(value)))
            self.conn.commit()

    # ----------------------------------------------------------------- fetches / odds
    def record_failure(self, sport_key, regions, error, usage=None):
        usage = usage or {}
        with self.lock:
            self.conn.execute('INSERT INTO fetches(sport_key, regions, fetched_at, cost, remaining, used, ok, error) '
                              'VALUES(?,?,?,?,?,?,0,?)',
                              (sport_key, regions, iso(utcnow()), usage.get('last'), usage.get('remaining'),
                               usage.get('used'), error[:300]))
            self.conn.commit()

    def store_snapshot(self, sport_key, regions, events, usage, fetched_at=None):
        """Store a full odds snapshot and detect significant moves vs the previous one."""
        fetched_at = fetched_at or utcnow()
        with self.lock:
            prev = self.latest_fetch(sport_key)
            prev_prices = {}
            if prev:
                for r in self.conn.execute('SELECT event_id, bookmaker, outcome, price FROM odds WHERE fetch_id=?',
                                           (prev['id'],)):
                    prev_prices[(r[0], r[1], r[2])] = r[3]
            cur = self.conn.execute(
                'INSERT INTO fetches(sport_key, regions, fetched_at, n_events, cost, remaining, used, ok) '
                'VALUES(?,?,?,?,?,?,?,1)',
                (sport_key, regions, iso(fetched_at), len(events), usage.get('last'), usage.get('remaining'),
                 usage.get('used')))
            fetch_id = cur.lastrowid
            rows, moves = [], []
            for ev in events:
                eid = str(ev.get('id', ''))
                if not eid:
                    continue
                self.conn.execute(
                    'INSERT INTO events(event_id, sport_key, sport_title, home, away, commence_time, first_seen, last_seen) '
                    'VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET commence_time=excluded.commence_time, '
                    'last_seen=excluded.last_seen, home=excluded.home, away=excluded.away',
                    (eid, sport_key, ev.get('sport_title'), ev.get('home_team'), ev.get('away_team'),
                     ev.get('commence_time'), iso(fetched_at), iso(fetched_at)))
                for b in ev.get('bookmakers', []) or []:
                    for m in b.get('markets', []) or []:
                        if m.get('key') != 'h2h':
                            continue
                        for o in m.get('outcomes', []) or []:
                            try:
                                price = float(o.get('price'))
                            except (TypeError, ValueError):
                                continue
                            k = (eid, str(b.get('key')), str(o.get('name')))
                            rows.append((fetch_id, k[0], k[1], b.get('title'), k[2], price, b.get('last_update')))
                            old = prev_prices.get(k)
                            if old and price > 1 and old > 1:
                                delta = 1 / price - 1 / old
                                if abs(delta) >= MOVE_PROB_THRESHOLD:
                                    moves.append((iso(fetched_at), sport_key, *k, old, price, delta))
            self.conn.executemany('INSERT INTO odds(fetch_id, event_id, bookmaker, bookmaker_title, outcome, price, '
                                  'last_update) VALUES(?,?,?,?,?,?,?)', rows)
            self.conn.executemany('INSERT INTO movements(detected_at, sport_key, event_id, bookmaker, outcome, '
                                  'old_price, new_price, delta_prob) VALUES(?,?,?,?,?,?,?,?)', moves)
            self.conn.commit()
        return fetch_id, len(moves)

    def latest_fetch(self, sport_key):
        rows = self.q('SELECT * FROM fetches WHERE sport_key=? AND ok=1 ORDER BY id DESC LIMIT 1', (sport_key,))
        return rows[0] if rows else None

    def last_attempt(self, sport_key):
        rows = self.q('SELECT * FROM fetches WHERE sport_key=? ORDER BY id DESC LIMIT 1', (sport_key,))
        return rows[0] if rows else None

    def snapshot_events(self, fetch):
        """Rebuild Odds-API-shaped events from a stored snapshot."""
        if not fetch:
            return []
        events = {}
        for r in self.q('SELECT o.*, e.home, e.away, e.commence_time, e.sport_key, e.sport_title FROM odds o '
                        'JOIN events e ON e.event_id=o.event_id WHERE o.fetch_id=?', (fetch['id'],)):
            ev = events.setdefault(r['event_id'], {
                'id': r['event_id'], 'sport_key': r['sport_key'], 'sport_title': r['sport_title'],
                'home_team': r['home'], 'away_team': r['away'], 'commence_time': r['commence_time'], 'books': {}})
            book = ev['books'].setdefault(r['bookmaker'], {'key': r['bookmaker'], 'title': r['bookmaker_title'],
                                                           'last_update': r['last_update'],
                                                           'markets': [{'key': 'h2h', 'outcomes': []}]})
            book['markets'][0]['outcomes'].append({'name': r['outcome'], 'price': r['price']})
        out = []
        for ev in events.values():
            ev['bookmakers'] = list(ev.pop('books').values())
            out.append(ev)
        return out

    def odds_history(self, event_id):
        return self.q('SELECT f.fetched_at, o.bookmaker, o.bookmaker_title, o.outcome, o.price FROM odds o '
                      'JOIN fetches f ON f.id=o.fetch_id WHERE o.event_id=? ORDER BY f.fetched_at', (event_id,))

    def movements(self, sport_key=None, event_id=None, limit=50):
        sql = ('SELECT m.*, e.home, e.away, e.commence_time FROM movements m LEFT JOIN events e '
               'ON e.event_id=m.event_id WHERE 1=1')
        args = []
        if sport_key:
            sql += ' AND m.sport_key=?'
            args.append(sport_key)
        if event_id:
            sql += ' AND m.event_id=?'
            args.append(event_id)
        sql += ' ORDER BY m.id DESC LIMIT ?'
        args.append(int(limit))
        return self.q(sql, args)

    def usage(self):
        rows = self.q('SELECT fetched_at, remaining, used, cost FROM fetches WHERE remaining IS NOT NULL '
                      'ORDER BY id DESC LIMIT 1')
        last = self.get_setting('api_usage')
        candidates = [r for r in [rows[0] if rows else None, last] if r]
        if not candidates:
            return None
        return max(candidates, key=lambda r: r.get('fetched_at') or '')

    def record_usage(self, usage):
        if usage.get('remaining') is not None:
            self.set_setting('api_usage', {**usage, 'fetched_at': iso(utcnow())})

    # ----------------------------------------------------------------- predictions tracking
    def track_prediction(self, event, now=None):
        """Keep the first and latest pre-kick-off estimate of each real (non-demo) event."""
        now = now or utcnow()
        if event['start'] <= iso(now):
            return
        snap = {'at': iso(now), 'market': event['market']['probs'],
                'model': event['model']['probs'] if event.get('model') else None,
                'retained': event['retained']['probs'], 'model_weight': event['retained']['model_weight'],
                'best': {o: b['price'] for o, b in event['best'].items()},
                'reliability': event['reliability']['score'], 'books': event['books_used'],
                'market_source': event['market']['source']}
        payload = json.dumps(snap)
        with self.lock:
            self.conn.execute(
                'INSERT INTO predictions(event_id, sport_key, home, away, commence_time, outcomes, first_at, last_at, '
                'first_json, last_json, n_updates) VALUES(?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(event_id) DO UPDATE SET '
                'last_at=excluded.last_at, last_json=excluded.last_json, commence_time=excluded.commence_time, '
                'n_updates=predictions.n_updates+1',
                (event['id'], event['sport_key'], event['home'], event['away'], event['start'],
                 json.dumps(event['outcomes']), iso(now), iso(now), payload, payload))
            self.conn.commit()

    def predictions(self, sport_key=None):
        sql = ('SELECT p.*, e.home_score, e.away_score, e.completed, e.result_source FROM predictions p '
               'LEFT JOIN events e ON e.event_id=p.event_id')
        args = ()
        if sport_key:
            sql += ' WHERE p.sport_key=?'
            args = (sport_key,)
        rows = self.q(sql + ' ORDER BY p.commence_time DESC', args)
        for r in rows:
            r['outcomes'] = json.loads(r['outcomes'])
            r['first'] = json.loads(r.pop('first_json'))
            r['last'] = json.loads(r.pop('last_json'))
        return rows

    def set_result(self, event_id, home_score, away_score, source):
        with self.lock:
            self.conn.execute('UPDATE events SET home_score=?, away_score=?, completed=1, result_source=? '
                              'WHERE event_id=?', (home_score, away_score, source, event_id))
            self.conn.commit()

    def unsettled_events(self, sport_key, now=None):
        now = now or utcnow()
        return self.q('SELECT p.event_id, p.home, p.away, p.commence_time, p.sport_key FROM predictions p '
                      'JOIN events e ON e.event_id=p.event_id WHERE p.sport_key=? AND COALESCE(e.completed,0)=0 '
                      'AND p.commence_time < ?', (sport_key, iso(now)))

    # ----------------------------------------------------------------- backtests
    def save_backtest(self, sport_key, report):
        with self.lock:
            self.conn.execute('INSERT INTO backtests(created_at, sport_key, report) VALUES(?,?,?)',
                              (iso(utcnow()), sport_key, json.dumps(report, default=str)))
            self.conn.commit()

    def backtests(self, sport_key=None, limit=20):
        sql, args = 'SELECT * FROM backtests', []
        if sport_key:
            sql += ' WHERE sport_key=?'
            args.append(sport_key)
        rows = self.q(sql + ' ORDER BY id DESC LIMIT ?', args + [limit])
        for r in rows:
            r['report'] = json.loads(r['report'])
        return rows

    def latest_backtest(self, sport_key):
        rows = self.backtests(sport_key, 1)
        return rows[0] if rows else None

'use strict';
/* ODDSCOPE mobile engine — JavaScript port of engine.py, model.py (prediction), teams.py and picks.py.
   Kept numerically identical to the Python version (checked by tests/test_mobile_engine.js). */
(function (root) {
  const STALE_MINUTES = 45, OBSOLETE_MINUTES = 60, MIN_CONSENSUS_BOOKS = 3, MIN_RELIABILITY_TO_RANK = 50;
  const SHARP_BOOKS = new Set(['pinnacle', 'betfair_ex_eu', 'betfair_ex_uk', 'betfair_ex_au', 'matchbook', 'smarkets']);
  const Z90 = 1.645, MAX_GOALS = 10;

  const sum = a => a.reduce((x, y) => x + y, 0);
  const pstdev = a => { if (a.length < 2) return 0; const m = sum(a) / a.length; return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / a.length); };
  const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const clip = p => Math.min(0.999, Math.max(0.001, p));
  const mapObj = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v, k)]));
  const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

  /* ---------------------------------------------------------------- margin removal */
  const overround = prices => sum(Object.values(prices).map(p => 1 / p)) - 1;
  function devigMultiplicative(prices) {
    const imp = mapObj(prices, p => 1 / p), t = sum(Object.values(imp));
    return mapObj(imp, q => q / t);
  }
  function devigPower(prices) {
    const imp = mapObj(prices, p => 1 / p);
    if (sum(Object.values(imp)) <= 1) return devigMultiplicative(prices);
    let lo = 1, hi = 10;
    for (let i = 0; i < 100; i++) { const k = (lo + hi) / 2; if (sum(Object.values(imp).map(q => q ** k)) > 1) lo = k; else hi = k; }
    const k = (lo + hi) / 2, pr = mapObj(imp, q => q ** k), t = sum(Object.values(pr));
    return mapObj(pr, p => p / t);
  }
  function devigShin(prices) {
    const imp = mapObj(prices, p => 1 / p), s = sum(Object.values(imp));
    if (s <= 1 || Object.keys(imp).length < 2) return devigMultiplicative(prices);
    const probsFor = z => mapObj(imp, q => (Math.sqrt(z * z + 4 * (1 - z) * q * q / s) - z) / (2 * (1 - z)));
    let lo = 0, hi = 0.4;
    for (let i = 0; i < 100; i++) { const z = (lo + hi) / 2; if (sum(Object.values(probsFor(z))) > 1) lo = z; else hi = z; }
    const pr = probsFor((lo + hi) / 2), t = sum(Object.values(pr));
    return mapObj(pr, p => p / t);
  }
  const devig = (prices, method) => method === 'power' ? devigPower(prices) : method === 'multiplicative' ? devigMultiplicative(prices) : devigShin(prices);

  /* ---------------------------------------------------------------- parsing */
  const parseDate = s => { const d = new Date(s); return isNaN(d) ? null : d; };
  const isFrenchBook = k => String(k).endsWith('_fr');
  function extractBook(book, wanted) {
    for (const m of book.markets || []) {
      if (m.key !== 'h2h') continue;
      const values = {};
      for (const o of m.outcomes || []) {
        const price = Number(o.price), name = String(o.name ?? '');
        if (isFinite(price) && price > 1.001 && price < 1000 && wanted.includes(name)) values[name] = price;
      }
      if (Object.keys(values).length === wanted.length) {
        const ov = overround(values);
        if (ov < -0.02 || ov > 0.35) return null;
        return values;
      }
    }
    return null;
  }
  const outcomeLabel = (o, home, away) => o === 'Draw' ? 'Nul' : o === home ? '1 · ' + home : o === away ? '2 · ' + away : o;

  /* ---------------------------------------------------------------- market reference */
  function marketReference(books, outcomes, method, excludeKey) {
    const pool = books.filter(b => b.key !== excludeKey);
    if (!pool.length) return null;
    const dv = pool.map(b => devig(b.odds, method));
    const dispersion = Object.fromEntries(outcomes.map(o => [o, dv.length > 1 ? pstdev(dv.map(d => d[o])) : 0]));
    const sharp = dv.filter((d, i) => SHARP_BOOKS.has(pool[i].key));
    let raw, se, source;
    if (sharp.length) {
      raw = Object.fromEntries(outcomes.map(o => [o, sum(sharp.map(d => d[o])) / sharp.length]));
      se = Object.fromEntries(outcomes.map(o => [o, sharp.length > 1 ? Math.max(0.010, pstdev(sharp.map(d => d[o])) / Math.sqrt(sharp.length)) : 0.012]));
      source = 'sharp';
    } else if (pool.length >= MIN_CONSENSUS_BOOKS) {
      raw = Object.fromEntries(outcomes.map(o => [o, median(dv.map(d => d[o]))]));
      const inflate = pool.length === MIN_CONSENSUS_BOOKS ? 1.25 : 1;
      se = Object.fromEntries(outcomes.map(o => [o, inflate * Math.max(0.015, 1.2533 * dispersion[o] / Math.sqrt(pool.length))]));
      source = 'consensus';
    } else return null;
    const t = sum(Object.values(raw));
    return {probs: mapObj(raw, v => v / t), se, dispersion, n: pool.length, n_sharp: sharp.length, source};
  }
  function combine(market, modelProbs, modelSe, weight) {
    const p = {}, se = {};
    for (const o of Object.keys(market.probs)) {
      if (modelProbs && weight > 0) {
        p[o] = (1 - weight) * market.probs[o] + weight * modelProbs[o];
        se[o] = Math.sqrt(((1 - weight) * market.se[o]) ** 2 + (weight * modelSe[o]) ** 2);
      } else { p[o] = market.probs[o]; se[o] = market.se[o]; }
    }
    const t = sum(Object.values(p));
    return [mapObj(p, v => v / t), se];
  }

  function reliability(nBooks, nSharp, maxAge, snapshotAge, meanDisp, modelState) {
    let score = 0; const flags = [];
    score += Math.round(35 * Math.min(nBooks, 8) / 8);
    if (nBooks < 4) flags.push(`Seulement ${nBooks} bookmaker(s) exploitables`);
    if (maxAge == null || maxAge > OBSOLETE_MINUTES) flags.push('Cotes du fournisseur anciennes de plus d’une heure');
    else if (maxAge <= 10) score += 20; else if (maxAge <= 30) score += 15; else score += 8;
    if (snapshotAge != null && snapshotAge > OBSOLETE_MINUTES) { score -= 20; flags.push(`Dernière actualisation il y a ${Math.floor(snapshotAge)} min : données obsolètes`); }
    if (nSharp) score += 15; else flags.push('Aucune référence « sharp » (Pinnacle, exchange) : estimation moins précise');
    if (meanDisp < 0.015) score += 20;
    else if (meanDisp < 0.03) score += 12;
    else if (meanDisp < 0.05) { score += 5; flags.push('Désaccord notable entre bookmakers'); }
    else flags.push('Fort désaccord entre bookmakers (cote erronée ou information récente ?)');
    if (modelState === 'validated') score += 10; else if (modelState === 'available') score += 3;
    score = Math.max(0, Math.min(100, score));
    const label = score >= 70 ? 'Élevée' : score >= MIN_RELIABILITY_TO_RANK ? 'Moyenne' : score >= 30 ? 'Faible' : 'Insuffisante';
    return {score, label, flags};
  }
  const uncertaintyLabel = w => w < 4 ? 'Faible' : w < 8 ? 'Modérée' : 'Élevée';

  /* ---------------------------------------------------------------- Dixon-Coles prediction */
  function poissonPmf(mu) { const out = []; let p = Math.exp(-mu); for (let k = 0; k <= MAX_GOALS; k++) { out.push(p); p *= mu / (k + 1); } return out; }
  function tau(h, a, lh, la, rho) {
    if (h === 0 && a === 0) return 1 - lh * la * rho;
    if (h === 0 && a === 1) return 1 + lh * rho;
    if (h === 1 && a === 0) return 1 + la * rho;
    if (h === 1 && a === 1) return 1 - rho;
    return 1;
  }
  function outcomeProbs(lh, la, rho = 0) {
    const ph = poissonPmf(lh), pa = poissonPmf(la), res = [0, 0, 0];
    for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) {
      let p = ph[h] * pa[a];
      if (h < 2 && a < 2) p *= Math.max(0, tau(h, a, lh, la, rho));
      res[h > a ? 0 : h === a ? 1 : 2] += p;
    }
    const s = sum(res);
    return res.map(x => x / s);
  }
  // Deterministic PRNG + Box-Muller (interval simulation; not bit-identical to Python's, same method).
  function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

  function predict(league, home, away, draws = 200) {
    const h = league.teams[home], a = league.teams[away];
    if (!h || !a) return null;
    const lam = (x, y, adv) => Math.max(0.05, Math.min(6, league.base * adv * x.att * y.dfn));
    const lh = lam(h, a, league.home_adv), la = lam(a, h, 1);
    const probs = outcomeProbs(lh, la, league.rho);
    const r = rng(3), sh = Math.sqrt(h.se_att ** 2 + a.se_dfn ** 2), sa = Math.sqrt(a.se_att ** 2 + h.se_dfn ** 2);
    const sims = Array.from({length: draws}, () => outcomeProbs(lh * Math.exp(gauss(r) * sh), la * Math.exp(gauss(r) * sa), league.rho));
    const low = [], high = [], se = [];
    for (let i = 0; i < 3; i++) {
      const col = sims.map(s => s[i]).sort((x, y) => x - y), m = sum(col) / draws;
      low.push(round(col[Math.floor(0.05 * draws)], 4)); high.push(round(col[Math.floor(0.95 * draws) - 1], 4));
      se.push(Math.sqrt(sum(col.map(c => (c - m) ** 2)) / draws));
    }
    return {probs, low, high, se, xg_home: round(lh, 2), xg_away: round(la, 2)};
  }

  /* ---------------------------------------------------------------- team names */
  const norm = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  function makeMatcher(aliases, stop) {
    const STOP = new Set(stop);
    const full = n => { const x = norm(n); return aliases[x] || x; };
    const key = n => { const x = full(n); const t = x.split(' ').filter(w => !STOP.has(w)); return t.join(' ') || x; };
    const bigrams = s => { const out = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); } return out; };
    const dice = (a, b) => { if (a === b) return 1; if (a.length < 2 || b.length < 2) return 0; const A = bigrams(a), B = bigrams(b); let inter = 0; for (const [g, c] of A) inter += Math.min(c, B.get(g) || 0); return 2 * inter / (a.length + b.length - 2); };
    return function match(name, candidates) {
      if (!candidates.length) return [null, 'aucune donnée historique'];
      const exact = candidates.filter(c => full(c) === full(name));
      if (exact.length === 1) return [exact[0], 'exact'];
      const byKey = new Map();
      for (const c of candidates) { const k = key(c); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(c); }
      const k = key(name), kt = new Set(k.split(' '));
      const subset = (x, y) => [...x].every(w => y.has(w));
      if (byKey.has(k) && byKey.get(k).length === 1) {
        const rivals = [...byKey.keys()].filter(ck => ck !== k && subset(kt, new Set(ck.split(' '))) && ck.split(' ').length > kt.size);
        if (rivals.length) return [null, 'nom ambigu'];
        return [byKey.get(k)[0], 'exact'];
      }
      const contain = [];
      for (const [ck, cs] of byKey) { const ct = new Set(ck.split(' ')); if (ck && k && (subset(ct, kt) || subset(kt, ct))) contain.push(...cs); }
      if (contain.length > 1) return [null, 'nom ambigu'];
      if (contain.length === 1) return [contain[0], 'inclusion'];
      const scores = [...byKey.entries()].map(([ck, cs]) => [dice(k, ck), cs[0]]).sort((x, y) => y[0] - x[0]);
      const best = scores[0], second = scores[1] ? scores[1][0] : 0;
      if (best[0] >= 0.8 && best[0] - second >= 0.1) return [best[1], 'approché'];
      return [null, 'nom non reconnu dans l’historique'];
    };
  }

  /* ---------------------------------------------------------------- event analysis */
  function analyzeEvent(ev, now, opts = {}) {
    const {sportName = '', modelPredict = null, modelWeight = 0, booksFilter = null, method = 'shin', snapshotAge = null} = opts;
    const start = parseDate(ev.commence_time);
    if (!start) return [null, 'invalid'];
    if (start <= now) return [null, 'started'];
    const home = String(ev.home_team ?? ''), away = String(ev.away_team ?? '');
    if (!home || !away || home === away) return [null, 'invalid'];
    const sportKey = String(ev.sport_key ?? '');
    const drawExists = (ev.bookmakers || []).some(b => (b.markets || []).some(m => m.key === 'h2h' && (m.outcomes || []).some(o => o.name === 'Draw')));
    const isSoccer = sportKey.startsWith('soccer_');
    if (isSoccer && !drawExists) return [null, 'invalid'];
    const outcomes = drawExists ? [home, 'Draw', away] : [home, away];
    let books = [];
    for (const b of ev.bookmakers || []) {
      const odds = extractBook(b, outcomes), updated = parseDate(b.last_update), key = String(b.key ?? '');
      if (!odds || !updated || !key) continue;
      books.push({key, title: String(b.title || key), odds, updated});
    }
    books = [...new Map(books.map(b => [b.key, b])).values()];
    if (!books.length) return [null, 'insufficient_books'];
    const newest = Math.max(...books.map(b => b.updated.getTime()));
    const fresh = [];
    for (const b of books) {
      b.age_minutes = round(Math.max(0, (now - b.updated) / 60000), 1);
      b.stale = (newest - b.updated.getTime()) / 60000 > STALE_MINUTES;
      b.overround = overround(b.odds); b.is_sharp = SHARP_BOOKS.has(b.key); b.is_fr = isFrenchBook(b.key);
      b.selected = !booksFilter || booksFilter.has(b.key);
      if (!b.stale) fresh.push(b);
    }
    const market = marketReference(fresh, outcomes, method);
    if (!market) return [null, 'insufficient_books'];
    let modelPred = null, modelReason = 'Modèle disponible uniquement pour les championnats de football couverts';
    if (modelPredict && isSoccer && outcomes.length === 3) [modelPred, modelReason] = modelPredict(home, away);
    let modelProbs = null, modelSe = null;
    if (modelPred) { modelProbs = Object.fromEntries(outcomes.map((o, i) => [o, modelPred.probs[i]])); modelSe = Object.fromEntries(outcomes.map((o, i) => [o, modelPred.se[i]])); }
    const weight = modelProbs ? modelWeight : 0;
    const [retained, retainedSe] = combine(market, modelProbs, modelSe, weight);
    const selected = fresh.filter(b => b.selected), best = {};
    for (const o of outcomes) if (selected.length) { const top = selected.reduce((x, y) => y.odds[o] > x.odds[o] ? y : x); best[o] = {price: top.odds[o], bookmaker: top.title, key: top.key}; }
    const analysis = [];
    for (const o of outcomes) {
      if (!best[o]) continue;
      const loo = marketReference(fresh, outcomes, method, best[o].key);
      if (!loo) continue;
      const [pRef, seRef] = combine(loo, modelProbs, modelSe, weight);
      const p = pRef[o], se = seRef[o], lo = clip(p - Z90 * se), hi = clip(p + Z90 * se), price = best[o].price;
      analysis.push({outcome: o, label: outcomeLabel(o, home, away), best_price: price, best_book: best[o].bookmaker, best_book_key: best[o].key,
        reference_books: loo.n, reference_source: loo.source, probability: round(p, 4), p_low: round(lo, 4), p_high: round(hi, 4),
        fair_odds: round(1 / p, 3), edge: round(p * price - 1, 4), edge_low: round(lo * price - 1, 4), edge_high: round(hi * price - 1, 4),
        significant: lo * price - 1 > 0});
    }
    const maxAge = Math.max(...fresh.map(b => b.age_minutes));
    const meanDisp = sum(Object.values(market.dispersion)) / outcomes.length;
    const modelState = modelProbs && weight > 0 ? 'validated' : modelProbs ? 'available' : 'none';
    const rel = reliability(fresh.length, market.n_sharp, maxAge, snapshotAge, meanDisp, modelState);
    const staleBooks = books.filter(b => b.stale).map(b => b.title);
    if (staleBooks.length) rel.flags.push('Ignorés car en retard sur les autres : ' + staleBooks.join(', '));
    if (!selected.length) rel.flags.push('Aucun des bookmakers filtrés ne propose ce match');
    if (!modelPred && isSoccer) rel.flags.push(modelReason);
    const width = Math.max(...outcomes.map(o => retainedSe[o] * 2 * Z90)) * 100;
    const bestMargin = Object.keys(best).length === outcomes.length ? sum(outcomes.map(o => 1 / best[o].price)) - 1 : null;
    const topGap = analysis.length ? analysis.reduce((x, y) => y.edge > x.edge ? y : x) : null;
    const eligible = rel.score >= MIN_RELIABILITY_TO_RANK && analysis.length > 0 && (snapshotAge == null || snapshotAge <= OBSOLETE_MINUTES) && maxAge <= OBSOLETE_MINUTES;
    return [{
      id: String(ev.id ?? ''), sport_key: sportKey, sport_title: sportName || String(ev.sport_title || 'Sport'),
      home, away, start: start.toISOString(), outcomes, labels: Object.fromEntries(outcomes.map(o => [o, outcomeLabel(o, home, away)])),
      bookmakers: books.sort((x, y) => (x.is_fr === y.is_fr ? x.title.localeCompare(y.title) : x.is_fr ? -1 : 1))
        .map(b => ({key: b.key, title: b.title, odds: b.odds, age_minutes: b.age_minutes, overround: round(b.overround, 4), stale: b.stale, is_sharp: b.is_sharp, is_fr: b.is_fr, selected: b.selected})),
      books_used: fresh.length, books_selected: selected.length, best, best_margin: bestMargin == null ? null : round(bestMargin, 4),
      market: {probs: mapObj(market.probs, v => round(v, 4)), se: mapObj(market.se, v => round(v, 4)), dispersion: mapObj(market.dispersion, v => round(v, 4)), source: market.source, n: market.n, n_sharp: market.n_sharp, method},
      model: modelProbs ? {probs: mapObj(modelProbs, v => round(v, 4)), low: Object.fromEntries(outcomes.map((o, i) => [o, modelPred.low[i]])), high: Object.fromEntries(outcomes.map((o, i) => [o, modelPred.high[i]])), xg_home: modelPred.xg_home, xg_away: modelPred.xg_away, matched: modelPred.matched, weight} : null,
      model_status: modelState === 'validated' ? `Validé hors échantillon, poids ${Math.round(weight * 100)} %` : modelState === 'available' ? 'Affiché, non utilisé (non validé contre le marché)' : modelReason,
      retained: {probs: mapObj(retained, v => round(v, 4)), low: mapObj(retained, (v, o) => round(clip(v - Z90 * retainedSe[o]), 4)), high: mapObj(retained, (v, o) => round(clip(v + Z90 * retainedSe[o]), 4)), model_weight: weight},
      analysis, top_gap: topGap, reliability: rel, uncertainty: {width_pts: round(width, 1), label: uncertaintyLabel(width)}, eligible, max_age_minutes: maxAge,
    }, null];
  }

  /* ---------------------------------------------------------------- picks */
  const STAR_RULES = [[5, 'Value confirmée', a => a.edge_low > 0], [4, 'Value', a => a.edge >= 0.02], [3, 'Légère value', a => a.edge > 0],
    [2, 'Cote quasi juste', a => a.edge >= -0.02], [1, 'Marge faible', a => a.edge >= -0.04]];
  function rate(a) { for (const [s, l, f] of STAR_RULES) if (f(a)) return [s, l]; return [0, 'Marge élevée']; }
  const fpct = (x, signed) => (signed && x > 0 ? '+' : '') + (x * 100).toFixed(1).replace('.', ',') + ' %';
  const fodds = x => x.toFixed(2).replace('.', ',');
  function explain(e, a, stars) {
    let s = `${a.best_book} paie ${fodds(a.best_price)} alors que la probabilité estimée est de ${fpct(a.probability)} (entre ${fpct(a.p_low)} et ${fpct(a.p_high)}), soit une cote juste de ${fodds(a.fair_odds)}. `;
    if (stars >= 3) s += `Le prix est supérieur à la cote juste : rendement théorique ${fpct(a.edge, true)} par euro misé.` + (stars < 5 ? ' L’écart reste dans la marge d’incertitude.' : '');
    else s += `Le prix est inférieur à la cote juste (${fpct(a.edge, true)} par euro misé en moyenne) : c’est l’un des meilleurs prix du jour, mais il n’y a pas de value.`;
    s += a.reference_source === 'sharp' ? ' Référence : Pinnacle / Betfair.' : ` Référence : médiane de ${a.reference_books} bookmakers.`;
    if (e.model && e.model.probs[a.outcome] != null) {
      const mp = e.model.probs[a.outcome];
      s += ` Le modèle statistique donne ${fpct(mp)} (${Math.abs(mp - a.probability) <= 0.05 ? 'cohérent' : 'avis différent'}${e.retained.model_weight ? '' : ', non utilisé dans le calcul'}).`;
    }
    return s;
  }
  function buildPicks(boards, now, horizonHours = 168) {
    const limit = now.getTime() + horizonHours * 3600000, cands = [], excluded = {unreliable: 0, later: 0};
    for (const d of boards) for (const e of d.events) {
      if (new Date(e.start).getTime() > limit) { excluded.later++; continue; }
      if (!e.eligible) { excluded.unreliable++; continue; }
      for (const a of e.analysis) {
        const [stars, label] = rate(a);
        cands.push({sport: d.sport, competition: d.sport_title, event_id: e.id, home: e.home, away: e.away, start: e.start, outcome: a.outcome,
          selection: a.outcome === 'Draw' ? 'Match nul' : 'Victoire ' + a.outcome, odds: a.best_price, bookmaker: a.best_book,
          probability: a.probability, p_low: a.p_low, p_high: a.p_high, fair_odds: a.fair_odds, edge: a.edge, edge_low: a.edge_low, edge_high: a.edge_high,
          stars, label, reliability: e.reliability.score, reliability_label: e.reliability.label, uncertainty: e.uncertainty.label,
          model_probability: e.model ? e.model.probs[a.outcome] : null, explanation: explain(e, a, stars)});
      }
    }
    const bestPer = (items, key) => { const seen = new Set(); return [...items].sort((x, y) => { const a = key(x), b = key(y); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? -1 : 1; return 0; }).filter(c => !seen.has(c.event_id) && seen.add(c.event_id)); };
    const value = bestPer(cands, c => [c.edge_low > 0 ? 1 : 0, c.edge, c.reliability]);
    const probable = bestPer(cands, c => [c.probability, c.edge]);
    const withValue = value.filter(c => c.stars >= 3).length;
    return {value: value.slice(0, 40), probable: probable.slice(0, 40),
      summary: {candidates: cands.length, with_value: withValue, confirmed: value.filter(c => c.stars === 5).length, matches: new Set(cands.map(c => c.event_id)).size, excluded, horizon_hours: horizonHours},
      verdict: !cands.length ? 'Aucune rencontre exploitable : lance « Analyser » pour récupérer des cotes à jour.' :
        withValue ? `${withValue} pari(s) avec value aujourd’hui.` :
        'Aucun pari avec value pour le moment : les cotes françaises sont toutes sous leur prix juste. Les sélections ci-dessous sont les meilleurs prix disponibles, classés du moins coûteux au plus coûteux.'};
  }

  /* ---------------------------------------------------------------- whole competition */
  function analyzeCompetition(events, opts = {}) {
    const now = opts.now || new Date(), out = [], skipped = {started: 0, insufficient_books: 0, invalid: 0};
    for (const ev of events || []) { const [r, why] = analyzeEvent(ev, now, opts); if (r) out.push(r); else skipped[why]++; }
    out.sort((a, b) => a.start < b.start ? -1 : 1);
    return {events: out, skipped};
  }
  function modelPredictor(league, matcher) {
    if (!league) return null;
    const names = Object.keys(league.teams), cache = new Map();
    const resolve = n => { if (!cache.has(n)) cache.set(n, matcher(n, names)); return cache.get(n); };
    return (home, away) => {
      const [h] = resolve(home), [a] = resolve(away);
      if (!h || !a) return [null, `Modèle indisponible : « ${!h ? home : away} » introuvable dans l’historique`];
      const p = predict(league, h, a);
      if (!p) return [null, 'Modèle indisponible : historique insuffisant pour une des équipes'];
      p.matched = {home: h, away: a};
      return [p, null];
    };
  }

  const api = {devig, devigShin, devigPower, devigMultiplicative, overround, extractBook, marketReference, analyzeEvent, analyzeCompetition,
    outcomeProbs, predict, makeMatcher, modelPredictor, buildPicks, rate, norm, SHARP_BOOKS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);

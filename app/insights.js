'use strict';
/* ODDSCOPE — match insights: secondary markets derived from a market-consistent score model,
   Safe / Mi-safe / Risqué selections per match, team statistics and plain-French explanations.
   Every number comes from real odds or real past results; nothing here is invented. */
(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const MAXG = 10;
  const TIERS = {safe: [0.68, 0.90], mid: [0.45, 0.68], risky: [0.15, 0.45]};
  const sum = a => a.reduce((x, y) => x + y, 0);
  const r4 = x => Math.round(x * 1e4) / 1e4;
  const pct = p => (p * 100).toFixed(0) + ' %';
  const odds = x => x.toFixed(2).replace('.', ',');

  /* ------------------------------------------------------------ score model */
  function pmf(mu) { const o = []; let p = Math.exp(-mu); for (let k = 0; k <= MAXG; k++) { o.push(p); p *= mu / (k + 1); } return o; }
  function tau(h, a, lh, la, rho) {
    if (h === 0 && a === 0) return 1 - lh * la * rho;
    if (h === 0 && a === 1) return 1 + lh * rho;
    if (h === 1 && a === 0) return 1 + la * rho;
    if (h === 1 && a === 1) return 1 - rho;
    return 1;
  }
  function scoreMatrix(lh, la, rho = 0) {
    const ph = pmf(lh), pa = pmf(la);
    const m = ph.map((x, h) => pa.map((y, a) => x * y * (h < 2 && a < 2 ? Math.max(0, tau(h, a, lh, la, rho)) : 1)));
    const s = sum(m.map(sum));
    return m.map(row => row.map(x => x / s));
  }
  const tot = (m, f) => { let s = 0; for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) if (f(h, a)) s += m[h][a]; return s; };
  /** Split an expected total so the score model reproduces the market's home-minus-away probability. */
  function marketLambdas(total, pH, pA, rho = 0) {
    let lo = 0.03, hi = 0.97;
    for (let i = 0; i < 50; i++) {
      const r = (lo + hi) / 2, m = scoreMatrix(total * r, total * (1 - r), rho);
      if (tot(m, (h, a) => h > a) - tot(m, (h, a) => h < a) < pH - pA) lo = r; else hi = r;
    }
    const r = (lo + hi) / 2;
    return [total * r, total * (1 - r)];
  }
  /** Expected total goals matching a market over-line probability (given the 1N2 split). */
  function totalFromLine(pOver, line, pH, pA, rho = 0) {
    let lo = 0.6, hi = 6;
    for (let i = 0; i < 40; i++) {
      const t = (lo + hi) / 2, [h, a] = marketLambdas(t, pH, pA, rho);
      if (tot(scoreMatrix(h, a, rho), (x, y) => x + y > line) < pOver) lo = t; else hi = t;
    }
    return (lo + hi) / 2;
  }
  /** Market over/under reference: sharp books first, else median of all books, on the most quoted line. */
  function totalsReference(ev) {
    const byLine = new Map();
    for (const b of ev.bookmakers || []) for (const m of b.markets || []) {
      if (m.key !== 'totals') continue;
      const o = (m.outcomes || []).find(x => x.name === 'Over'), u = (m.outcomes || []).find(x => x.name === 'Under');
      if (!o || !u || o.point !== u.point || !(o.price > 1) || !(u.price > 1)) continue;
      const p = (1 / o.price) / (1 / o.price + 1 / u.price);
      if (!byLine.has(o.point)) byLine.set(o.point, []);
      byLine.get(o.point).push({key: b.key, p});
    }
    if (!byLine.size) return null;
    const sharpN = l => l.filter(x => E.SHARP_BOOKS.has(x.key)).length;
    const pref = [...byLine.entries()].sort((x, y) => (sharpN(y[1]) - sharpN(x[1])) || (y[1].length - x[1].length) || (Math.abs(x[0] - 2.5) - Math.abs(y[0] - 2.5)))[0];
    const [line, list] = pref, sharp = list.filter(x => E.SHARP_BOOKS.has(x.key));
    const use = sharp.length ? sharp : list, ps = use.map(x => x.p).sort((a, b) => a - b);
    return {line, pOver: sharp.length ? sum(ps) / ps.length : ps[Math.floor(ps.length / 2)], source: sharp.length ? 'sharp' : 'consensus', n: use.length};
  }

  /* ------------------------------------------------------------ past results */
  function teamStats(league, name, n = 10) {
    if (!league || !league.results || !name) return null;
    const i = league.names.indexOf(name);
    if (i < 0) return null;
    const games = league.results.filter(r => r[1] === i || r[2] === i).slice(-n * 2);
    const view = g => { const home = g[1] === i, f = home ? g[3] : g[4], c = home ? g[4] : g[3];
      return {date: g[0], home, opp: league.names[home ? g[2] : g[1]], f, c, res: f > c ? 'V' : f === c ? 'N' : 'D'}; };
    const all = games.map(view), last = all.slice(-n), last5 = all.slice(-5).reverse();
    const rec = list => ({n: list.length, w: list.filter(x => x.res === 'V').length, d: list.filter(x => x.res === 'N').length, l: list.filter(x => x.res === 'D').length,
      gf: sum(list.map(x => x.f)), ga: sum(list.map(x => x.c))});
    const homeG = all.filter(x => x.home).slice(-n), awayG = all.filter(x => !x.home).slice(-n);
    const rate = f => last.length ? last.filter(f).length / last.length : null;
    return {name, last5, form: rec(all.slice(-5)), last: rec(last), home: rec(homeG), away: rec(awayG),
      avgFor: last.length ? sum(last.map(x => x.f)) / last.length : null, avgAgainst: last.length ? sum(last.map(x => x.c)) / last.length : null,
      over25: rate(x => x.f + x.c > 2.5), under35: rate(x => x.f + x.c < 3.5), over15: rate(x => x.f + x.c > 1.5),
      btts: rate(x => x.f > 0 && x.c > 0), cleanSheets: rate(x => x.c === 0), failedToScore: rate(x => x.f === 0), draws: rate(x => x.res === 'N'), n: last.length};
  }
  function headToHead(league, home, away, n = 5) {
    if (!league || !league.results) return [];
    const h = league.names.indexOf(home), a = league.names.indexOf(away);
    if (h < 0 || a < 0) return [];
    return league.results.filter(r => (r[1] === h && r[2] === a) || (r[1] === a && r[2] === h)).slice(-n).reverse()
      .map(r => ({date: r[0], home: league.names[r[1]], away: league.names[r[2]], hg: r[3], ag: r[4]}));
  }

  /* ------------------------------------------------------------ options for one match */
  const FAMILY = {h2h: 'Résultat', dc: 'Double chance', dnb: 'Remboursé si nul', total: 'Buts', btts: 'Les 2 équipes marquent', teamgoal: 'Équipe marque'};
  function buildOptions(e, league, sportKey) {
    const opts = [];
    const priced = new Map(e.analysis.map(a => [a.outcome, a]));
    const isSoccer = sportKey.startsWith('soccer_') && e.outcomes.length === 3;
    const P = e.retained.probs, home = e.home, away = e.away;
    // 1) Match result — real playable prices.
    for (const o of e.outcomes) {
      const a = priced.get(o), p = a ? a.probability : P[o];
      opts.push({key: 'h2h:' + o, family: 'h2h', outcome: o, label: o === 'Draw' ? 'Match nul' : 'Victoire ' + o, p, lo: a ? a.p_low : e.retained.low[o], hi: a ? a.p_high : e.retained.high[o],
        price: a ? a.best_price : null, book: a ? a.best_book : null, edge: a ? a.edge : null, edge_low: a ? a.edge_low : null,
        model: e.model ? e.model.probs[o] : null, source: e.market.source});
    }
    if (!isSoccer) { for (const o of opts) o.fair = r4(1 / o.p); return {opts, totals: null}; }
    // 2) Secondary markets from a score model that reproduces the market 1N2.
    const rho = league?.rho ?? -0.04, pH = P[home], pA = P[away];
    const tref = totalsReference(e._raw || {});
    let total, totalSource;
    if (tref) { total = totalFromLine(tref.pOver, tref.line, pH, pA, rho); totalSource = tref.source === 'sharp' ? 'ligne de buts Pinnacle/Betfair' : 'ligne de buts des bookmakers'; }
    else if (e.model) { total = 0.6 * (e.model.xg_home + e.model.xg_away) + 0.4 * (league.avg_total || 2.6); totalSource = 'modèle statistique (buts attendus)'; }
    else { total = league?.avg_total || 2.6; totalSource = 'moyenne du championnat'; }
    const spread = tref ? 0.18 : 0.35;    // uncertainty on the expected total, in goals
    const mats = [total - spread, total, total + spread].map(t => { const [h, a] = marketLambdas(Math.max(0.5, t), pH, pA, rho); return scoreMatrix(h, a, rho); });
    const modelMat = e.model ? scoreMatrix(e.model.xg_home, e.model.xg_away, rho) : null;
    const add = (family, key, label, f, extra = {}) => {
      const vals = mats.map(m => tot(m, f)), p = vals[1];
      opts.push({key, family, label, p: r4(p), lo: r4(Math.min(...vals) * 0.985), hi: r4(Math.min(0.999, Math.max(...vals) * 1.015)), price: null, book: null, edge: null,
        model: modelMat ? r4(tot(modelMat, f)) : null, source: 'derived', ...extra});
    };
    // Double chance straight from the market 1N2 (exact), not from the score model.
    const M = e.model ? e.model.probs : null, se = e.market.se;
    for (const [key, label, outs] of [['dc:1N', `${home} ou nul`, [home, 'Draw']], ['dc:N2', `${away} ou nul`, [away, 'Draw']],
      ['dc:12', `${home} ou ${away} (pas de nul)`, [home, away]]]) {
      const p = sum(outs.map(o => P[o])), miss = e.outcomes.find(o => !outs.includes(o)), half = 1.645 * (se[miss] || 0.012);
      opts.push({key, family: 'dc', label, p: r4(p), lo: r4(Math.max(0.001, p - half)), hi: r4(Math.min(0.999, p + half)), price: null, book: null, edge: null,
        model: M ? r4(sum(outs.map(o => M[o]))) : null, source: 'derived'});
    }
    for (const line of [1.5, 2.5, 3.5, 4.5]) {
      add('total', `over:${line}`, `Plus de ${String(line).replace('.', ',')} buts`, (h, a) => h + a > line, {line, side: 'over'});
      add('total', `under:${line}`, `Moins de ${String(line).replace('.', ',')} buts`, (h, a) => h + a < line, {line, side: 'under'});
    }
    add('btts', 'btts:yes', 'Les deux équipes marquent', (h, a) => h > 0 && a > 0, {side: 'yes'});
    add('btts', 'btts:no', 'Au moins une équipe ne marque pas', (h, a) => h === 0 || a === 0, {side: 'no'});
    add('teamgoal', 'tg:home', `${home} marque au moins 1 but`, (h) => h > 0, {team: 'home'});
    add('teamgoal', 'tg:away', `${away} marque au moins 1 but`, (h, a) => a > 0, {team: 'away'});
    // Draw no bet: stake returned on a draw, so the fair price uses p(win | no draw).
    for (const [side, o] of [['home', home], ['away', away]]) {
      const pw = P[o] / (1 - P.Draw);
      opts.push({key: 'dnb:' + side, family: 'dnb', label: `${o} (remboursé si nul)`, p: r4(pw), lo: r4(pw * 0.96), hi: r4(Math.min(0.999, pw * 1.04)), price: null, book: null, edge: null,
        model: e.model ? r4(e.model.probs[o] / (1 - e.model.probs.Draw)) : null, source: 'derived', team: side});
    }
    for (const o of opts) o.fair = r4(1 / o.p);
    return {opts, totals: {total: r4(total), source: totalSource, line: tref?.line ?? null, pOver: tref?.pOver ?? null}};
  }

  /** Safe / Mi-safe / Risqué choice for one match. */
  function pickTiers(opts) {
    const inBand = (o, [lo, hi]) => o.p >= lo && o.p < hi;
    const valueScore = o => o.edge != null ? o.edge + 0.04 : -0.06;   // a real playable price is worth more than a theoretical one
    const agree = o => o.model == null ? 0 : -Math.abs(o.model - o.p);
    const FAM_W = {h2h: 0.06, dc: 0.03, total: 0, dnb: 0, btts: -0.02, teamgoal: -0.07};   // classic bets with a real Unibet price first
    const fam = o => FAM_W[o.family] || 0;
    const safe = opts.filter(o => inBand(o, TIERS.safe) && !/over:0|under:4\.5/.test(o.key))
      .sort((x, y) => (y.p + 0.5 * agree(y) + 0.3 * valueScore(y) + fam(y)) - (x.p + 0.5 * agree(x) + 0.3 * valueScore(x) + fam(x)))[0] || null;
    const mid = opts.filter(o => inBand(o, TIERS.mid) && (!safe || o.family !== safe.family))
      .sort((x, y) => (valueScore(y) + agree(y) + 0.5 * y.p + fam(y)) - (valueScore(x) + agree(x) + 0.5 * x.p + fam(x)))[0]
      || opts.filter(o => inBand(o, TIERS.mid)).sort((x, y) => y.p - x.p)[0] || null;
    // Two-way sports (basket, hockey, tennis…): any underdog is the risky side.
    const twoWay = !opts.some(o => o.outcome === 'Draw');
    const risky = opts.filter(o => inBand(o, twoWay ? [TIERS.risky[0], 0.5] : TIERS.risky) && o !== mid)
      .sort((x, y) => (valueScore(y) + 0.5 * agree(y)) - (valueScore(x) + 0.5 * agree(x)))[0] || null;
    return {safe, mid, risky};
  }

  /* ------------------------------------------------------------ explanations */
  const recTxt = r => r && r.n ? `${r.w}V ${r.d}N ${r.l}D` : '—';
  const per = (x, n) => x == null ? '—' : `${Math.round(x * n)}/${n}`;
  function explain(o, ctx, tier) {
    const {e, hs, as, h2h, totals, validation} = ctx, out = [];
    const lose = 1 - o.p, oneIn = Math.max(2, Math.round(1 / Math.max(lose, 0.01)));
    out.push(`Probabilité estimée : ${pct(o.p)} (entre ${pct(o.lo)} et ${pct(o.hi)}), soit une cote juste de ${odds(o.fair)}.`);
    if (o.price) {
      const ed = (Math.abs(o.edge) * 100).toFixed(1).replace('.', ',');
      out.push(o.edge > 0 ? `${o.book} paie ${odds(o.price)}, plus que la cote juste : rendement théorique +${ed} % par euro misé ✅.`
        : `${o.book} paie ${odds(o.price)}, sous la cote juste : la marge du bookmaker coûte ${ed} % par euro misé en moyenne.`);
    } else {
      out.push(`Cote Unibet non transmise par la source de données pour ce pari : joue-le seulement si Unibet propose au moins ${odds(o.fair * 1.03)} (cote juste + 3 %).`);
    }
    out.push(o.source === 'derived'
      ? `Calcul : probabilités du résultat chez Pinnacle/Betfair sans marge + ${totals?.source || 'modèle de buts'}${totals ? ` (≈ ${totals.total.toFixed(1).replace('.', ',')} buts attendus)` : ''}, transformées en probabilités de score.`
      : `Source : ${o.source === 'sharp' ? 'cotes de Pinnacle/Betfair (les plus précises du marché) sans leur marge' : 'médiane des bookmakers sans leur marge'}.`);
    if (o.model != null) {
      const d = o.model - o.p;
      out.push(`Le modèle statistique seul (résultats passés uniquement) donne ${pct(o.model)} : ${Math.abs(d) <= 0.05 ? 'il confirme ✅' : d > 0 ? 'il est encore plus optimiste' : 'il est plus prudent ⚠️'}.`);
    }
    const H = e.home, A = e.away;
    if (o.family === 'h2h') {
      const probs = e.bookmakers.filter(b => !b.stale).map(b => E.devig(b.odds, 'shin')[o.outcome]).filter(x => x != null).sort((x, y) => x - y);
      if (probs.length >= 3) out.push(`Les ${probs.length} bookmakers analysés estiment cette issue entre ${pct(probs[0])} et ${pct(probs[probs.length - 1])} : ${probs[probs.length - 1] - probs[0] < 0.06 ? 'ils sont d’accord, l’estimation est solide' : 'ils ne sont pas tous d’accord, prudence'}.`);
    }
    if (!hs?.n && !as?.n) out.push('Pas d’historique d’équipes gratuit pour cette compétition : l’analyse repose sur les cotes du marché, qui intègrent déjà la forme, les blessures et l’actualité.');
    const formLine = (s, team) => s && s.n ? `${team} : ${recTxt(s.form)} sur les 5 derniers matchs (${s.last5.map(x => x.res).join('')}), ${s.avgFor.toFixed(1).replace('.', ',')} but(s) marqué(s) et ${s.avgAgainst.toFixed(1).replace('.', ',')} encaissé(s) en moyenne.` : null;
    const fam = o.family, side = o.outcome === H || o.team === 'home' || /^dc:1N/.test(o.key) ? 'home' : o.outcome === A || o.team === 'away' || /^dc:N2/.test(o.key) ? 'away' : null;
    if (fam === 'h2h' || fam === 'dc' || fam === 'dnb' || fam === 'teamgoal') {
      if (side === 'home' || o.outcome === 'Draw' || o.key === 'dc:12') { const l = formLine(hs, H); if (l) out.push(l); if (hs?.home.n) out.push(`${H} à domicile (derniers matchs) : ${recTxt(hs.home)}, ${hs.home.gf}-${hs.home.ga}.`); }
      if (side === 'away' || o.outcome === 'Draw' || o.key === 'dc:12') { const l = formLine(as, A); if (l) out.push(l); if (as?.away.n) out.push(`${A} à l’extérieur (derniers matchs) : ${recTxt(as.away)}, ${as.away.gf}-${as.away.ga}.`); }
      if (o.outcome === 'Draw' && hs?.n && as?.n) out.push(`Matchs nuls sur les 10 derniers : ${per(hs.draws, hs.n)} pour ${H}, ${per(as.draws, as.n)} pour ${A}.`);
    }
    if (fam === 'total' && hs?.n && as?.n) {
      const key = o.line === 2.5 ? 'over25' : o.line === 3.5 ? 'under35' : o.line === 1.5 ? 'over15' : null;
      if (key) {
        const lbl = key === 'over25' ? 'plus de 2,5 buts' : key === 'under35' ? 'moins de 3,5 buts' : 'plus de 1,5 but';
        out.push(`Matchs avec ${lbl} sur les 10 derniers : ${per(hs[key], hs.n)} pour ${H}, ${per(as[key], as.n)} pour ${A}.`);
      }
      out.push(`Moyenne de buts par match (10 derniers) : ${(hs.avgFor + hs.avgAgainst).toFixed(1).replace('.', ',')} pour ${H}, ${(as.avgFor + as.avgAgainst).toFixed(1).replace('.', ',')} pour ${A}.`);
    }
    if (fam === 'btts' && hs?.n && as?.n) {
      out.push(`Les deux équipes ont marqué dans ${per(hs.btts, hs.n)} des derniers matchs de ${H} et ${per(as.btts, as.n)} de ${A}.`);
      out.push(`Matchs sans encaisser : ${per(hs.cleanSheets, hs.n)} pour ${H}, ${per(as.cleanSheets, as.n)} pour ${A}.`);
    }
    if (h2h && h2h.length) out.push(`Confrontations récentes : ${h2h.map(m => `${m.home} ${m.hg}-${m.ag} ${m.away}`).join(' · ')}.`);
    if (e.reliability.score < 70) out.push(`Fiabilité des données ${e.reliability.score}/100 : ${e.reliability.flags[0] || 'à prendre avec prudence'}.`);
    if (validation) out.push(`Modèle testé sur ${validation.test_n} matchs passés jamais vus : ${validation.validated ? 'validé' : 'moins précis que les cotes du marché, donc utilisé seulement comme second avis'}.`);
    out.push(tier === 'safe' ? `Pari prudent : il se perd environ 1 fois sur ${oneIn}. Aucun pari n’est sûr à 100 %.`
      : tier === 'mid' ? `Risque moyen : il se perd environ ${Math.round(lose * 10)} fois sur 10.`
        : `Pari risqué : il passe environ ${Math.max(1, Math.round(o.p * 10))} fois sur 10. Petite mise uniquement.`);
    return out;
  }

  /** Everything the screens need for one analysed match. */
  function matchInsights(e, league, matcher) {
    const sportKey = e.sport_key || '';
    const {opts, totals} = buildOptions(e, league, sportKey);
    const names = league?.names || [];
    const hName = e.model?.matched?.home || (matcher && names.length ? matcher(e.home, names)[0] : null);
    const aName = e.model?.matched?.away || (matcher && names.length ? matcher(e.away, names)[0] : null);
    const hs = teamStats(league, hName), as = teamStats(league, aName), h2h = headToHead(league, hName, aName);
    const tiers = pickTiers(opts);
    const ctx = {e, hs, as, h2h, totals, validation: league?.validation};
    for (const t of ['safe', 'mid', 'risky']) if (tiers[t]) tiers[t] = {...tiers[t], tier: t, why: explain(tiers[t], ctx, t)};
    return {opts, tiers, totals, hs, as, h2h};
  }

  const api = {scoreMatrix, marketLambdas, totalFromLine, totalsReference, teamStats, headToHead, buildOptions, pickTiers, explain, matchInsights, TIERS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Insights = api;
})(typeof window !== 'undefined' ? window : globalThis);

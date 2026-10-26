'use strict';
/* ODDSCOPE mobile — runs entirely on the phone. Odds come straight from The Odds API
   with the user's own key (kept in this browser only); team ratings from data/models.json. */
const API = 'https://api.the-odds-api.com/v4';
const DEFAULT_SPORTS = ['soccer_france_ligue_one', 'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
  'soccer_germany_bundesliga', 'soccer_uefa_champs_league'];
const TITLES = {soccer_france_ligue_one: 'Ligue 1', soccer_france_ligue_two: 'Ligue 2', soccer_epl: 'Premier League',
  soccer_spain_la_liga: 'La Liga', soccer_italy_serie_a: 'Serie A', soccer_germany_bundesliga: 'Bundesliga',
  soccer_uefa_champs_league: 'Ligue des champions', soccer_uefa_europa_league: 'Ligue Europa'};
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const nf = d => new Intl.NumberFormat('fr-FR', {minimumFractionDigits: d, maximumFractionDigits: d});
const pct = (p, d = 1) => p == null ? '—' : nf(d).format(p * 100) + ' %';
const spct = (p, d = 1) => p == null ? '—' : (p > 0 ? '+' : '') + nf(d).format(p * 100) + ' %';
const odds = x => x == null ? '—' : nf(2).format(x);
const when = s => new Date(s).toLocaleString('fr-FR', {weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
const ago = min => min < 1 ? 'à l’instant' : min < 60 ? `il y a ${Math.round(min)} min` : min < 1440 ? `il y a ${Math.floor(min / 60)} h` : `il y a ${Math.floor(min / 1440)} j`;

/* ------------------------------------------------------------ local storage (this phone only) */
const store = {
  get(k, d) { try { const v = localStorage.getItem('oddscope.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('oddscope.' + k, JSON.stringify(v)); return true; } catch { toast('Mémoire du téléphone pleine : efface des données dans Réglages.', 'error'); return false; } },
  del(k) { try { localStorage.removeItem('oddscope.' + k); } catch { /* ignore */ } },
};
const settings = () => ({sports: DEFAULT_SPORTS, reference: true, horizon: 168, reserve: 20, minInterval: 5, ...store.get('settings', {})});
const state = {models: null, matcher: null, boards: null, tab: 'value', comp: null, minProb: 0, minOdds: 1.2, busy: false, sportsList: store.get('sports', null)};

function toast(msg, kind = '') {
  const t = $('toast'); t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 7000 : 4500);
}
function showQuota() { const u = store.get('usage'); $('quota').textContent = u && u.remaining != null ? `${u.remaining} crédits` : '— crédits'; }
const title = s => TITLES[s] || (state.models?.leagues?.[s]?.title) || (state.sportsList || []).find(x => x.key === s)?.title || s;

/* ------------------------------------------------------------ The Odds API */
async function oddsApi(path, params = {}, cost = 0) {
  const key = store.get('key');
  if (!key) throw new Error('Ajoute d’abord ta clé The Odds API dans Réglages.');
  const usage = store.get('usage');
  if (cost && usage && usage.remaining != null && usage.remaining - cost < settings().reserve) {
    throw new Error(`Quota protégé : ${usage.remaining} crédits restants (réserve ${settings().reserve}). Rien n’a été dépensé.`);
  }
  const url = `${API}${path}?` + new URLSearchParams({...params, apiKey: key});
  let last;
  for (let i = 0; i < 3; i++) {
    let r;
    try { r = await fetch(url, {cache: 'no-store', referrerPolicy: 'no-referrer'}); }
    catch { last = 'connexion impossible'; await new Promise(res => setTimeout(res, 1000 * 2 ** i)); continue; }
    const rem = r.headers.get('x-requests-remaining'), used = r.headers.get('x-requests-used');
    if (rem != null) { store.set('usage', {remaining: Math.floor(+rem), used: Math.floor(+used), at: new Date().toISOString()}); showQuota(); }
    if (r.status === 401) throw new Error('Clé API refusée. Vérifie-la dans Réglages.');
    if (r.status === 429) throw new Error('Quota ou limite atteint chez The Odds API. Réessaie plus tard.');
    if (r.status === 422) throw new Error('Compétition indisponible chez le fournisseur.');
    if (r.status >= 500) { last = 'HTTP ' + r.status; await new Promise(res => setTimeout(res, 1000 * 2 ** i)); continue; }
    if (!r.ok) throw new Error('Erreur du fournisseur (HTTP ' + r.status + ').');
    return r.json();
  }
  throw new Error(`Fournisseur injoignable (${last}). Les dernières cotes enregistrées restent affichées.`);
}

/* ------------------------------------------------------------ data */
async function loadModels() {
  try { state.models = await (await fetch('data/models.json')).json(); }
  catch { state.models = {leagues: {}, aliases: {}, stop: []}; }
  state.matcher = Engine.makeMatcher(state.models.aliases || {}, state.models.stop || []);
}
function snapshot(sport) { return store.get('snap.' + sport); }
function buildBoards() {
  const now = new Date(), boards = [];
  for (const sport of settings().sports) {
    const snap = snapshot(sport);
    if (!snap) continue;
    const league = state.models.leagues[sport];
    const fr = new Set(snap.events.flatMap(e => (e.bookmakers || []).map(b => b.key)).filter(k => k.endsWith('_fr')));
    const res = Engine.analyzeCompetition(snap.events, {now, sportName: title(sport), booksFilter: fr.size ? fr : null,
      modelPredict: Engine.modelPredictor(league, state.matcher), modelWeight: league?.validation?.weight || 0,
      method: league?.validation?.devig || 'shin', snapshotAge: (now - new Date(snap.fetched_at)) / 60000});
    boards.push({sport, sport_title: title(sport), fetched_at: snap.fetched_at, events: res.events});
  }
  state.boards = boards;
  return boards;
}
function findEvent(sport, id) { return (state.boards || buildBoards()).find(b => b.sport === sport)?.events.find(e => e.id === id); }

async function analyzeAll(btn) {
  if (state.busy) return;
  const s = settings(), regions = s.reference ? 'fr,eu' : 'fr';
  const todo = s.sports.filter(sp => { const sn = snapshot(sp); return !sn || (Date.now() - new Date(sn.fetched_at)) / 60000 >= s.minInterval; });
  if (!todo.length) { toast(`Cotes déjà à jour (moins de ${s.minInterval} min).`); return; }
  state.busy = true; let done = 0, cost = 0; const errors = [];
  const bar = $('progress');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Analyse…'; }
  for (const sport of todo) {
    try {
      const before = store.get('usage')?.used;
      const data = await oddsApi(`/sports/${sport}/odds`, {regions, markets: 'h2h', oddsFormat: 'decimal', dateFormat: 'iso'}, regions.split(',').length);
      const prev = snapshot(sport);
      if (prev) store.set('prev.' + sport, prev);
      const slim = data.map(e => ({id: e.id, sport_key: e.sport_key, sport_title: e.sport_title, home_team: e.home_team, away_team: e.away_team,
        commence_time: e.commence_time, bookmakers: e.bookmakers.map(b => ({key: b.key, title: b.title, last_update: b.last_update,
          markets: b.markets.filter(m => m.key === 'h2h').map(m => ({key: 'h2h', outcomes: m.outcomes.map(o => ({name: o.name, price: o.price}))}))}))}));
      store.set('snap.' + sport, {fetched_at: new Date().toISOString(), regions, events: slim});
      const after = store.get('usage')?.used;
      if (before != null && after != null) cost += after - before;
    } catch (e) {
      errors.push(`${title(sport)} : ${e.message}`);
      if (/Quota|Clé/.test(e.message)) break;
    }
    done++;
    if (bar) bar.style.width = (100 * done / todo.length) + '%';
  }
  state.busy = false;
  buildBoards();
  toast(errors.length ? errors.join(' · ') : `${todo.length} compétition(s) analysée(s)${cost ? ` · ${cost} crédit(s)` : ''}.`, errors.length ? 'error' : 'success');
  render();
}

/* ------------------------------------------------------------ views */
const stars = n => `<span class="stars" aria-label="${n} sur 5">${'★'.repeat(n)}<i>${'★'.repeat(5 - n)}</i></span>`;
const starPill = c => `<span class="pill ${c.stars >= 5 ? 'good' : c.stars >= 3 ? 'accent' : c.stars >= 1 ? 'warning' : 'neutral'}">${stars(c.stars)} ${esc(c.label)}</span>`;
const tracked = () => store.get('tracked', []);
const isTracked = (c) => tracked().some(t => t.event_id === c.event_id && t.outcome === c.outcome);

function pickStats(c) {
  return `<div class="stats"><div><span>Proba</span><b>${pct(c.probability)}</b><small>${pct(c.p_low, 0)}–${pct(c.p_high, 0)}</small></div>
    <div><span>Cote juste</span><b class="mono">${odds(c.fair_odds)}</b><small>sans marge</small></div>
    <div><span>Rendement</span><b class="${c.edge > 0 ? 'pos' : 'neg'}">${spct(c.edge)}</b><small>par € misé</small></div>
    <div><span>Fiabilité</span><b>${c.reliability}</b><small>${esc(c.reliability_label)}</small></div></div>`;
}
function pickCard(c, rank, hero) {
  return `<article class="pick ${hero ? 'hero' : ''}">
    <div class="pick-top"><span class="${hero ? 'eyebrow' : 'mono muted small'}">${hero ? 'N°1 · le plus prometteur' : '#' + rank}</span>${starPill(c)}</div>
    <div class="meta">${esc(c.competition)} · ${esc(when(c.start))}</div>
    <div class="match">${esc(c.home)} – ${esc(c.away)}</div>
    <div class="pick-main"><div class="sel">${esc(c.selection)}</div><div class="odds"><b>${odds(c.odds)}</b><span>${esc(c.bookmaker)}</span></div></div>
    ${pickStats(c)}
    ${hero ? `<p class="why">${esc(c.explanation)}</p>` : ''}
    <div class="pick-actions"><button class="btn sm" data-act="detail" data-sport="${esc(c.sport)}" data-id="${esc(c.event_id)}">Détails</button>
      <button class="btn sm" data-act="track" data-sport="${esc(c.sport)}" data-id="${esc(c.event_id)}" data-outcome="${esc(c.outcome)}" ${isTracked(c) ? 'disabled' : ''}>${isTracked(c) ? '✓ Suivi' : '＋ Suivre'}</button></div>
  </article>`;
}

function viewPicks(v) {
  const s = settings();
  if (!store.get('key')) {
    v.innerHTML = `<div class="head"><div class="eyebrow">Bienvenue</div><h1>Paris du jour</h1><p>Pour analyser les vraies cotes des bookmakers français, ajoute ta clé gratuite The Odds API.</p></div>
      <a class="btn primary block" href="#reglages">Ajouter ma clé API</a>
      <p class="legal">Les cotes sont téléchargées directement depuis ce téléphone. Ta clé reste uniquement sur ce téléphone.</p>`;
    return;
  }
  const boards = state.boards || buildBoards();
  const p = Engine.buildPicks(boards, new Date(), s.horizon);
  const oldest = boards.length ? Math.max(...boards.map(b => (Date.now() - new Date(b.fetched_at)) / 60000)) : null;
  const comps = boards.filter(b => b.events.length);
  const list = (state.tab === 'value' ? p.value : p.probable).filter(c => c.probability >= state.minProb / 100 && c.odds >= state.minOdds && (!state.comp || c.sport === state.comp));
  const hero = state.tab === 'value' && list.length ? list[0] : null;
  v.innerHTML = `
  <div class="head"><div class="eyebrow">${s.sports.length} compétitions · ${s.reference ? 'référence Pinnacle/Betfair' : 'bookmakers FR'}</div><h1>Paris du jour</h1>
    <p>Un pari par match, classé du plus prometteur au moins prometteur. Les étoiles mesurent le rendement attendu, pas la chance de gagner.</p></div>
  <button class="btn primary block" data-act="analyze">↻ Analyser les matchs · ${s.sports.length * (s.reference ? 2 : 1)} crédits</button>
  <div class="progress"><i id="progress" style="width:0"></i></div>
  <div class="verdict ${p.summary.with_value ? 'ok' : ''}"><b>${esc(p.verdict)}</b><span class="small muted">${p.summary.matches} matchs · ${s.horizon >= 168 ? '7 jours' : s.horizon + ' h'}${oldest != null ? ` · cotes ${ago(oldest)}` : ''}${p.summary.excluded.unreliable ? ` · ${p.summary.excluded.unreliable} écartés (données insuffisantes ou anciennes : relance l’analyse)` : ''}</span></div>
  <div class="chips"><button class="chip ${state.tab === 'value' ? 'on' : ''}" data-act="tab" data-tab="value">★ Plus prometteurs</button><button class="chip ${state.tab === 'probable' ? 'on' : ''}" data-act="tab" data-tab="probable">Plus probables</button>
    <button class="chip ${!state.comp ? 'on' : ''}" data-act="comp">Toutes</button>${comps.map(b => `<button class="chip ${state.comp === b.sport ? 'on' : ''}" data-act="comp" data-sport="${esc(b.sport)}">${esc(b.sport_title)}</button>`).join('')}</div>
  <div class="filters"><label class="field"><span>Proba min. ${state.minProb} %</span><input type="range" min="0" max="90" step="5" value="${state.minProb}" data-act="minprob"></label>
    <label class="field"><span>Cote min.</span><select data-act="minodds">${[1.01, 1.2, 1.5, 2, 3].map(x => `<option value="${x}" ${state.minOdds === x ? 'selected' : ''}>${odds(x)}</option>`).join('')}</select></label></div>
  ${state.tab === 'probable' ? '<p class="small muted" style="margin:0">Classés par chance de gagner. Un pari probable n’est pas forcément rentable : regarde son rendement.</p>' : ''}
  ${list.length ? `<div class="picks list">${list.map((c, i) => pickCard(c, i + 1, c === hero)).join('')}</div>` :
    `<div class="card empty"><h3>${boards.length ? 'Aucun pari pour ces filtres' : 'Aucune cote pour l’instant'}</h3>${boards.length ? 'Élargis les filtres.' : 'Appuie sur « Analyser les matchs ».'}</div>`}
  <p class="legal">Rendement = probabilité × cote − 1. Aucune garantie de gain. Vérifie la cote chez l’opérateur. Jeux d’argent : interdits aux mineurs · 09 74 75 13 13.</p>`;
}

function viewMatches(v) {
  const boards = state.boards || buildBoards();
  if (!boards.length) { v.innerHTML = `<div class="head"><h1>Matchs</h1></div><div class="card empty"><h3>Aucune donnée</h3>Lance une analyse depuis l’onglet Paris.</div>`; return; }
  const sel = state.comp && boards.some(b => b.sport === state.comp) ? state.comp : boards[0].sport;
  const b = boards.find(x => x.sport === sel), league = state.models.leagues[sel];
  v.innerHTML = `<div class="head"><div class="eyebrow">Cotes ${ago((Date.now() - new Date(b.fetched_at)) / 60000)}</div><h1>Matchs</h1></div>
  <div class="chips">${boards.map(x => `<button class="chip ${x.sport === sel ? 'on' : ''}" data-act="comp" data-sport="${esc(x.sport)}">${esc(x.sport_title)}</button>`).join('')}</div>
  ${league ? `<div class="verdict ${league.validation?.validated ? 'ok' : ''}"><b>Modèle ${league.validation ? (league.validation.validated ? 'validé' : 'non validé') + ' contre le marché' : 'non encore validé'}</b><span class="small muted">${league.validation ? `Test sur ${league.validation.test_n} matchs : log loss modèle ${nf(3).format(league.validation.model_log_loss)} vs marché ${nf(3).format(league.validation.market_log_loss)} · poids ${Math.round(league.validation.weight * 100)} %` : 'Affiché comme second avis, poids 0 %.'}</span></div>` : ''}
  <div class="list">${b.events.map(e => {
    const rel = e.reliability;
    return `<button class="row" data-act="detail" data-sport="${esc(sel)}" data-id="${esc(e.id)}" style="text-align:left;width:100%">
      <div><div class="t">${esc(e.home)} – ${esc(e.away)}</div><div class="s">${esc(when(e.start))} · ${e.books_selected} bookm. FR</div></div>
      <div class="r">${e.outcomes.map(o => `${o === 'Draw' ? 'N' : o === e.home ? '1' : '2'} ${odds(e.best[o]?.price)}`).join('<br>')}<br><span class="pill ${rel.score >= 70 ? 'good' : rel.score >= 50 ? 'warning' : 'critical'}" style="margin-top:4px">${rel.score}</span></div></button>`;
  }).join('') || '<div class="card empty">Aucun match à venir.</div>'}</div>`;
}

function detailHtml(sport, e) {
  const league = state.models.leagues[sport], prev = store.get('prev.' + sport);
  const prevEv = prev?.events.find(x => x.id === e.id);
  const prevPrice = (bk, o) => prevEv?.bookmakers.find(b => b.key === bk)?.markets?.[0]?.outcomes.find(x => x.name === o)?.price;
  const arrow = (bk, o, now) => { const p = prevPrice(bk, o); return !p || p === now ? '' : now > p ? ' <span class="pos">▲</span>' : ' <span class="neg">▼</span>'; };
  const team = n => league?.teams?.[n];
  const formHtml = (name, t) => t ? `<div class="card"><div class="pick-top"><h3>${esc(name)}</h3><div class="form">${t.form.map(f => `<span class="${f.result}" title="${esc(f.date)} ${esc(f.opponent)} ${esc(f.score)}">${f.result}</span>`).join('')}</div></div>
    <p class="small muted" style="margin:6px 0 0">5 derniers : ${t.last5.w}V ${t.last5.d}N ${t.last5.l}D (${t.last5.gf}-${t.last5.ga}) · Domicile 12 mois : ${t.home.w}V ${t.home.d}N ${t.home.l}D · Extérieur : ${t.away.w}V ${t.away.d}N ${t.away.l}D</p>
    <p class="small muted" style="margin:4px 0 0">${t.form.map(f => `${esc(f.venue === 'D' ? 'vs' : '@')} ${esc(f.opponent)} ${esc(f.score)}`).join(' · ')}</p></div>` : '';
  const bar = (p, lo, hi, color) => `<div class="bar">${lo != null ? `<i style="left:${lo * 100}%;width:${(hi - lo) * 100}%;background:${color};opacity:.35"></i>` : ''}<i style="left:0;width:${p * 100}%;background:${color};opacity:.85"></i></div>`;
  const fr = e.bookmakers.filter(b => b.is_fr), ref = e.bookmakers.filter(b => !b.is_fr);
  const table = list => `<table><thead><tr><th>Bookmaker</th>${e.outcomes.map(o => `<th>${o === 'Draw' ? 'N' : o === e.home ? '1' : '2'}</th>`).join('')}<th>Marge</th></tr></thead><tbody>${list.map(b => `<tr><td>${esc(b.title)}${b.stale ? ' <span class="pill critical">retard</span>' : ''}</td>${e.outcomes.map(o => `<td class="mono ${e.best[o]?.key === b.key ? 'best' : ''}">${odds(b.odds[o])}${arrow(b.key, o, b.odds[o])}</td>`).join('')}<td class="mono">${pct(b.overround, 1)}</td></tr>`).join('')}</tbody></table>`;
  return `<div><div class="eyebrow">${esc(title(sport))} · ${esc(when(e.start))}</div><h2>${esc(e.home)} – ${esc(e.away)}</h2>
    <p class="small muted" style="margin:4px 0 0">Fiabilité ${e.reliability.score}/100 (${esc(e.reliability.label)}) · incertitude ${esc(e.uncertainty.label.toLowerCase())} · ${e.books_used} bookmakers · référence ${e.market.source === 'sharp' ? 'Pinnacle/Betfair' : 'médiane'}</p></div>
  ${e.outcomes.map(o => { const a = e.analysis.find(x => x.outcome === o); const [s] = a ? Engine.rate(a) : [0];
    return `<div class="card"><div class="pick-top"><b>${esc(o === 'Draw' ? 'Match nul' : 'Victoire ' + o)}</b>${a ? `<span class="mono">${odds(a.best_price)} <span class="small muted">${esc(a.best_book)}</span></span>` : ''}</div>
      <div class="prob-row"><span class="muted">Marché</span>${bar(e.market.probs[o], null, null, '#3987e5')}<b>${pct(e.market.probs[o])}</b></div>
      ${e.model ? `<div class="prob-row"><span class="muted">Modèle</span>${bar(e.model.probs[o], e.model.low[o], e.model.high[o], '#d95926')}<b>${pct(e.model.probs[o])}</b></div>` : ''}
      ${a ? `<div class="pick-top small"><span>Cote juste ${odds(a.fair_odds)} · rendement <b class="${a.edge > 0 ? 'pos' : 'neg'}">${spct(a.edge)}</b></span>${stars(s)}</div>
      <button class="btn sm" data-act="track" data-sport="${esc(sport)}" data-id="${esc(e.id)}" data-outcome="${esc(o)}" ${tracked().some(t => t.event_id === e.id && t.outcome === o) ? 'disabled' : ''}>＋ Suivre ce pari</button>` : ''}</div>`; }).join('')}
  <div class="card"><h3>Qualité des données</h3>${e.reliability.flags.length ? `<ul class="flags">${e.reliability.flags.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="small muted">Aucune alerte.</p>'}
    <p class="small muted" style="margin:6px 0 0">Modèle : ${esc(e.model_status)}${e.model ? ` · buts attendus ${nf(2).format(e.model.xg_home)} – ${nf(2).format(e.model.xg_away)}` : ''}</p></div>
  ${formHtml(e.model?.matched?.home || e.home, team(e.model?.matched?.home))}${formHtml(e.model?.matched?.away || e.away, team(e.model?.matched?.away))}
  <div class="card"><h3>Bookmakers français</h3>${fr.length ? table(fr) : '<p class="small muted">Aucun opérateur français ne propose ce match.</p>'}
    ${ref.length ? `<details style="margin-top:8px"><summary class="small">Bookmakers de référence (${ref.length}, non agréés en France)</summary>${table(ref)}</details>` : ''}
    <p class="small muted" style="margin:6px 0 0">▲▼ : variation depuis l’analyse précédente.</p></div>`;
}
function openDetail(sport, id) {
  const e = findEvent(sport, id);
  if (!e) { toast('Match introuvable : relance l’analyse.', 'error'); return; }
  $('sheetContent').innerHTML = detailHtml(sport, e);
  $('sheet').hidden = false; document.body.style.overflow = 'hidden';
}
function closeSheet() { $('sheet').hidden = true; document.body.style.overflow = ''; }

function trackPick(sport, id, outcome) {
  const e = findEvent(sport, id), a = e?.analysis.find(x => x.outcome === outcome);
  if (!a) return;
  const list = tracked();
  if (list.some(t => t.event_id === id && t.outcome === outcome)) return;
  const [s] = Engine.rate(a);
  list.unshift({event_id: id, sport, home: e.home, away: e.away, start: e.start, outcome, selection: outcome === 'Draw' ? 'Match nul' : 'Victoire ' + outcome,
    odds: a.best_price, bookmaker: a.best_book, probability: a.probability, edge: a.edge, stars: s, added_at: new Date().toISOString(), result: null});
  store.set('tracked', list.slice(0, 500));
  toast('Ajouté à « Mes paris ». Le résultat sera vérifié après le match.', 'success');
}

async function updateResults(btn) {
  const list = tracked(), pending = list.filter(t => !t.result && new Date(t.start) < new Date());
  const sports = [...new Set(pending.map(t => t.sport))];
  if (!sports.length) { toast('Aucun pari terminé en attente de résultat.'); return; }
  btn.disabled = true;
  const errors = [];
  for (const sport of sports) {
    try {
      const data = await oddsApi(`/sports/${sport}/scores`, {daysFrom: 3, dateFormat: 'iso'}, 2);
      for (const g of data) {
        if (!g.completed || !g.scores) continue;
        const sc = Object.fromEntries(g.scores.map(x => [x.name, +x.score]));
        const hs = sc[g.home_team], as = sc[g.away_team];
        if (!isFinite(hs) || !isFinite(as)) continue;
        const winner = hs > as ? g.home_team : hs < as ? g.away_team : 'Draw';
        for (const t of list) if (t.event_id === g.id && !t.result) { t.result = t.outcome === winner ? 'won' : 'lost'; t.score = `${hs}-${as}`; }
      }
    } catch (e) { errors.push(e.message); }
  }
  store.set('tracked', list);
  toast(errors.length ? errors.join(' · ') : 'Résultats mis à jour.', errors.length ? 'error' : 'success');
  render();
}

function viewTracking(v) {
  const list = tracked(), done = list.filter(t => t.result), won = done.filter(t => t.result === 'won');
  const profit = done.reduce((s, t) => s + (t.result === 'won' ? t.odds - 1 : -1), 0);
  const expWins = done.reduce((s, t) => s + t.probability, 0);
  const pending = list.filter(t => !t.result && new Date(t.start) < new Date()).length;
  v.innerHTML = `<div class="head"><div class="eyebrow">Résultats réels</div><h1>Mes paris</h1><p>Les paris que tu suis, comparés aux vrais résultats. C’est la mesure honnête de la qualité des analyses.</p></div>
  <div class="kpis"><div class="kpi"><span>Suivis</span><b>${list.length}</b><small>${pending} en attente</small></div>
    <div class="kpi"><span>Gagnés</span><b>${done.length ? `${won.length}/${done.length}` : '—'}</b><small>${done.length ? `attendu : ${nf(1).format(expWins)}` : 'aucun terminé'}</small></div>
    <div class="kpi"><span>Bilan (1 € / pari)</span><b class="${profit >= 0 ? 'pos' : 'neg'}">${done.length ? (profit >= 0 ? '+' : '') + nf(2).format(profit) + ' €' : '—'}</b><small>${done.length ? 'rendement ' + spct(profit / done.length) : ''}</small></div>
    <div class="kpi"><span>Échantillon</span><b>${done.length}</b><small>${done.length < 100 ? 'trop petit pour conclure' : 'exploitable'}</small></div></div>
  <button class="btn block" data-act="results" ${pending ? '' : 'disabled'}>Vérifier les résultats · 2 crédits par compétition</button>
  <div class="list">${list.map((t, i) => `<div class="row"><div><div class="t">${esc(t.selection)} · <span class="mono">${odds(t.odds)}</span></div><div class="s">${esc(t.home)} – ${esc(t.away)} · ${esc(when(t.start))} · ${esc(t.bookmaker)} · proba ${pct(t.probability, 0)}</div></div>
    <div class="r">${t.result ? `<span class="pill ${t.result === 'won' ? 'good' : 'critical'}">${t.result === 'won' ? 'Gagné' : 'Perdu'} ${esc(t.score || '')}</span>` : new Date(t.start) < new Date() ? '<span class="pill warning">En attente</span>' : '<span class="pill neutral">À venir</span>'}<br><button class="btn sm" style="margin-top:6px" data-act="untrack" data-i="${i}" aria-label="Retirer">✕</button></div></div>`).join('') || '<div class="card empty"><h3>Aucun pari suivi</h3>Appuie sur « ＋ Suivre » sur un pari pour le suivre.</div>'}</div>`;
}

function viewSettings(v) {
  const s = settings(), key = store.get('key'), u = store.get('usage');
  const sportsList = (state.sportsList || DEFAULT_SPORTS.map(k => ({key: k, title: title(k), group: 'Soccer'})))
    .filter(x => x.group === 'Soccer' || s.sports.includes(x.key))
    .sort((a, b) => (!!state.models.leagues[b.key] - !!state.models.leagues[a.key]) || a.title.localeCompare(b.title));
  v.innerHTML = `<div class="head"><div class="eyebrow">Configuration</div><h1>Réglages</h1></div>
  <div class="card"><h3>Clé The Odds API</h3><p class="small muted">${key ? `Enregistrée sur ce téléphone (…${esc(key.slice(-4))}).` : 'Gratuite : 500 crédits/mois sur the-odds-api.com.'} Elle n’est jamais envoyée ailleurs qu’à The Odds API.</p>
    <div class="field" style="margin-top:8px"><input type="password" id="key" autocomplete="off" placeholder="${key ? 'Remplacer la clé' : 'Colle ta clé ici'}"></div>
    <div class="pick-actions" style="margin-top:8px"><button class="btn primary" data-act="savekey">Enregistrer</button><button class="btn" data-act="testkey" ${key ? '' : 'disabled'}>Tester (gratuit)</button></div>
    <p class="small muted" style="margin:8px 0 0">Crédits restants : <b>${u?.remaining ?? '—'}</b>${u?.used != null ? ` · utilisés ce mois : ${u.used}` : ''}</p></div>
  <div class="card"><h3>Compétitions à analyser</h3><p class="small muted">${s.sports.length} sélectionnées · ${s.sports.length * (s.reference ? 2 : 1)} crédits par analyse. « Modèle » = statistiques disponibles.</p>
    ${sportsList.map(x => `<label class="check"><input type="checkbox" name="sp" value="${esc(x.key)}" ${s.sports.includes(x.key) ? 'checked' : ''}> ${esc(x.title)}${state.models.leagues[x.key] ? ' <span class="pill accent">modèle</span>' : ''}</label>`).join('')}
    ${state.sportsList ? '' : '<button class="btn sm" data-act="loadsports" style="margin-top:8px">Voir toutes les compétitions (gratuit)</button>'}</div>
  <div class="card"><h3>Précision</h3>
    <label class="check"><input type="checkbox" id="ref" ${s.reference ? 'checked' : ''}> Référence Pinnacle / Betfair (+1 crédit, bien plus précis)</label>
    <div class="filters" style="margin-top:8px"><label class="field"><span>Période</span><select id="horizon">${[[24, '24 h'], [72, '3 jours'], [168, '7 jours']].map(([h, l]) => `<option value="${h}" ${s.horizon === h ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="field"><span>Réserve de crédits</span><input type="number" id="reserve" min="0" value="${s.reserve}"></label></div></div>
  <button class="btn primary block" data-act="savesettings">Enregistrer les réglages</button>
  <div class="card"><h3>Installer l’appli</h3><p class="small muted"><b>iPhone</b> (Safari) : bouton Partager → « Sur l’écran d’accueil ».<br><b>Android</b> (Chrome) : menu ⋮ → « Installer l’application » ou « Ajouter à l’écran d’accueil ».</p>
    <p class="small muted">Statistiques : ${state.models.generated_at ? `mises à jour le ${esc(new Date(state.models.generated_at).toLocaleDateString('fr-FR'))}` : 'indisponibles'} (football-data.co.uk).</p></div>
  <button class="btn danger block" data-act="wipe">Effacer toutes mes données sur ce téléphone</button>
  <p class="legal">ODDSCOPE n’enregistre rien sur un serveur : tout reste sur ce téléphone. Aucun pari n’est placé. Interdit aux mineurs · Joueurs Info Service 09 74 75 13 13.</p>`;
}

/* ------------------------------------------------------------ router & events */
function render() {
  const tab = (location.hash.replace('#', '') || 'paris');
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  const v = $('view');
  ({paris: viewPicks, matchs: viewMatches, suivi: viewTracking, reglages: viewSettings}[tab] || viewPicks)(v);
}
document.addEventListener('click', async ev => {
  const t = ev.target.closest('[data-act]');
  if (!t) { if (ev.target === $('sheet')) closeSheet(); return; }
  const a = t.dataset.act;
  if (a === 'analyze') analyzeAll(t);
  else if (a === 'tab') { state.tab = t.dataset.tab; render(); }
  else if (a === 'comp') { state.comp = t.dataset.sport || null; render(); }
  else if (a === 'detail') openDetail(t.dataset.sport, t.dataset.id);
  else if (a === 'track') { trackPick(t.dataset.sport, t.dataset.id, t.dataset.outcome); t.disabled = true; t.textContent = '✓ Suivi'; }
  else if (a === 'untrack') { const l = tracked(); l.splice(+t.dataset.i, 1); store.set('tracked', l); render(); }
  else if (a === 'results') updateResults(t);
  else if (a === 'savekey') {
    const k = $('key').value.trim();
    if (!/^[A-Za-z0-9_-]{10,160}$/.test(k)) return toast('Format de clé invalide.', 'error');
    store.set('key', k); toast('Clé enregistrée sur ce téléphone.', 'success'); render();
  } else if (a === 'testkey' || a === 'loadsports') {
    try { const list = await oddsApi('/sports'); state.sportsList = list.filter(x => x.active && !x.has_outrights).map(x => ({key: x.key, title: x.title, group: x.group})); store.set('sports', state.sportsList); toast(`Clé valide · ${store.get('usage')?.remaining ?? '?'} crédits restants.`, 'success'); render(); }
    catch (e) { toast(e.message, 'error'); }
  } else if (a === 'savesettings') {
    const sports = [...document.querySelectorAll('input[name="sp"]:checked')].map(i => i.value);
    if (!sports.length) return toast('Choisis au moins une compétition.', 'error');
    store.set('settings', {...settings(), sports, reference: $('ref').checked, horizon: +$('horizon').value, reserve: Math.max(0, +$('reserve').value || 0)});
    state.boards = null; toast('Réglages enregistrés.', 'success'); render();
  } else if (a === 'wipe') {
    if (!confirm('Effacer la clé, les cotes enregistrées et tes paris suivis ?')) return;
    try { Object.keys(localStorage).filter(k => k.startsWith('oddscope.')).forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ }
    state.boards = null; showQuota(); toast('Données effacées.'); render();
  }
});
document.addEventListener('input', ev => { if (ev.target.dataset.act === 'minprob') { state.minProb = +ev.target.value; render(); } });
document.addEventListener('change', ev => { if (ev.target.dataset.act === 'minodds') { state.minOdds = +ev.target.value; render(); } });
$('sheetClose').addEventListener('click', closeSheet);
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeSheet(); });
window.addEventListener('hashchange', () => { closeSheet(); render(); window.scrollTo(0, 0); });

(async function init() {
  showQuota();
  await loadModels();
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

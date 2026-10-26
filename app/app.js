'use strict';
/* ODDSCOPE mobile — runs entirely on the phone. Odds come straight from The Odds API
   with the user's own key (kept in this browser only); team statistics from data/models.json. */
const API = 'https://api.the-odds-api.com/v4';
const DEFAULT_SPORTS = ['soccer_france_ligue_one', 'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
  'soccer_germany_bundesliga', 'soccer_uefa_champs_league', 'basketball_nba', 'icehockey_nhl'];
const TITLES = {soccer_france_ligue_one: 'Ligue 1', soccer_france_ligue_two: 'Ligue 2', soccer_epl: 'Premier League',
  soccer_spain_la_liga: 'La Liga', soccer_italy_serie_a: 'Serie A', soccer_germany_bundesliga: 'Bundesliga',
  soccer_uefa_champs_league: 'Ligue des champions', soccer_uefa_europa_league: 'Ligue Europa', basketball_nba: 'NBA',
  icehockey_nhl: 'NHL', basketball_euroleague: 'Euroleague'};
const GROUPS = [['soccer_', 'Foot', '⚽'], ['basketball_', 'Basket', '🏀'], ['icehockey_', 'Hockey', '🏒'], ['tennis_', 'Tennis', '🎾'],
  ['americanfootball_', 'Foot US', '🏈'], ['rugby', 'Rugby', '🏉'], ['mma_', 'MMA', '🥊'], ['boxing_', 'Boxe', '🥊'], ['handball_', 'Handball', '🤾']];
const group = k => GROUPS.find(g => k.startsWith(g[0])) || ['', 'Autre', '🏅'];
const TIER_INFO = {safe: ['🟢', 'Safe', 'good', 'Pour parier tranquille'], mid: ['🟡', 'Mi-safe', 'warning', 'Un peu plus de risque'], risky: ['🔴', 'Risqué', 'critical', 'Gros risque, grosse cote']};
const FR_BOOKS = [['unibet_fr', 'Unibet'], ['betclic_fr', 'Betclic'], ['winamax_fr', 'Winamax'], ['pmu_fr', 'PMU'], ['netbet_fr', 'NetBet']];

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
};
const settings = () => ({sports: DEFAULT_SPORTS, tennisAll: true, books: ['unibet_fr'], reference: true, horizon: 168, reserve: 20, minInterval: 5, ...store.get('settings', {})});
const booksLabel = s => s.books.map(k => (FR_BOOKS.find(b => b[0] === k) || [k, k])[1]).join(', ');
const state = {models: null, matcher: null, boards: null, tab: 'safe', grp: null, minProb: 0, minOdds: 1.01, busy: false, sportsList: store.get('sports', null)};

function toast(msg, kind = '') {
  const t = $('toast'); t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 7000 : 4500);
}
function showQuota() { const u = store.get('usage'); $('quota').textContent = u && u.remaining != null ? `${u.remaining} crédits` : '— crédits'; }
const title = s => TITLES[s] || (state.models?.leagues?.[s]?.title) || (state.sportsList || []).find(x => x.key === s)?.title || s;
const activeSports = () => {
  const s = settings(), tennis = s.tennisAll ? (state.sportsList || []).filter(x => x.key.startsWith('tennis_')).map(x => x.key) : [];
  return [...new Set([...s.sports, ...tennis])];
};
const sportCost = sp => !settings().reference ? 1 : sp.startsWith('soccer_') ? 3 : 2;

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
    if (r.status === 404) throw new Error('Compétition terminée ou introuvable.');
    if (r.status >= 500) { last = 'HTTP ' + r.status; await new Promise(res => setTimeout(res, 1000 * 2 ** i)); continue; }
    if (!r.ok) throw new Error('Erreur du fournisseur (HTTP ' + r.status + ').');
    return r.json();
  }
  throw new Error(`Fournisseur injoignable (${last}). Les dernières cotes enregistrées restent affichées.`);
}
async function refreshSportsList(force) {
  const at = store.get('sportsAt', 0);
  if (!force && state.sportsList && Date.now() - at < 6 * 3600e3) return;
  const list = await oddsApi('/sports');     // free call
  state.sportsList = list.filter(x => x.active && !x.has_outrights).map(x => ({key: x.key, title: x.title, group: x.group}));
  store.set('sports', state.sportsList); store.set('sportsAt', Date.now());
}

/* ------------------------------------------------------------ data */
async function loadModels() {
  try { state.models = await (await fetch('data/models.json')).json(); }
  catch { state.models = {leagues: {}, aliases: {}, stop: []}; }
  state.matcher = Engine.makeMatcher(state.models.aliases || {}, state.models.stop || []);
}
const snapshot = sport => store.get('snap.' + sport);
function buildBoards() {
  const now = new Date(), boards = [];
  for (const sport of activeSports()) {
    const snap = snapshot(sport);
    if (!snap) continue;
    const league = state.models.leagues[sport];
    // Only the bookmaker(s) chosen in Réglages are proposed; every other book still feeds the probability estimate.
    const res = Engine.analyzeCompetition(snap.events, {now, sportName: title(sport), booksFilter: new Set(settings().books),
      modelPredict: Engine.modelPredictor(league, state.matcher), modelWeight: league?.validation?.weight || 0,
      method: league?.validation?.devig || 'shin', snapshotAge: (now - new Date(snap.fetched_at)) / 60000});
    const raw = new Map(snap.events.map(e => [e.id, e]));
    for (const e of res.events) {
      e._raw = raw.get(e.id);
      try { e.ins = Insights.matchInsights(e, league, state.matcher); } catch { e.ins = null; }
    }
    boards.push({sport, sport_title: title(sport), fetched_at: snap.fetched_at, events: res.events});
  }
  state.boards = boards;
  return boards;
}
const findEvent = (sport, id) => (state.boards || buildBoards()).find(b => b.sport === sport)?.events.find(e => e.id === id);
const slim = data => data.map(e => ({id: e.id, sport_key: e.sport_key, sport_title: e.sport_title, home_team: e.home_team, away_team: e.away_team,
  commence_time: e.commence_time, bookmakers: (e.bookmakers || []).map(b => ({key: b.key, title: b.title, last_update: b.last_update,
    markets: (b.markets || []).filter(m => m.key === 'h2h' || m.key === 'totals').map(m => ({key: m.key, outcomes: m.outcomes.map(o => ({name: o.name, price: o.price, ...(o.point != null ? {point: o.point} : {})}))}))}))}));
function merge(a, b) {
  const by = new Map(a.map(e => [e.id, {...e, bookmakers: [...e.bookmakers]}]));
  for (const e of b) { if (by.has(e.id)) by.get(e.id).bookmakers.push(...e.bookmakers); else by.set(e.id, e); }
  return [...by.values()];
}

async function analyzeAll(btn) {
  if (state.busy) return;
  const s = settings();
  try { await refreshSportsList(); } catch { /* the list is only needed for tennis */ }
  const todo = activeSports().filter(sp => { const sn = snapshot(sp); return !sn || (Date.now() - new Date(sn.fetched_at)) / 60000 >= s.minInterval; });
  if (!todo.length) { toast(`Cotes déjà à jour (moins de ${s.minInterval} min).`); return; }
  state.busy = true; let done = 0; const errors = [], start = store.get('usage')?.used;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Analyse en cours…'; }
  for (const sport of todo) {
    try {
      const base = {oddsFormat: 'decimal', dateFormat: 'iso'};
      let data;
      if (!s.reference) data = await oddsApi(`/sports/${sport}/odds`, {...base, regions: 'fr', markets: 'h2h'}, 1);
      else if (sport.startsWith('soccer_')) {
        // Unibet & co. (h2h) + Pinnacle/Betfair (h2h + goal line) for the reference.
        const fr = await oddsApi(`/sports/${sport}/odds`, {...base, regions: 'fr', markets: 'h2h'}, 1);
        const eu = await oddsApi(`/sports/${sport}/odds`, {...base, regions: 'eu', markets: 'h2h,totals'}, 2);
        data = merge(fr, eu);
      } else data = await oddsApi(`/sports/${sport}/odds`, {...base, regions: 'fr,eu', markets: 'h2h'}, 2);
      const prev = snapshot(sport);
      if (prev) store.set('prev.' + sport, prev);
      store.set('snap.' + sport, {fetched_at: new Date().toISOString(), events: slim(data)});
    } catch (e) {
      errors.push(`${title(sport)} : ${e.message}`);
      if (/Quota|Clé/.test(e.message)) break;
    }
    done++;
    const bar = $('progress'); if (bar) bar.style.width = (100 * done / todo.length) + '%';
  }
  state.busy = false;
  buildBoards();
  const used = start != null && store.get('usage')?.used != null ? store.get('usage').used - start : null;
  toast(errors.length ? errors.slice(0, 3).join(' · ') : `${todo.length} compétition(s) analysée(s)${used ? ` · ${used} crédits` : ''}.`, errors.length ? 'error' : 'success');
  render();
}

/* ------------------------------------------------------------ shared bits */
const stars = n => `<span class="stars" aria-label="${n} sur 5">${'★'.repeat(n)}<i>${'★'.repeat(5 - n)}</i></span>`;
const tracked = () => store.get('tracked', []).map(t => ({...t, key: t.key || 'h2h:' + t.outcome}));
const isTracked = (id, key) => tracked().some(t => t.event_id === id && t.key === key);
const tierPill = t => { const [i, l, c] = TIER_INFO[t]; return `<span class="pill ${c}">${i} ${l}</span>`; };
const priceBlock = o => o.price ? `<div class="odds"><b>${odds(o.price)}</b><span>${esc(o.book)}</span></div>`
  : `<div class="odds"><b class="min">≥ ${odds(o.fair * 1.03)}</b><span>cote mini Unibet</span></div>`;
function optStats(o) {
  return `<div class="stats"><div><span>Chance</span><b>${pct(o.p, 0)}</b><small>${pct(o.lo, 0)}–${pct(o.hi, 0)}</small></div>
    <div><span>Cote juste</span><b class="mono">${odds(o.fair)}</b><small>sans marge</small></div>
    <div><span>Rendement</span><b class="${o.edge > 0 ? 'pos' : o.edge != null ? 'neg' : ''}">${o.edge != null ? spct(o.edge) : '—'}</b><small>${o.edge != null ? 'par € misé' : 'selon cote Unibet'}</small></div>
    <div><span>Modèle</span><b>${o.model != null ? pct(o.model, 0) : '—'}</b><small>${o.model == null ? 'pas d’historique' : Math.abs(o.model - o.p) <= 0.05 ? 'confirme ✅' : o.model > o.p ? 'plus optimiste' : 'plus prudent ⚠️'}</small></div></div>`;
}
const whyList = (o, open) => `<details ${open ? 'open' : ''}><summary class="small">🤖 Pourquoi ce pari ?</summary><ul class="why-list">${o.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>`;
const trackBtn = (sport, e, o) => `<button class="btn sm" data-act="track" data-sport="${esc(sport)}" data-id="${esc(e.id)}" data-key="${esc(o.key)}" ${isTracked(e.id, o.key) ? 'disabled' : ''}>${isTracked(e.id, o.key) ? '✓ Suivi' : '＋ Suivre'}</button>`;

function tierItems(boards, tier, horizon) {
  const limit = Date.now() + horizon * 3600e3, items = [];
  for (const b of boards) for (const e of b.events) {
    if (!e.eligible || !e.ins || new Date(e.start).getTime() > limit) continue;
    const o = e.ins.tiers[tier];
    if (o) items.push({b, e, o});
  }
  const score = ({o}) => tier === 'safe' ? o.p + (o.edge != null ? 0.3 * (o.edge + 0.04) : -0.02)
    : tier === 'mid' ? (o.edge != null ? o.edge + 0.04 : -0.06) + 0.5 * o.p + (o.model != null ? -Math.abs(o.model - o.p) : 0)
      : (o.edge != null ? o.edge + 0.04 : -0.06) + (o.model != null ? -0.5 * Math.abs(o.model - o.p) : 0);
  return items.sort((x, y) => score(y) - score(x));
}
function tierCard({b, e, o}, rank) {
  return `<article class="pick ${rank === 1 ? 'hero' : ''}">
    <div class="pick-top"><span class="mono muted small">#${rank} · ${group(b.sport)[2]} ${esc(b.sport_title)}</span>${tierPill(o.tier)}</div>
    <div class="meta">${esc(when(e.start))}</div>
    <div class="match">${esc(e.home)} – ${esc(e.away)}</div>
    <div class="pick-main"><div class="sel">${esc(o.label)}</div>${priceBlock(o)}</div>
    ${optStats(o)}
    ${whyList(o, rank === 1)}
    <div class="pick-actions"><button class="btn sm" data-act="detail" data-sport="${esc(b.sport)}" data-id="${esc(e.id)}">Tout le match</button>${trackBtn(b.sport, e, o)}</div>
  </article>`;
}

/* ------------------------------------------------------------ Paris */
function viewPicks(v) {
  const s = settings();
  if (!store.get('key')) {
    v.innerHTML = `<div class="head"><div class="eyebrow">Bienvenue</div><h1>Paris du jour</h1><p>Pour analyser les vraies cotes, ajoute ta clé gratuite The Odds API.</p></div>
      <a class="btn primary block" href="#reglages">Ajouter ma clé API</a>
      <p class="legal">Les cotes sont téléchargées directement depuis ce téléphone. Ta clé reste uniquement sur ce téléphone.</p>`;
    return;
  }
  const boards = state.boards || buildBoards();
  const sports = activeSports(), cost = sports.reduce((a, sp) => a + sportCost(sp), 0);
  const groups = [...new Set(boards.filter(b => b.events.length).map(b => group(b.sport)[1]))];
  const shown = boards.filter(b => !state.grp || group(b.sport)[1] === state.grp);
  const oldest = boards.length ? Math.max(...boards.map(b => (Date.now() - new Date(b.fetched_at)) / 60000)) : null;
  let body;
  if (state.tab === 'value') {
    const p = Engine.buildPicks(shown, new Date(), s.horizon);
    const list = p.value.filter(c => c.probability >= state.minProb / 100 && c.odds >= state.minOdds);
    body = `<div class="verdict ${p.summary.with_value ? 'ok' : ''}"><b>${esc(p.verdict)}</b><span class="small muted">Value = cote ${esc(booksLabel(s))} au-dessus de la vraie probabilité.</span></div>
      ${list.length ? `<div class="picks list">${list.map((c, i) => valueCard(c, i + 1)).join('')}</div>` : '<div class="card empty">Rien pour ces filtres.</div>'}`;
  } else {
    const items = tierItems(shown, state.tab, s.horizon).filter(({o}) => o.p >= state.minProb / 100 && (o.price || o.fair * 1.03) >= state.minOdds);
    const [i, l, , d] = TIER_INFO[state.tab];
    body = `<div class="verdict ${state.tab === 'safe' ? 'ok' : ''}"><b>${i} ${l} — ${d}</b><span class="small muted">${items.length} match(s) · ${state.tab === 'safe' ? 'chance ≥ 68 %' : state.tab === 'mid' ? 'chance 45–68 %' : 'chance 15–45 %'} · le meilleur pari de chaque match pour ce niveau de risque</span></div>
      ${items.length ? `<div class="picks list">${items.map((x, k) => tierCard(x, k + 1)).join('')}</div>` : `<div class="card empty"><h3>${boards.length ? 'Aucun pari pour ces filtres' : 'Aucune cote pour l’instant'}</h3>${boards.length ? 'Élargis les filtres ou la période.' : 'Appuie sur « Analyser les matchs ».'}</div>`}`;
  }
  v.innerHTML = `
  <div class="head"><div class="eyebrow">Cotes ${esc(booksLabel(s))} · ${sports.length} compétitions</div><h1>Paris du jour</h1>
    <p>Pour chaque match : un pari 🟢 Safe, un 🟡 Mi-safe et un 🔴 Risqué, choisis et expliqués automatiquement à partir des cotes et des statistiques.</p></div>
  <button class="btn primary block" data-act="analyze">↻ Analyser les matchs · ${cost} crédits</button>
  <div class="progress"><i id="progress" style="width:0"></i></div>
  ${oldest != null ? `<p class="small muted" style="margin:0">Cotes ${ago(oldest)} · ${boards.reduce((a, b) => a + b.events.length, 0)} matchs</p>` : ''}
  <div class="chips">${['safe', 'mid', 'risky'].map(t => `<button class="chip ${state.tab === t ? 'on' : ''}" data-act="tab" data-tab="${t}">${TIER_INFO[t][0]} ${TIER_INFO[t][1]}</button>`).join('')}<button class="chip ${state.tab === 'value' ? 'on' : ''}" data-act="tab" data-tab="value">★ Value</button></div>
  <div class="chips"><button class="chip ${!state.grp ? 'on' : ''}" data-act="grp">Tous les sports</button>${groups.map(g => `<button class="chip ${state.grp === g ? 'on' : ''}" data-act="grp" data-g="${esc(g)}">${GROUPS.find(x => x[1] === g)?.[2] || ''} ${esc(g)}</button>`).join('')}</div>
  <div class="filters"><label class="field"><span>Chance min. ${state.minProb} %</span><input type="range" min="0" max="90" step="5" value="${state.minProb}" data-act="minprob"></label>
    <label class="field"><span>Cote min.</span><select data-act="minodds">${[1.01, 1.2, 1.5, 2, 3].map(x => `<option value="${x}" ${state.minOdds === x ? 'selected' : ''}>${odds(x)}</option>`).join('')}</select></label></div>
  ${body}
  <p class="legal">Les probabilités sont des estimations, jamais des certitudes. Aucun gain garanti. Vérifie toujours la cote chez Unibet. Interdit aux mineurs · 09 74 75 13 13.</p>`;
}
function valueCard(c, rank) {
  return `<article class="pick ${rank === 1 ? 'hero' : ''}">
    <div class="pick-top"><span class="mono muted small">#${rank} · ${group(c.sport)[2]} ${esc(c.competition)}</span><span class="pill ${c.stars >= 5 ? 'good' : c.stars >= 3 ? 'accent' : c.stars >= 1 ? 'warning' : 'neutral'}">${stars(c.stars)} ${esc(c.label)}</span></div>
    <div class="meta">${esc(when(c.start))}</div><div class="match">${esc(c.home)} – ${esc(c.away)}</div>
    <div class="pick-main"><div class="sel">${esc(c.selection)}</div><div class="odds"><b>${odds(c.odds)}</b><span>${esc(c.bookmaker)}</span></div></div>
    <div class="stats"><div><span>Chance</span><b>${pct(c.probability, 0)}</b><small>${pct(c.p_low, 0)}–${pct(c.p_high, 0)}</small></div><div><span>Cote juste</span><b class="mono">${odds(c.fair_odds)}</b><small>sans marge</small></div>
      <div><span>Rendement</span><b class="${c.edge > 0 ? 'pos' : 'neg'}">${spct(c.edge)}</b><small>par € misé</small></div><div><span>Fiabilité</span><b>${c.reliability}</b><small>${esc(c.reliability_label)}</small></div></div>
    <p class="why">${esc(c.explanation)}</p>
    <div class="pick-actions"><button class="btn sm" data-act="detail" data-sport="${esc(c.sport)}" data-id="${esc(c.event_id)}">Tout le match</button></div></article>`;
}

/* ------------------------------------------------------------ Matchs */
function viewMatches(v) {
  const boards = (state.boards || buildBoards()).filter(b => b.events.length);
  if (!boards.length) { v.innerHTML = `<div class="head"><h1>Matchs</h1></div><div class="card empty"><h3>Aucune donnée</h3>Lance une analyse depuis l’onglet Paris.</div>`; return; }
  const sel = state.comp && boards.some(b => b.sport === state.comp) ? state.comp : boards[0].sport;
  const b = boards.find(x => x.sport === sel), league = state.models.leagues[sel];
  v.innerHTML = `<div class="head"><div class="eyebrow">Cotes ${ago((Date.now() - new Date(b.fetched_at)) / 60000)}</div><h1>Matchs</h1></div>
  <div class="chips">${boards.map(x => `<button class="chip ${x.sport === sel ? 'on' : ''}" data-act="comp" data-sport="${esc(x.sport)}">${group(x.sport)[2]} ${esc(x.sport_title)}</button>`).join('')}</div>
  ${league ? `<div class="verdict ${league.validation?.validated ? 'ok' : ''}"><b>Statistiques : ${league.matches} matchs analysés (5 saisons)</b><span class="small muted">${league.validation ? `Modèle testé sur ${league.validation.test_n} matchs jamais vus : ${league.validation.validated ? 'validé' : 'second avis (le marché reste plus précis)'}.` : 'Modèle utilisé comme second avis.'}</span></div>`
    : `<div class="verdict"><b>${group(sel)[2]} Analyse par les cotes du marché</b><span class="small muted">Pas d’historique gratuit pour cette compétition : la probabilité vient des cotes Pinnacle/Betfair sans marge.</span></div>`}
  <div class="list">${b.events.map(e => {
    const t = e.ins?.tiers || {};
    return `<button class="row match-row" data-act="detail" data-sport="${esc(sel)}" data-id="${esc(e.id)}">
      <div class="t">${esc(e.home)} – ${esc(e.away)}</div><div class="s">${esc(when(e.start))} · fiabilité ${e.reliability.score}/100</div>
      <div class="tiers-mini">${['safe', 'mid', 'risky'].map(k => t[k] ? `<span>${TIER_INFO[k][0]} ${esc(t[k].label)} <b>${t[k].price ? odds(t[k].price) : '≥' + odds(t[k].fair * 1.03)}</b></span>` : '').join('')}</div></button>`;
  }).join('') || '<div class="card empty">Aucun match à venir.</div>'}</div>`;
}

/* ------------------------------------------------------------ Détail d'un match */
function teamCard(s, label) {
  if (!s || !s.n) return '';
  const r = x => `${x.w}V ${x.d}N ${x.l}D`;
  return `<div class="card"><div class="pick-top"><h3>${esc(label)}</h3><div class="form">${s.last5.map(f => `<span class="${f.res}" title="${esc(f.date)} ${f.home ? 'vs' : '@'} ${esc(f.opp)} ${f.f}-${f.c}">${f.res}</span>`).join('')}</div></div>
    <div class="kv"><span>5 derniers</span><b>${r(s.form)}</b><span>À domicile</span><b>${r(s.home)} (${s.home.gf}-${s.home.ga})</b><span>À l’extérieur</span><b>${r(s.away)} (${s.away.gf}-${s.away.ga})</b>
    <span>Buts marqués / encaissés</span><b>${nf(1).format(s.avgFor)} / ${nf(1).format(s.avgAgainst)} par match</b><span>Plus de 2,5 buts</span><b>${Math.round(s.over25 * s.n)}/${s.n}</b><span>Les 2 équipes marquent</span><b>${Math.round(s.btts * s.n)}/${s.n}</b><span>Sans encaisser</span><b>${Math.round(s.cleanSheets * s.n)}/${s.n}</b></div>
    <p class="small muted" style="margin:6px 0 0">${s.last5.map(f => `${f.home ? 'vs' : '@'} ${esc(f.opp)} ${f.f}-${f.c}`).join(' · ')}</p></div>`;
}
function detailHtml(sport, e) {
  const ins = e.ins || {opts: [], tiers: {}};
  const prev = store.get('prev.' + sport), prevEv = prev?.events.find(x => x.id === e.id);
  const prevPrice = (bk, o) => prevEv?.bookmakers.find(b => b.key === bk)?.markets?.find(m => m.key === 'h2h')?.outcomes.find(x => x.name === o)?.price;
  const arrow = (bk, o, now) => { const p = prevPrice(bk, o); return !p || p === now ? '' : now > p ? ' <span class="pos">▲</span>' : ' <span class="neg">▼</span>'; };
  const mine = e.bookmakers.filter(b => b.selected), ref = e.bookmakers.filter(b => !b.selected);
  const table = list => `<table><thead><tr><th>Bookmaker</th>${e.outcomes.map(o => `<th>${o === 'Draw' ? 'N' : o === e.home ? '1' : '2'}</th>`).join('')}<th>Marge</th></tr></thead><tbody>${list.map(b => `<tr><td>${esc(b.title)}${b.stale ? ' <span class="pill critical">retard</span>' : ''}</td>${e.outcomes.map(o => `<td class="mono ${e.best[o]?.key === b.key ? 'best' : ''}">${odds(b.odds[o])}${arrow(b.key, o, b.odds[o])}</td>`).join('')}<td class="mono">${pct(b.overround, 1)}</td></tr>`).join('')}</tbody></table>`;
  const fam = {h2h: 'Résultat', dc: 'Double chance', dnb: 'Remboursé si nul', total: 'Nombre de buts', btts: 'Les deux équipes marquent', teamgoal: 'Équipe marque'};
  const byFam = Object.keys(fam).map(f => [f, ins.opts.filter(o => o.family === f)]).filter(([, l]) => l.length);
  return `<div><div class="eyebrow">${group(sport)[2]} ${esc(title(sport))} · ${esc(when(e.start))}</div><h2>${esc(e.home)} – ${esc(e.away)}</h2>
    <p class="small muted" style="margin:4px 0 0">Fiabilité ${e.reliability.score}/100 · ${e.books_used} bookmakers · référence ${e.market.source === 'sharp' ? 'Pinnacle/Betfair' : 'médiane'}${ins.totals ? ` · ≈ ${nf(1).format(ins.totals.total)} buts attendus` : ''}</p></div>
  <h3 style="margin:4px 0 -4px">Les 3 paris du match</h3>
  ${['safe', 'mid', 'risky'].map(t => { const o = ins.tiers[t]; return o ? `<div class="card tier-${t}"><div class="pick-top">${tierPill(t)}<span class="small muted">${TIER_INFO[t][3]}</span></div>
    <div class="pick-main" style="margin-top:6px"><div class="sel">${esc(o.label)}</div>${priceBlock(o)}</div>${optStats(o)}${whyList(o, t === 'safe')}<div class="pick-actions" style="margin-top:8px">${trackBtn(sport, e, o)}</div></div>`
    : `<div class="card small muted">${TIER_INFO[t][0]} Pas de pari ${TIER_INFO[t][1]} pour ce match.</div>`; }).join('')}
  ${teamCard(ins.hs, e.model?.matched?.home || e.home)}${teamCard(ins.as, e.model?.matched?.away || e.away)}
  ${ins.h2h?.length ? `<div class="card"><h3>Confrontations récentes</h3><ul class="why-list">${ins.h2h.map(m => `<li>${esc(m.date)} · ${esc(m.home)} <b>${m.hg}-${m.ag}</b> ${esc(m.away)}</li>`).join('')}</ul></div>` : ''}
  <div class="card"><h3>Tous les paris calculés</h3><p class="small muted">Cote juste = prix sans marge. Une cote Unibet au-dessus de la cote juste est intéressante.</p>
    ${byFam.map(([f, l]) => `<div class="fam">${esc(fam[f])}</div><table><tbody>${l.map(o => `<tr><td>${esc(o.label)}</td><td>${pct(o.p, 0)}</td><td class="mono">${odds(o.fair)}</td><td class="mono ${o.edge > 0 ? 'pos' : ''}">${o.price ? odds(o.price) : '—'}</td></tr>`).join('')}</tbody></table>`).join('')}</div>
  <div class="card"><h3>Qualité des données</h3>${e.reliability.flags.length ? `<ul class="flags">${e.reliability.flags.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="small muted">Aucune alerte.</p>'}</div>
  <div class="card"><h3>Cotes ${esc(booksLabel(settings()))}</h3>${mine.length ? table(mine) : `<p class="small muted">${esc(booksLabel(settings()))} ne propose pas ce match.</p>`}
    ${ref.length ? `<details style="margin-top:8px"><summary class="small">Autres bookmakers (${ref.length}) — servent seulement à estimer la probabilité</summary>${table(ref)}</details>` : ''}
    <p class="small muted" style="margin:6px 0 0">▲▼ : variation depuis l’analyse précédente.</p></div>`;
}
function openDetail(sport, id) {
  const e = findEvent(sport, id);
  if (!e) { toast('Match introuvable : relance l’analyse.', 'error'); return; }
  $('sheetContent').innerHTML = detailHtml(sport, e);
  $('sheet').hidden = false; document.body.style.overflow = 'hidden';
  $('sheet').dataset.sport = sport; $('sheet').dataset.id = id;
}
function closeSheet() { $('sheet').hidden = true; document.body.style.overflow = ''; }

/* ------------------------------------------------------------ Mes paris */
function trackOption(sport, id, key) {
  const e = findEvent(sport, id), o = e?.ins?.opts.find(x => x.key === key);
  if (!o) return false;
  let price = o.price;
  if (!price) {
    const answer = prompt(`Cote Unibet trouvée pour « ${o.label} » ? (minimum conseillé ${odds(o.fair * 1.03)}) — laisse vide si tu ne sais pas`, '');
    if (answer === null) return false;
    const v = parseFloat(String(answer).replace(',', '.'));
    price = isFinite(v) && v > 1 ? v : null;
  }
  const list = tracked();
  if (list.some(t => t.event_id === id && t.key === key)) return false;
  const tier = ['safe', 'mid', 'risky'].find(t => e.ins.tiers[t]?.key === key) || null;
  list.unshift({event_id: id, sport, home: e.home, away: e.away, start: e.start, key, tier, selection: o.label, odds: price, bookmaker: o.book || 'Unibet',
    probability: o.p, fair: o.fair, added_at: new Date().toISOString(), result: null});
  store.set('tracked', list.slice(0, 500));
  toast('Ajouté à « Mes paris ». Le résultat sera vérifié après le match.', 'success');
  return true;
}
function settle(key, home, away, hs, as) {
  const [k, v] = key.split(':'), total = hs + as;
  const won = c => c ? 'won' : 'lost';
  if (k === 'h2h') return won(v === 'Draw' ? hs === as : v === home ? hs > as : v === away ? as > hs : false);
  if (k === 'dc') return won(v === '1N' ? hs >= as : v === 'N2' ? hs <= as : hs !== as);
  if (k === 'over') return won(total > +v);
  if (k === 'under') return won(total < +v);
  if (k === 'btts') return won(v === 'yes' ? hs > 0 && as > 0 : hs === 0 || as === 0);
  if (k === 'tg') return won(v === 'home' ? hs > 0 : as > 0);
  if (k === 'dnb') return hs === as ? 'void' : won(v === 'home' ? hs > as : as > hs);
  return null;
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
        for (const t of list) if (t.event_id === g.id && !t.result) { t.result = settle(t.key, g.home_team, g.away_team, hs, as); t.score = `${hs}-${as}`; }
      }
    } catch (e) { errors.push(e.message); }
  }
  store.set('tracked', list);
  toast(errors.length ? errors.join(' · ') : 'Résultats mis à jour.', errors.length ? 'error' : 'success');
  render();
}
function viewTracking(v) {
  const list = tracked(), done = list.filter(t => t.result && t.result !== 'void'), won = done.filter(t => t.result === 'won');
  const withOdds = done.filter(t => t.odds);
  const profit = withOdds.reduce((s, t) => s + (t.result === 'won' ? t.odds - 1 : -1), 0);
  const expWins = done.reduce((s, t) => s + t.probability, 0);
  const pending = list.filter(t => !t.result && new Date(t.start) < new Date()).length;
  const byTier = t => { const l = done.filter(x => x.tier === t); return l.length ? `${l.filter(x => x.result === 'won').length}/${l.length}` : '—'; };
  v.innerHTML = `<div class="head"><div class="eyebrow">Résultats réels</div><h1>Mes paris</h1><p>Les paris que tu suis, comparés aux vrais résultats : la mesure honnête de la qualité des analyses.</p></div>
  <div class="kpis"><div class="kpi"><span>Suivis</span><b>${list.length}</b><small>${pending} en attente</small></div>
    <div class="kpi"><span>Gagnés</span><b>${done.length ? `${won.length}/${done.length}` : '—'}</b><small>${done.length ? `attendu : ${nf(1).format(expWins)}` : 'aucun terminé'}</small></div>
    <div class="kpi"><span>Bilan (1 € / pari)</span><b class="${profit >= 0 ? 'pos' : 'neg'}">${withOdds.length ? (profit >= 0 ? '+' : '') + nf(2).format(profit) + ' €' : '—'}</b><small>${withOdds.length ? 'rendement ' + spct(profit / withOdds.length) : 'cotes manquantes'}</small></div>
    <div class="kpi"><span>Par niveau</span><b class="small">🟢 ${byTier('safe')} · 🟡 ${byTier('mid')} · 🔴 ${byTier('risky')}</b><small>${done.length < 100 ? 'échantillon trop petit pour conclure' : 'exploitable'}</small></div></div>
  <button class="btn block" data-act="results" ${pending ? '' : 'disabled'}>Vérifier les résultats · 2 crédits par compétition</button>
  <div class="list">${list.map((t, i) => `<div class="row"><div><div class="t">${t.tier ? TIER_INFO[t.tier][0] + ' ' : ''}${esc(t.selection)} · <span class="mono">${t.odds ? odds(t.odds) : 'cote ?'}</span></div><div class="s">${esc(t.home)} – ${esc(t.away)} · ${esc(when(t.start))} · chance ${pct(t.probability, 0)}</div></div>
    <div class="r">${t.result ? `<span class="pill ${t.result === 'won' ? 'good' : t.result === 'void' ? 'neutral' : 'critical'}">${t.result === 'won' ? 'Gagné' : t.result === 'void' ? 'Remboursé' : 'Perdu'} ${esc(t.score || '')}</span>` : new Date(t.start) < new Date() ? '<span class="pill warning">En attente</span>' : '<span class="pill neutral">À venir</span>'}<br><button class="btn sm" style="margin-top:6px" data-act="untrack" data-i="${i}" aria-label="Retirer">✕</button></div></div>`).join('') || '<div class="card empty"><h3>Aucun pari suivi</h3>Appuie sur « ＋ Suivre » sur un pari pour le suivre.</div>'}</div>`;
}

/* ------------------------------------------------------------ Réglages */
function viewSettings(v) {
  const s = settings(), key = store.get('key'), u = store.get('usage');
  const list = (state.sportsList || DEFAULT_SPORTS.map(k => ({key: k, title: title(k)}))).filter(x => !x.key.startsWith('tennis_') || !s.tennisAll);
  const grouped = GROUPS.map(g => [g, list.filter(x => x.key.startsWith(g[0])).sort((a, b) => (!!state.models.leagues[b.key] - !!state.models.leagues[a.key]) || a.title.localeCompare(b.title))]).filter(([, l]) => l.length);
  const cost = activeSports().reduce((a, sp) => a + sportCost(sp), 0);
  v.innerHTML = `<div class="head"><div class="eyebrow">Configuration</div><h1>Réglages</h1></div>
  <div class="card"><h3>Clé The Odds API</h3><p class="small muted">${key ? `Enregistrée sur ce téléphone (…${esc(key.slice(-4))}).` : 'Gratuite : 500 crédits/mois sur the-odds-api.com.'} Elle n’est envoyée qu’à The Odds API.</p>
    <div class="field" style="margin-top:8px"><input type="password" id="key" autocomplete="off" placeholder="${key ? 'Remplacer la clé' : 'Colle ta clé ici'}"></div>
    <div class="pick-actions" style="margin-top:8px"><button class="btn primary" data-act="savekey">Enregistrer</button><button class="btn" data-act="testkey" ${key ? '' : 'disabled'}>Tester (gratuit)</button></div>
    <p class="small muted" style="margin:8px 0 0">Crédits restants : <b>${u?.remaining ?? '—'}</b>${u?.used != null ? ` · utilisés ce mois : ${u.used}` : ''} · une analyse complète : <b>${cost}</b> crédits.</p></div>
  <div class="card"><h3>Bookmaker pour jouer</h3><p class="small muted">Seules ses cotes sont proposées. Les autres servent uniquement à estimer la vraie probabilité.</p>
    ${FR_BOOKS.map(([k, l]) => `<label class="check"><input type="checkbox" name="bk" value="${k}" ${s.books.includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
  <div class="card"><h3>Sports et compétitions</h3><p class="small muted">Foot : 3 crédits (cotes + ligne de buts Pinnacle). Autres sports : 2 crédits. « stats » = historique des équipes disponible.</p>
    <label class="check"><input type="checkbox" id="tennisAll" ${s.tennisAll ? 'checked' : ''}> 🎾 Tous les tournois de tennis en cours (automatique)</label>
    ${grouped.map(([g, l]) => `<div class="fam">${g[2]} ${esc(g[1])}</div>${l.map(x => `<label class="check"><input type="checkbox" name="sp" value="${esc(x.key)}" ${s.sports.includes(x.key) ? 'checked' : ''}> ${esc(x.title)}${state.models.leagues[x.key] ? ' <span class="pill accent">stats</span>' : ''}</label>`).join('')}`).join('')}
    ${state.sportsList ? '' : '<button class="btn sm" data-act="loadsports" style="margin-top:8px">Voir tous les sports (gratuit)</button>'}</div>
  <div class="card"><h3>Précision</h3>
    <label class="check"><input type="checkbox" id="ref" ${s.reference ? 'checked' : ''}> Référence Pinnacle / Betfair (recommandé, bien plus précis)</label>
    <div class="filters" style="margin-top:8px"><label class="field"><span>Période</span><select id="horizon">${[[24, '24 h'], [72, '3 jours'], [168, '7 jours']].map(([h, l]) => `<option value="${h}" ${s.horizon === h ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="field"><span>Réserve de crédits</span><input type="number" id="reserve" min="0" value="${s.reserve}"></label></div></div>
  <button class="btn primary block" data-act="savesettings">Enregistrer les réglages</button>
  <div class="card"><h3>Comment l’appli choisit</h3><p class="small muted">🟢 Safe : chance d’au moins 68 %. 🟡 Mi-safe : 45 à 68 %. 🔴 Risqué : 15 à 45 %. Dans chaque niveau, l’appli prend le pari le mieux payé par rapport à sa vraie probabilité, et celui sur lequel le marché et les statistiques sont d’accord.</p>
    <p class="small muted">Les buteurs ne sont pas proposés : aucune donnée joueur fiable et gratuite n’existe, et l’appli n’invente rien. Les cotes Unibet des paris « plus/moins de buts », « double chance » et « les deux équipes marquent » ne sont pas transmises par la source : l’appli donne la cote minimum à exiger.</p></div>
  <div class="card"><h3>Installer l’appli</h3><p class="small muted"><b>iPhone</b> (Safari) : Partager → « Sur l’écran d’accueil ». <b>Android</b> (Chrome) : ⋮ → « Installer l’application ».</p>
    <p class="small muted">Statistiques : ${state.models.generated_at ? `mises à jour le ${esc(new Date(state.models.generated_at).toLocaleDateString('fr-FR'))}` : 'indisponibles'} (football-data.co.uk).</p></div>
  <button class="btn danger block" data-act="wipe">Effacer toutes mes données sur ce téléphone</button>
  <p class="legal">Tout reste sur ce téléphone. Aucun pari n’est placé. Interdit aux mineurs · Joueurs Info Service 09 74 75 13 13.</p>`;
}

/* ------------------------------------------------------------ router & events */
function render() {
  const tab = (location.hash.replace('#', '') || 'paris');
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  ({paris: viewPicks, matchs: viewMatches, suivi: viewTracking, reglages: viewSettings}[tab] || viewPicks)($('view'));
}
document.addEventListener('click', async ev => {
  const t = ev.target.closest('[data-act]');
  if (!t) { if (ev.target === $('sheet')) closeSheet(); return; }
  const a = t.dataset.act;
  if (a === 'analyze') analyzeAll(t);
  else if (a === 'tab') { state.tab = t.dataset.tab; render(); }
  else if (a === 'grp') { state.grp = t.dataset.g || null; render(); }
  else if (a === 'comp') { state.comp = t.dataset.sport || null; render(); }
  else if (a === 'detail') openDetail(t.dataset.sport, t.dataset.id);
  else if (a === 'track') { if (trackOption(t.dataset.sport, t.dataset.id, t.dataset.key)) { t.disabled = true; t.textContent = '✓ Suivi'; } }
  else if (a === 'untrack') { const l = tracked(); l.splice(+t.dataset.i, 1); store.set('tracked', l); render(); }
  else if (a === 'results') updateResults(t);
  else if (a === 'savekey') {
    const k = $('key').value.trim();
    if (!/^[A-Za-z0-9_-]{10,160}$/.test(k)) return toast('Format de clé invalide.', 'error');
    store.set('key', k); toast('Clé enregistrée sur ce téléphone.', 'success'); render();
  } else if (a === 'testkey' || a === 'loadsports') {
    try { await refreshSportsList(true); toast(`Clé valide · ${store.get('usage')?.remaining ?? '?'} crédits restants.`, 'success'); render(); }
    catch (e) { toast(e.message, 'error'); }
  } else if (a === 'savesettings') {
    const sports = [...document.querySelectorAll('input[name="sp"]:checked')].map(i => i.value);
    const books = [...document.querySelectorAll('input[name="bk"]:checked')].map(i => i.value);
    const tennisAll = $('tennisAll').checked;
    if (!sports.length && !tennisAll) return toast('Choisis au moins une compétition.', 'error');
    if (!books.length) return toast('Choisis au moins un bookmaker.', 'error');
    store.set('settings', {...settings(), sports, books, tennisAll, reference: $('ref').checked, horizon: +$('horizon').value, reserve: Math.max(0, +$('reserve').value || 0)});
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

'use strict';
/* ===== MOVE PAPER BOT v2 — the lane race (paper trading) =====
   Runs on GitHub Actions. Same verified engine as the scanner. ONE signal stream,
   SEVERAL parallel "lanes" (paper books) that share the exact same entries but exit
   differently, so live paper data shows which exit geometry actually performs:
     - at each closed candle of `tf`, rank coins by the magnitude model's chance of any move;
     - a coin with chance >= minChance (the offline top-5% band, ~0.53 at 1h W6) is a candidate;
     - if the direction lean >= leanMinPts points and the entry filter passes (counter = the
       last candle moved AGAINST the lean, the >=95% win-rate profile), EVERY lane enters AT
       THE CANDLE CLOSE in the lean direction (long or SIMULATED short), fixed $ notional;
     - each lane walks its own TP/SL first-touch over the next W closed candles
       (both-touched in one candle -> open-proximity heuristic, same as the backtest);
       timeout at candle W exits at close;
     - each lane is an INDEPENDENT $20 paper book (own cash, stats, equity curve, loss cap).
   Default lanes: scalp 0.10/0.75 (95.25% WR profile) · balanced 0.30/1.50 (old default)
   · runner 3.00/4.00 (the only fee-surviving geometry we measured).
   Fees charged per side (feeBpsPerSide; 5 bps/side = 10 bps round-trip = USDT-M futures taker).
   Everything is event-logged to docs/data/trades.jsonl (events carry the lane name);
   state.json holds all the paper books. Paper only: no orders, no keys.
   Shorts are SIMULATED (spot accounts cannot short). */
const fs = require('fs'), path = require('path');
const C = require('./core.js');
const S = require('./scan.js');

const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'docs', 'data'), CFG = path.join(ROOT, 'config.json');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const DAY = 86400000;

const DEFAULTS = {
  startEquity: 20, notionalPerTrade: 5, maxOpen: 4,
  tf: '1h', W: 6, leanMinPts: 10, minChance: 0.53,
  tpMode: 'fixed', tpPct: 0.10, slPct: 0.75,          // only used when lanes: [] (single legacy book)
  feeBpsPerSide: 5,                                   // 5/side = 10 bps RT = USDT-M futures taker; 10 = spot taker; ~2 = maker
  topN: 40, minVolUsd: 1000000,
  entryFilter: 'counter',        // 'counter' = fade the last candle (the >=95% WR profile) | 'momentum' | 'any'
  maxLossesPerDay: 3,            // per lane: stop NEW entries after this many losing closes today (0 = off)
  allowShort: true, retentionDays: 120, startMs: null,
  lanes: [                       // the horse race: same entries, different exits
    { name: 'scalp',    tpPct: 0.10, slPct: 0.75 },
    { name: 'balanced', tpPct: 0.30, slPct: 1.50 },
    { name: 'runner',   tpPct: 3.00, slPct: 4.00 }
  ]
};

const r5 = (x) => Number.isFinite(x) ? Math.round(x * 1e5) / 1e5 : null;
const r4 = (x) => Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null;
const r3 = (x) => Number.isFinite(x) ? Math.round(x * 1e3) / 1e3 : null;
const r6 = (x) => Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const readJSON = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } };
const writeJSON = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
const append = (p, line) => fs.appendFileSync(p, line + '\n');

/* Lane list from config. Array -> fixed geometries. Empty/missing -> one legacy book
   ("solo") that resolves its TP/SL at entry from tpMode/tpPct/slPct (v1 behaviour). */
function laneDefs(cfg) {
  if (Array.isArray(cfg.lanes) && cfg.lanes.length) {
    return cfg.lanes.map((l, i) => ({ name: String(l.name || 'lane' + (i + 1)), tpPct: Number(l.tpPct), slPct: Number(l.slPct) }))
      .filter(l => (l.tpPct > 0) && (l.slPct > 0));
  }
  return [{ name: 'solo', solo: true }];
}

function emptyBook(eq) { return { open: [], cash: eq, marks: [], daily: {}, dailyLoss: {} }; }

/* First-touch TP/SL walk over closed candles after entry. Mirrors the backtest sim_one.
   pos = {side, entry, tp, sl, W, tEntry(open ms of entry candle)}. g = grid. Returns close or null. */
function walkExit(g, pos, nowMs) {
  const step = g.step;
  const i0 = Math.round((pos.tEntry - g.t0) / step);
  if (i0 < 0 || i0 >= g.n) return null;
  let mfe = -Infinity, mae = -Infinity, held = 0;
  for (let k = 1; k <= pos.W; k++) {
    const j = i0 + k;
    if (j >= g.n) break;                                       // candle not closed yet
    const hh = g.h[j], ll = g.l[j], oo = g.o[j], cc = g.c[j];
    if (cc === cc) { /* close not needed: exits are at TP/SL/close-of-W */ }
    if (!(hh === hh) && !(ll === ll)) continue;
    held = k;
    const fav = pos.side > 0 ? hh / pos.entry - 1 : 1 - ll / pos.entry;   // how far it went OUR way
    const adv = pos.side > 0 ? 1 - ll / pos.entry : hh / pos.entry - 1;   // how far it went AGAINST us
    mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);
    const hitTp = pos.side > 0 ? hh >= pos.tp : ll <= pos.tp;
    const hitSl = pos.side > 0 ? ll <= pos.sl : hh >= pos.sl;
    if (hitTp && hitSl) {
      const o = (oo === oo) ? oo : pos.entry;
      const tpWin = Math.abs(o - pos.tp) <= Math.abs(o - pos.sl);
      return { k, reason: tpWin ? 'intrabar_win' : 'intrabar_loss', exit: tpWin ? pos.tp : pos.sl, mfe, mae, held: k };
    }
    if (hitSl) return { k, reason: 'loss', exit: pos.sl, mfe, mae, held: k };
    if (hitTp) return { k, reason: 'win', exit: pos.tp, mfe, mae, held: k };
  }
  const jW = i0 + pos.W;
  if (jW < g.n && g.c[jW] === g.c[jW]) {
    return { k: pos.W, reason: 'timeout', exit: g.c[jW], mfe, mae, held: pos.W };   // the backtest 'exp' case
  }
  return null;                                                  // still inside the window
}

function pnlNet(pos, exit) {
  const gross = pos.side * (exit / pos.entry - 1) * pos.notional;
  const fees = pos.notional * 2 * pos.feeBps / 1e4;
  return { gross, fees, net: gross - fees };
}

/* TP/SL distances for one lane at entry time. */
function laneTpSl(cfg, L, r, side, W) {
  if (!L.solo) return { tpPct: L.tpPct, slPct: L.slPct };
  const thrSide = side > 0 ? r.thr[W].up : r.thr[W].dn;    // legacy single book: honor tpMode
  let tpPct, slPct;
  if (cfg.tpMode === 'halfEvent') { tpPct = 0.5 * thrSide; slPct = 0.5 * thrSide; }
  else if (cfg.tpMode === 'fullEvent') { tpPct = 1.0 * thrSide; slPct = 1.0 * thrSide; }
  else { tpPct = cfg.tpPct; slPct = cfg.slPct; }
  return (tpPct > 0 && slPct > 0) ? { tpPct, slPct } : null;
}

/* Rebuild the v2 working state from the event log (used when state.json is missing). */
function rebuildFromLog(cfg, defs) {
  const st = { startMs: cfg.startMs, nextId: 1, lastCandleMs: 0, lanes: {} };
  for (const d of defs) st.lanes[d.name] = emptyBook(cfg.startEquity);
  const f = path.join(DATA, 'trades.jsonl');
  if (!fs.existsSync(f)) return st;
  for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
    const lane = ev.lane || (ev.pos && ev.pos.lane);
    if (ev.ev === 'open') {
      if (!lane || !st.lanes[lane]) continue;                    // pre-lane (v1) events are not part of the race
      st.lanes[lane].open.push({ ...ev.pos, lane });
      st.nextId = Math.max(st.nextId, ev.id + 1);
    } else if (ev.ev === 'close') {
      if (!lane || !st.lanes[lane]) continue;
      st.lanes[lane].cash += ev.net;
      st.lanes[lane].daily[ymd(ev.exitMs)] = (st.lanes[lane].daily[ymd(ev.exitMs)] || 0) + ev.net;
      if (ev.net < 0) st.lanes[lane].dailyLoss[ymd(ev.exitMs)] = (st.lanes[lane].dailyLoss[ymd(ev.exitMs)] || 0) + 1;
      st.lastCandleMs = Math.max(st.lastCandleMs, ev.exitMs);
    }
  }
  return st;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  let user = readJSON(CFG, {});
  const cfg = Object.assign({}, DEFAULTS, user);
  const defs = laneDefs(cfg);
  let cfgChanged = false;
  if (!cfg.startMs) { cfg.startMs = Date.now(); user.startMs = cfg.startMs; cfgChanged = true; log('paper books start now'); }
  if (cfgChanged || !fs.existsSync(CFG)) fs.writeFileSync(CFG, JSON.stringify(user, null, 2) + '\n');

  // ---------- load state (v2 multi-lane; migrate a v1 single-book account by archiving it) ----------
  const statePath = path.join(DATA, 'state.json');
  let raw = readJSON(statePath, null);
  let st = null;
  if (raw && raw.v === 2 && raw.lanes) {
    st = { startMs: raw.startMs || cfg.startMs, nextId: raw.nextId || 1, lastCandleMs: raw.lastCandleMs || 0, lanes: {} };
    for (const nm of Object.keys(raw.lanes)) {
      const L = raw.lanes[nm];
      st.lanes[nm] = { open: L.open || [], cash: Number.isFinite(L.cash) ? L.cash : cfg.startEquity, marks: L.marks || [], daily: L.daily || {}, dailyLoss: L.dailyLoss || {} };
    }
    for (const d of defs) if (!st.lanes[d.name]) { st.lanes[d.name] = emptyBook(cfg.startEquity); log('new lane "' + d.name + '" gets a fresh $' + cfg.startEquity + ' book'); }
  } else if (raw && raw.open) {
    fs.writeFileSync(path.join(DATA, 'state-v1-archived.json'), JSON.stringify(raw));
    append(path.join(DATA, 'trades.jsonl'), JSON.stringify({ ev: 'note', t: Date.now(), msg: 'v1 single-strategy account archived (state-v1-archived.json); lane race started fresh' }));
    log('found a v1 (single-strategy) state.json -> archived to state-v1-archived.json, starting the lane race fresh');
  }
  if (!st) st = rebuildFromLog(cfg, defs);

  const t0 = Date.now();
  log('loading tickers');
  const tick = await S.jget('/api/v3/ticker/24hr');
  const uni = S.universe(tick, cfg.topN, cfg.minVolUsd || 1000000);
  const uniSyms = uni.map(u => u.sym);
  const uniMap = new Map(uni.map(u => [u.sym, u]));
  const openSyms = [...new Set(Object.values(st.lanes).flatMap(b => b.open.map(p => p.sym)))];
  const syms = [...new Set(uniSyms.concat(openSyms))];
  log(`fetching ${cfg.tf} candles for ${syms.length} coins (${openSyms.length} with open positions), ${defs.length} lane${defs.length > 1 ? 's' : ''}`);
  const { map, errs } = await S.fetchCandles(syms, cfg.tf, 6);
  const sc = S.score(cfg.tf, map);
  const tOpen = sc.lastCloseMs - C.TF[cfg.tf].mins * 60000;
  log(`${sc.rows.length} ranked, signal candle ${new Date(tOpen).toISOString()}`);
  const fresh = !st.lastCandleMs || sc.lastCloseMs > st.lastCandleMs;

  // ---------- 1. manage open positions (every book, incl. lanes no longer configured) ----------
  let closedN = 0;
  for (const nm of Object.keys(st.lanes)) {
    const bk = st.lanes[nm];
    for (let i = bk.open.length - 1; i >= 0; i--) {
      const pos = bk.open[i];
      const rows = map.get(pos.sym);
      if (!rows || !rows.length) continue;
      const g = C.buildGrid(rows, C.TF[pos.tf].mins * 60000);
      const ex = walkExit(g, pos, Date.now());
      if (!ex) continue;
      const { gross, fees, net } = pnlNet(pos, ex.exit);
      const exitMs = pos.tEntry + (ex.k + 1) * g.step;            // close time of the exit candle
      const risk$ = Math.abs(pos.entry - pos.sl) / pos.entry * pos.notional;
      const closeEv = {
        ev: 'close', lane: nm, id: pos.id, sym: pos.sym, side: pos.side, exit: r6(ex.exit), exitMs,
        reason: ex.reason, candlesHeld: ex.k, mfe: r5(ex.mfe), mae: r5(ex.mae),
        gross: r5(gross), fees: r5(fees), net: r5(net), R: risk$ > 0 ? r3(net / risk$) : null
      };
      append(path.join(DATA, 'trades.jsonl'), JSON.stringify(closeEv));
      bk.cash += net;
      bk.daily[ymd(exitMs)] = (bk.daily[ymd(exitMs)] || 0) + net;
      if (net < 0) bk.dailyLoss[ymd(exitMs)] = (bk.dailyLoss[ymd(exitMs)] || 0) + 1;
      bk.open.splice(i, 1);
      closedN++;
      log(`closed #${pos.id} [${nm}] ${pos.sym} ${pos.side > 0 ? 'LONG' : 'SHORT'} ${ex.reason} net ${net.toFixed(4)}$`);
      if (TELE()) { try { await tele(`paper bot [${nm}]: closed #${pos.id} ${pos.sym} ${pos.side > 0 ? 'LONG' : 'SHORT'} ${ex.reason} net ${net.toFixed(3)}$`); } catch (e) {} }
    }
  }

  // ---------- 2. new entries at this candle (shared filter, then every lane takes it) ----------
  let takenN = 0, skipN = 0;
  const skips = [];
  if (fresh) {
    const W = cfg.W, leanMin = cfg.leanMinPts / 100;
    const todayKey = ymd(Date.now());
    const capOn = (cfg.maxLossesPerDay || 0) > 0;
    for (const r of sc.rows.slice().sort((a, b) => b.p.any[W] - a.p.any[W])) {
      if (!uniMap.has(r.sym)) continue;
      const pAny = r.p.any[W], lean = r.dir[W];
      const flagged = pAny >= cfg.minChance;
      if (!flagged) continue;                                    // only top-band candidates are considered at all
      const leanOk = lean != null && Math.abs(lean - 0.5) >= leanMin;
      const side = lean == null ? 0 : (lean > 0.5 ? 1 : -1);
      const r1 = r.dx5 ? r.dx5[2] : NaN;                          // last candle's return (fraction) to fade or confirm
      let reason = null;
      if (!leanOk) reason = lean == null ? 'no lean (signals conflict)' : 'lean below ' + cfg.leanMinPts + 'pts';
      else if (cfg.entryFilter === 'counter' && !(side * r1 < 0)) reason = 'counter filter: last candle moved WITH the lean (need it against)';
      else if (cfg.entryFilter === 'momentum' && !(side * r1 > 0)) reason = 'momentum filter: last candle moved AGAINST the lean';
      else if (side < 0 && !cfg.allowShort) reason = 'short (simulated) disabled';
      if (reason) { skips.push({ t: tOpen, s: r.sym, pa: r4(pAny), dl: lean == null ? null : r4(lean), r1: r4(r1), why: reason }); skipN++; continue; }

      // passed the shared filter -> every lane with capacity takes the SAME entry
      const laneSkip = [];
      for (const d of defs) {
        const bk = st.lanes[d.name];
        const lossesToday = bk.dailyLoss[todayKey] || 0;
        if (capOn && lossesToday >= cfg.maxLossesPerDay) laneSkip.push(d.name + ': loss cap ' + lossesToday + '/' + cfg.maxLossesPerDay);
        else if (bk.open.length >= cfg.maxOpen) laneSkip.push(d.name + ': max ' + cfg.maxOpen + ' open');
        else if (bk.open.find(p => p.sym === r.sym)) laneSkip.push(d.name + ': already in a position');
        else {
          const tps = laneTpSl(cfg, d, r, side, W);
          if (!tps) { laneSkip.push(d.name + ': bad TP/SL'); continue; }
          const entry = r.price;                                 // close of the signal candle
          const pos = {
            id: st.nextId++, lane: d.name, sym: r.sym, side, tf: cfg.tf, W,
            tEntry: tOpen, entryMs: sc.lastCloseMs, entry: r6(entry),
            tp: r6(side > 0 ? entry * (1 + tps.tpPct / 100) : entry * (1 - tps.tpPct / 100)),
            sl: r6(side > 0 ? entry * (1 - tps.slPct / 100) : entry * (1 + tps.slPct / 100)),
            tpPct: r4(tps.tpPct), slPct: r4(tps.slPct), tpMode: d.solo ? cfg.tpMode : 'fixed',
            notional: cfg.notionalPerTrade, feeBps: cfg.feeBpsPerSide,
            lean: r4(lean), r1: r4(r1), pAny: r4(pAny), pRise: r4(r.p.rise[W]), pFall: r4(r.p.fall[W]),
            u6: r4(r.thr[6].up), d6: r4(r.thr[6].dn), dvd: Math.round(r.dvd),
            f: r.vec.map(r5), dx: r.dx5.map(r5)
          };
          bk.open.push(pos);
          append(path.join(DATA, 'trades.jsonl'), JSON.stringify({ ev: 'open', lane: d.name, id: pos.id, t: tOpen, pos }));
          takenN++;
          log(`opened #${pos.id} [${d.name}] ${r.sym} ${side > 0 ? 'LONG' : 'SHORT'} entry ${entry} tp ${pos.tp} sl ${pos.sl} lean ${lean.toFixed(2)}`);
          if (TELE()) { try { await tele(`paper bot [${d.name}]: opened #${pos.id} ${r.sym} ${side > 0 ? 'LONG' : 'SHORT'} entry ${entry} TP ${pos.tp} SL ${pos.sl}`); } catch (e) {} }
        }
      }
      if (laneSkip.length) {
        const tookAll = defs.length - laneSkip.length;
        skips.push({ t: tOpen, s: r.sym, pa: r4(pAny), dl: r4(lean), r1: r4(r1), why: tookAll ? null : 'no lane had capacity: ' + laneSkip.join('; '), tk: tookAll + '/' + defs.length, ls: laneSkip.join('; ') });
        if (!tookAll) skipN++;
      }
    }
    if (skips.length) append(path.join(DATA, 'skips-' + ymd(tOpen) + '.jsonl'), skips.map(s => JSON.stringify(s)).join('\n') + '\n');
    st.lastCandleMs = sc.lastCloseMs;
  }

  // ---------- 3. equity mark per book ----------
  const dkey = ymd(Date.now());
  for (const nm of Object.keys(st.lanes)) {
    const bk = st.lanes[nm];
    let unreal = 0;
    for (const pos of bk.open) {
      const rows = map.get(pos.sym);
      const g = rows && C.buildGrid(rows, C.TF[pos.tf].mins * 60000);
      const last = g ? g.c[g.n - 1] : pos.entry;
      pos.last = r6(last);
      unreal += pos.side * (last / pos.entry - 1) * pos.notional;
    }
    bk.unreal = unreal;
    const eq = bk.cash + unreal;
    if (!bk.marks.length || bk.marks[bk.marks.length - 1].d !== dkey) bk.marks.push({ d: dkey, eq: Math.round(eq * 1000) / 1000 });
    else bk.marks[bk.marks.length - 1].eq = Math.round(eq * 1000) / 1000;
    if (bk.marks.length > 400) bk.marks = bk.marks.slice(-400);
    const dkeys = Object.keys(bk.daily);
    if (dkeys.length > 120) dkeys.sort().slice(0, dkeys.length - 120).forEach(k => delete bk.daily[k]);
  }

  // ---------- 4. retention ----------
  const cutoff = ymd(Date.now() - (cfg.retentionDays || 120) * DAY);
  try {
    for (const f of fs.readdirSync(DATA)) {
      if (/^skips-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(6, 16) < cutoff) fs.unlinkSync(path.join(DATA, f));
    }
  } catch (e) {}

  // ---------- 5. state ----------
  let storageBytes = 0, files = [];
  try { for (const f of fs.readdirSync(DATA)) { const b = fs.statSync(path.join(DATA, f)).size; storageBytes += b; if (f.endsWith('.jsonl')) files.push({ f, b }); } } catch (e) {}
  files.sort((a, b) => b.b - a.b);
  const { laneStats, legacyStats, totals } = computeStats(cfg);
  const closedTail = tailCloses(300);
  const lanesOut = {};
  for (const nm of Object.keys(st.lanes)) {
    const bk = st.lanes[nm];
    let peak = cfg.startEquity, maxDD = 0;
    for (const m of bk.marks.concat([{ d: dkey, eq: bk.cash + (bk.unreal || 0) }])) { if (m.eq > peak) peak = m.eq; maxDD = Math.min(maxDD, m.eq / peak - 1); }
    lanesOut[nm] = {
      cash: r3(bk.cash), equity: r3(bk.cash + (bk.unreal || 0)), unreal: r3(bk.unreal || 0),
      open: bk.open.map(p => ({ ...p })), marks: bk.marks, daily: bk.daily, dailyLoss: bk.dailyLoss,
      maxDD: r3(maxDD), stats: laneStats[nm] || emptyStats(), closedTail: closedTail[nm] || []
    };
  }
  const newState = {
    v: 2, updatedMs: Date.now(), startMs: cfg.startMs, runMs: Date.now() - t0,
    cfg: {
      startEquity: cfg.startEquity, notionalPerTrade: cfg.notionalPerTrade, maxOpen: cfg.maxOpen,
      tf: cfg.tf, W: cfg.W, leanMinPts: cfg.leanMinPts, minChance: cfg.minChance,
      tpMode: cfg.tpMode, tpPct: cfg.tpPct, slPct: cfg.slPct, feeBpsPerSide: cfg.feeBpsPerSide,
      entryFilter: cfg.entryFilter || 'any', maxLossesPerDay: cfg.maxLossesPerDay || 0,
      topN: cfg.topN, allowShort: cfg.allowShort,
      lanes: defs.map(d => d.solo ? { name: 'solo', tpPct: cfg.tpPct, slPct: cfg.slPct, tpMode: cfg.tpMode } : { name: d.name, tpPct: d.tpPct, slPct: d.slPct })
    },
    universe: uniSyms.length, errs: Object.keys(errs).length, lastCandleMs: sc.lastCloseMs, nextId: st.nextId,
    lanes: lanesOut, totals, legacy: legacyStats.n ? legacyStats : null,
    storageBytes, files: files.slice(0, 60),
    signal: sc.rows.slice().sort((a, b) => b.p.any[cfg.W] - a.p.any[cfg.W]).slice(0, 12).map(r => ({ s: r.sym, pa: r4(r.p.any[cfg.W]), dl: r.dir[cfg.W] == null ? null : r4(r.dir[cfg.W]), fl: !!r.flagW[cfg.W], u6: r4(r.thr[6].up), d6: r4(r.thr[6].dn), r1: r4(r.dx5 ? r.dx5[2] : NaN) }))
  };
  writeJSON(statePath, newState);
  const laneSum = Object.keys(st.lanes).map(nm => nm + ' ' + lanesOut[nm].equity.toFixed(3) + '$/' + st.lanes[nm].open.length + ' open').join(', ');
  log(`lanes: ${laneSum}; +${takenN} taken, +${closedN} closed, ${skipN} candidates skipped, state written`);
}

/* Aggregate stats over the whole trades.jsonl, grouped by lane (recomputed each run: idempotent). */
function emptyStats() {
  return { n: 0, wins: 0, losses: 0, timeouts: 0, gross: 0, fees: 0, net: 0, longN: 0, shortN: 0, longNet: 0, shortNet: 0, sumWin: 0, sumLoss: 0, consecMax: 0, sumMfe: 0, sumMae: 0, nMfe: 0,
    avgWin: null, avgLoss: null, winRate: null, expectancy: null, expectancyBps: null, avgMfe: null, avgMae: null };
}
function statsOf(closes, notional) {
  const st = emptyStats();
  let consec = 0;
  for (const c of closes) {
    const win = c.reason === 'win' || c.reason === 'intrabar_win';
    st.gross += c.gross || 0; st.fees += c.fees || 0; st.net += c.net || 0;
    if (c.side > 0) { st.longN++; st.longNet += c.net || 0; } else { st.shortN++; st.shortNet += c.net || 0; }
    if (win) { st.wins++; st.sumWin += c.net || 0; consec = 0; } else { st.losses++; st.sumLoss += c.net || 0; consec++; st.consecMax = Math.max(st.consecMax, consec); }
    if (c.reason === 'timeout') st.timeouts++;
    if (Number.isFinite(c.mfe)) { st.sumMfe += c.mfe; st.sumMae += c.mae; st.nMfe++; }
  }
  st.n = closes.length;
  st.avgWin = st.wins ? st.sumWin / st.wins : null;
  st.avgLoss = st.losses ? st.sumLoss / st.losses : null;
  st.winRate = st.n ? st.wins / st.n : null;
  st.expectancy = st.n ? st.net / st.n : null;                   // $ per trade after fees
  st.expectancyBps = st.n ? st.net / st.n / notional * 1e4 : null;
  st.avgMfe = st.nMfe ? st.sumMfe / st.nMfe : null;
  st.avgMae = st.nMfe ? st.sumMae / st.nMfe : null;
  for (const k of ['gross', 'fees', 'net', 'longNet', 'shortNet', 'sumWin', 'sumLoss']) st[k] = r3(st[k]);
  for (const k of ['avgWin', 'avgLoss', 'expectancy', 'avgMfe', 'avgMae']) if (st[k] != null) st[k] = r5(st[k]);
  if (st.winRate != null) st.winRate = r4(st.winRate);
  if (st.expectancyBps != null) st.expectancyBps = r3(st.expectancyBps);
  return st;
}
function computeStats(cfg) {
  const f = path.join(DATA, 'trades.jsonl');
  const byLane = new Map(), legacy = [], all = [];
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
      if (ev.ev !== 'close') continue;
      if (ev.lane) { if (!byLane.has(ev.lane)) byLane.set(ev.lane, []); byLane.get(ev.lane).push(ev); all.push(ev); }
      else legacy.push(ev);                                     // pre-lane (v1) closes: shown separately, not part of the race
    }
  }
  const laneStats = {};
  for (const [nm, arr] of byLane) laneStats[nm] = statsOf(arr, cfg.notionalPerTrade);
  const totals = statsOf(all, cfg.notionalPerTrade);
  const legacyStats = legacy.length ? { n: legacy.length, net: r3(legacy.reduce((a, c) => a + (c.net || 0), 0)) } : { n: 0, net: 0 };
  return { laneStats, legacyStats, totals };
}

/* Last N closed trades per lane, walking the log backwards. */
function tailCloses(N) {
  const out = {};
  const f = path.join(DATA, 'trades.jsonl');
  if (!fs.existsSync(f)) return out;
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev; try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
    if (ev.ev !== 'close' || !ev.lane) continue;
    if (!out[ev.lane]) out[ev.lane] = [];
    if (out[ev.lane].length < N) out[ev.lane].push(ev);
  }
  return out;
}

/* optional Telegram (set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID as repo secrets) */
function TELE() { return !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID; }
async function tele(text) {
  await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text })
  });
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });

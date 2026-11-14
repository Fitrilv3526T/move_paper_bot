# Move Paper Bot — the lane race (3 exit geometries, paper traded)

Runs by itself on GitHub every 15 minutes. No server, no API keys, no browser needed, nothing to press.
It watches the market with the same stress-tested engine as the scanner, takes **one shared signal
stream**, and paper-trades it **three ways at once** — three parallel "lanes" that enter at the exact
same moment and price, and only differ in how they exit. After a few months the live data tells us
which exit geometry actually survives fees. That is the whole point: stop guessing, race them.

| Lane | Geometry | What it is | What history says (2025–2026 out-of-sample, same filter, n=1,222) |
| --- | --- | --- | --- |
| **scalp** | TP 0.10% / SL 0.75% | the 95%-win-rate profile | **95.25%** WR, worst streak 2 losses, +6.0 bps gross → **−4.0 bps** after futures-taker fees, +1.7 bps maker |
| **balanced** | TP 0.30% / SL 1.50% | the old default | **89.7%** WR, +12.1 bps gross → **+2.1 bps** after taker fees, +7.5 bps maker |
| **runner** | TP 3.00% / SL 4.00% | the fee-surviving candidate | 47.6% WR, worst streak 10, +28.9 bps gross → **+18.9 bps** after taker fees, +22.5 bps maker |

- Entry is shared and strict: chance of an event-size move ≥ 0.53 within 6 candles (the offline
  top-5% band), direction lean ≥ 10 points, and the last candle having moved **against** the lean
  ("counter" entry — the best filter found). Expect **~2–3 trades per day per lane**; quiet days with
  zero trades are normal.
- Each lane is an **independent $20 paper book** (own cash, stats, equity curve, daily loss cap of 3
  losing closes). Think of it as three accounts racing, not one account split three ways.
- **Both directions**: long when the lean is up, short when it is down (most leans at 1h are down —
  shorts are the bread and butter of this system). Shorts are simulated on spot prices; live they map
  to USDT-M perpetuals of the same coin.
- Fees: **5 bps per side = 10 bps round-trip**, the real USDT-M futures taker rate (VIP0). This now
  matches the "futures taker" column of the table above. Set `feeBpsPerSide` to 10 for spot-taker
  accounting, ~2 for maker-style.

**Read "Rules & the honest math" on the page before getting excited.** Win rate is not profit: the
scalp lane wins 20 of 21 trades and still bleeds ~4 bps per trade, while the runner lane loses more
than half its trades and is the only one that clears fees in the backtest. The race exists precisely
to see if that ordering survives live data. It never places real orders.

## Set up (about 5 minutes, once)

1. On github.com click **New repository**. Name it e.g. `move-paper-bot`, choose **Public**, click Create.
   (Public matters: scheduled jobs are free and unlimited on public repos.)
2. Click **uploading an existing file** and drag in everything from this folder
   (`.github`, `docs`, `scanner`, `config.json`, `README.md`), then **Commit changes**.
   - If the hidden `.github` folder does not upload: click **Add file > Create new file**, type
     `.github/workflows/scan.yml` as the name and paste the content of that file from this folder.
3. **Settings > Pages**: Source = *Deploy from a branch*, Branch = `main`, folder = `/docs`, Save.
4. **Actions** tab: if GitHub asks, click *I understand my workflows, enable them*. Open
   **Paper bot** and click **Run workflow** once.
5. Open your Pages address. Bookmark it. Every lane updates itself at each 1h candle close.

Already running the older single-strategy version? Push these files over it and run the workflow
once: the old account is archived to `docs/data/state-v1-archived.json` and the lane race starts
fresh (the old `trades.jsonl` history is kept for the next retraining round, just not counted in
the race).

## The rules (mirroring the grid search exactly)

- Universe: top 40 USDT pairs by volume. At every closed **1h** candle, each coin is scored.
- Entry (shared by all lanes): chance(any event-size move in 6 candles) ≥ **0.53** AND direction
  lean ≥ **10 pts** AND the last candle moved **against** the lean. Every lane then enters at that
  candle's close, in the lean direction, $5 fixed notional, max 4 concurrent per lane, one position
  per coin per lane.
- Exits (the only difference between lanes): first-touch TP/SL with the open-proximity tie-break
  when one candle touches both (same convention as the backtest); time exit at candle 6.
- Daily loss cap per lane: `maxLossesPerDay` (default 3; 0 disables).

## Settings (config.json, editable on GitHub — applies to new trades)

`lanes` is the horse race: an array of `{"name", "tpPct", "slPct"}` — add, remove or rename lanes
freely; a new lane gets a fresh $20 book, a removed lane keeps its history on the page but takes no
new entries. Set `"lanes": []` for a single legacy book using `tpPct`/`slPct`/`tpMode`.

Other knobs: `startEquity` 20 (per book) · `notionalPerTrade` 5 · `maxOpen` 4 (per lane) ·
`tf` 1h · `W` 6 · `leanMinPts` 10 · `entryFilter` counter | momentum | any · `maxLossesPerDay` 3 ·
`minChance` 0.53 · `feeBpsPerSide` 5 (5 = USDT-M futures taker / 10 bps RT, 10 = spot taker,
~2 = maker) · `allowShort` true · `topN` 40 · `retentionDays` 120.

To restart all books from today: delete the `startMs` line from `config.json` and the files in
`docs/data/` (keep the folder).

## What it logs (the improvement data)

- `docs/data/trades.jsonl` — every open and close event **with its lane name** and the full signal
  context: the 11 magnitude features, 5 direction inputs, all probabilities, the lean, the last
  candle's return (the counter filter input), event sizes, entry/exit, reason, fees, net, **MFE/MAE**
  and the R multiple. Same entry logged once per lane.
- `docs/data/skips-<date>.jsonl` — every candidate the entry filter rejected and why (plus which
  lanes had no capacity).
- `docs/data/state.json` — the books the page shows.

Bring the whole repo back (Code → Download ZIP) after 3+ weeks. The MFE/MAE distribution per lane is
what tells us which TP/SL geometry could actually clear fees live; the lean-vs-outcome pairs tell us
whether the direction model holds up.

## How to read the race

- Judge **net expectancy per trade after fees**, never win rate. Scalp will show a beautiful win rate
  forever and still lose money; that is the classic scalper trap and the table above says so.
- **500 closed trades per lane (~3+ months)** before believing any number. Until then every
  difference between lanes is noise.
- The key question: does the runner lane's live expectancy land near its backtest +18.9 ± 8.7 bps?
  Near zero → the grid-search edge was overfit. Near +10 → we have something.
- When one lane clearly wins: keep it, remove the others from `lanes`, and only then think about
  real money — maker orders, USDT-M futures for the shorts, 3 months of matching paper results first.

## Things to know

- Fills are at exact candle prices — optimistic vs real slippage. Real $5 orders also sit at or below
  Binance's minimum order size on many pairs; fine at paper stage, not at live.
- GitHub pauses scheduled jobs after 60 days with no human activity. If the page says data is old,
  open the Actions tab and re-enable the workflow.

Optional Telegram alerts for opened/closed trades (with lane name): create a bot with @BotFather,
get your chat id, add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as repository secrets.

Paper trading only. No orders, no API keys. Backtested numbers are not a promise of future results.
This is not financial advice.

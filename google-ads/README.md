# Top IS Bid Controller (Google Ads Script)

An hourly Google Ads Script that, per keyword, searches for and holds the
**lowest tested max CPC bid whose Search top impression share meets a target**
(default 85%).

It does **not** identify the last top-of-page slot. Google exposes no metric for
that. "Lowest tested bid that keeps Top IS on target" is the measurable proxy
this design was built around (agreed in a Claude / Codex design review).

Scope: enabled Search campaigns on **Manual CPC**. Expect convergence to take
**several weeks**: every formal test needs seven complete days of data.

## How it decides

**Slow loop (the search)**, using complete days with mature data:

| Result over a test window | Rule (defaults) | Action |
|---|---|---|
| Pass | 7 full days, ≥ 500 Search impressions, Top IS ≥ T + 2 pts | Candidate becomes **H** (last passing bid); test lower |
| Clear fail | ≥ 3 days, ≥ 500 impressions, Top IS ≤ T − 5 pts | Candidate becomes **L** (failing bound); go back toward H |
| Inconclusive timeout | 7 days without a pass or clear fail (incl. thin data) | Restore H, **leave L unchanged**, block that bracket |

- Next bid to test: H × 0.90 until an L is known, then the geometric midpoint √(L·H).
  Stops when H / L ≤ 1.03.
- Top IS is queried for the whole window, never averaged from daily values.
- When a bid is confirmed failing and no valid H exists, the bid is raised 10%,
  unless the campaign is losing top IS to budget (flagged `BUDGET_LIMITED`) or
  the bid is already at `MAX_BID`.
- While holding H, rolling 7-day windows keep revalidating it. One clear fail,
  or Top IS < T in two separate windows, invalidates H.
- After 28 days holding, the search reopens. Old results stay as hints: it
  retests the blocked midpoint, or L itself if the bracket had converged.

**Fast loop (hourly, restore-only).** While a lower bid is under test, it
compares Top % in the last two non-overlapping 6-hour windows of completed hours
(3-hour reporting lag) with the same weekday and hours recorded while H was
validated. If both windows dropped ≥ 15 points with ≥ 30 impressions each, it
restores H once and marks the test inconclusive. It then blocks further cuts
until H passes a full window again. It never raises above H. Missing baseline
data disables it.

**Comparability.** Windows are void (bid restored or window restarted, no
H or L update) when:
- device, schedule, location or language targeting, or ad-group bid adjustments
  change (detected automatically), or
- the window overlaps a date listed in the `ExcludedDates` tab (holidays,
  promotions, outages).

A bid changed by anyone else restarts that keyword from scratch.

## Setup

1. Create an empty Google Sheet and copy its URL.
2. In Google Ads: **Tools → Bulk actions → Scripts → +**. Paste
   `top-is-bid-controller.js`, set `SPREADSHEET_URL`, and authorize.
3. Keep `DRY_RUN: true` for the first runs. A dry run writes the `Log` and a
   `State (dry run)` tab and changes no bids. Dry runs don't carry state
   forward, so each one is a one-shot preview. If you know current bids have
   been stable, set `ASSUME_BID_UNCHANGED_DAYS: 7` to see real decisions.
4. Optionally list non-comparable dates in `ExcludedDates` (`start | end | reason`).
5. Set `DRY_RUN: false` and schedule the script **hourly**.

To stop automation for a keyword, change its bid by hand. The script then
restarts it from a fresh baseline. To exclude a keyword permanently, use the
campaign-name filter or move it to another bid strategy.

## Sheet tabs

- **State**: one row per keyword: `state` (BASELINE / TESTING / HOLD), `status`,
  `flag`, `bid`, `h`, `l`, window dates and the last measured Top IS.
- **Log**: one row per decision or status change.
- **ExcludedDates**: your list of non-comparable dates.

Flags worth reviewing: `INSUFFICIENT_DATA` (bid untouched), `NO_VALID_H`
(current bid neither passes nor clearly fails, so no cuts), `BUDGET_LIMITED`,
`AT_MAX_BID`.

## Parameters

Every threshold in `CONFIG` is an **untested pilot value**, not a validated
constant. The main ones: `TARGET_TOP_IS`, `PASS_MARGIN`, `CLEAR_FAIL_MARGIN`,
`TEST_DAYS`, `MIN_TEST_IMPRESSIONS`, `EXPLORE_CUT`, `BRACKET_STOP_RATIO`,
`MIN_BID` / `MAX_BID`, `REOPEN_AFTER_DAYS`, and the `FAST_*` settings.

## Known limitations and unverified points

- Not yet run against a live account. The GAQL queries follow the documented
  fields, but these specific combinations are unconfirmed and should be checked
  in the first dry run's log:
  - `segments.hour` with `metrics.top_impression_percentage` on `keyword_view`
    (fast loop; a failure disables it for that run),
  - the `campaign_criterion` / `ad_group_bid_modifier` queries (change detection;
    a failure disables it for that run).
- A natural shift in device mix can still cause false fast-loop alarms.
- Device weighting is omitted in v1.
- Keywords below the impression minimum are never automated. There is no
  ad-group pooling in v1, by design.
- New keywords wait one full window before any change.

## Tests

The decision logic is pure JavaScript and tested in Node (≥ 18), including an
end-to-end simulation against a synthetic auction:

```
node --test google-ads/test/*.test.js
```

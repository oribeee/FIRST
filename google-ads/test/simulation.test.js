// End-to-end simulation of the slow loop against a synthetic auction.
// Run: node --test google-ads/test/*.test.js   (set SIM_VERBOSE=1 to print the trace)
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../top-is-bid-controller.js');

const cfg = Object.assign({}, C.CONFIG);

function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

// True Top IS as a function of bid: logistic around `mid`.
function trueTopIs(bid, mid) { return 1 / (1 + Math.exp(-(bid - mid) / 0.15)); }
// Lowest bid whose true Top IS reaches x.
function bidFor(x, mid) { return mid + 0.15 * Math.log(x / (1 - x)); }

function simulate({ days, startBid, midByDay, seed, eligiblePerDay }) {
  const rand = rng(seed);
  const start = '2026-01-01';
  const daily = {};          // date -> {bid, top, eligible, imp}
  let accountBid = startBid;
  let st = null;
  const trace = [];
  for (let d = 0; d < days; d++) {
    const today = C.addDays(start, d);
    const ctx = { today, hour: 8, excluded: [] };
    const k = { key: '1:2', campaignId: '9', adGroupId: '1', criterionId: '2', campaign: 'c',
      adGroup: 'a', keyword: 'k', matchType: 'EXACT', bid: accountBid, topOfPageCpc: null };
    if (!st) st = C.newKeywordState(k, ctx, cfg, 'fp');
    const w = C.evaluationWindow(st, ctx, cfg);
    let metrics = null;
    if (w) {
      let top = 0, elig = 0, imp = 0;
      for (let x = C.dayNum(w.start); x <= C.dayNum(w.end); x++) {
        const r = daily[C.fromDayNum(x)];
        if (r) { top += r.top; elig += r.eligible; imp += r.imp; }
      }
      metrics = { impressions: imp, topIs: elig ? top / elig : null };
    }
    const r = C.decide(st, { currentBid: accountBid, fp: 'fp', window: w, metrics, budgetLost: 0, fast: null }, ctx, cfg);
    if (r.newBid != null) accountBid = r.newBid;
    st = r.st;
    if (r.events.length) trace.push(today + ' ' + r.events.join('; ') + ' -> bid ' + accountBid.toFixed(2));
    // The day's traffic at the bid now in effect (the change day is never inside a window).
    const mid = midByDay(d);
    const eligible = eligiblePerDay;
    const p = Math.min(1, Math.max(0, trueTopIs(accountBid, mid) + (rand() - 0.5) * 0.06));
    daily[today] = { bid: accountBid, eligible, top: eligible * p, imp: eligible * p + 40 };
  }
  return { st, accountBid, trace };
}

test('converges to a bid that meets the target, not far above the true threshold', () => {
  const mid = 2.0;
  const { st, accountBid, trace } = simulate({ days: 200, startBid: 3.0, midByDay: () => mid, seed: 7, eligiblePerDay: 150 });
  if (process.env.SIM_VERBOSE) console.log(trace.join('\n'));
  const passLine = bidFor(cfg.TARGET_TOP_IS + cfg.PASS_MARGIN, mid);   // ~2.28
  const failLine = bidFor(cfg.TARGET_TOP_IS - cfg.CLEAR_FAIL_MARGIN, mid); // ~2.21
  assert.ok(st.h != null, 'has a validated H');
  assert.ok(accountBid >= failLine, 'final bid ' + accountBid + ' below the clear-fail line ' + failLine.toFixed(2));
  assert.ok(accountBid <= passLine * 1.10, 'final bid ' + accountBid + ' far above the pass line ' + passLine.toFixed(2));
});

test('adapts when competition rises: H fails, the bid is raised, then re-converges', () => {
  const { st, accountBid, trace } = simulate({
    days: 260, startBid: 3.0, seed: 11, eligiblePerDay: 150,
    midByDay: d => (d < 120 ? 2.0 : 2.4)
  });
  if (process.env.SIM_VERBOSE) console.log(trace.join('\n'));
  assert.ok(trace.some(t => /CLEAR_FAIL_RAISED|PERSISTENT_FAIL_RAISED/.test(t)), 'raised after the shift');
  const failLine = bidFor(cfg.TARGET_TOP_IS - cfg.CLEAR_FAIL_MARGIN, 2.4);
  assert.ok(accountBid >= failLine, 'final bid ' + accountBid + ' below new clear-fail line ' + failLine.toFixed(2));
  assert.ok(st.h != null);
});

test('a sparse keyword is never changed', () => {
  const { accountBid, st } = simulate({ days: 60, startBid: 3.0, midByDay: () => 2.0, seed: 3, eligiblePerDay: 20 });
  assert.equal(accountBid, 3.0);
  assert.equal(st.flag, 'INSUFFICIENT_DATA');
});

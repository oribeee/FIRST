// Run: node --test google-ads/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../top-is-bid-controller.js');

const cfg = Object.assign({}, C.CONFIG);
const FP = 'fp1';

function kw(bid) {
  return { key: '1:2', campaignId: '9', adGroupId: '1', criterionId: '2', campaign: 'c', adGroup: 'a',
    keyword: 'k', matchType: 'EXACT', bid: bid, topOfPageCpc: null };
}
function ctx(today, hour, excluded) { return { today, hour: hour == null ? 8 : hour, excluded: excluded || [] }; }
function win(start, days) { return { start, end: C.addDays(start, days - 1), days }; }
function ev(st, extra) {
  return Object.assign({ currentBid: st.bid, fp: FP, window: null, metrics: null, budgetLost: 0, fast: null }, extra);
}
// A keyword holding a recently validated H, ready to cut.
function holding(h, l, today) {
  const st = C.newKeywordState(kw(h), ctx(today), cfg, FP);
  return Object.assign(st, { state: 'HOLD', h, l: l == null ? null : l, hStart: C.addDays(today, -9),
    hEnd: C.addDays(today, -3), hFp: FP, holdSince: today, windowStart: C.addDays(today, -2) });
}
function testing(h, l, cand, cutDay) {
  const st = holding(h, l, cutDay);
  return Object.assign(st, { state: 'TESTING', bid: cand, changeDate: cutDay, changeHour: 8,
    windowStart: C.addDays(cutDay, 1) });
}

test('classify bands: middle band is never a pass', () => {
  const full = win('2026-10-01', 7);
  const m = (topIs, impressions) => ({ topIs, impressions: impressions == null ? 1000 : impressions });
  assert.equal(C.classify(full, m(0.87), cfg), 'PASS');
  assert.equal(C.classify(full, m(0.869), cfg), 'INCONCLUSIVE');
  assert.equal(C.classify(full, m(0.85), cfg), 'INCONCLUSIVE');
  assert.equal(C.classify(full, m(0.84), cfg), 'BELOW_TARGET');
  assert.equal(C.classify(full, m(0.80), cfg), 'CLEAR_FAIL');
  assert.equal(C.classify(full, m(0.95, 499), cfg), 'INSUFFICIENT_DATA');
  assert.equal(C.classify(win('2026-10-01', 3), m(0.79), cfg), 'CLEAR_FAIL');   // early clear fail
  assert.equal(C.classify(win('2026-10-01', 2), m(0.79), cfg), 'WAIT');
  assert.equal(C.classify(win('2026-10-01', 6), m(0.95), cfg), 'WAIT');         // no early pass
});

test('nextCandidate: exploration cut, geometric midpoint, convergence', () => {
  assert.equal(C.nextCandidate({ h: 2.0, l: null }, cfg), 1.8);
  assert.equal(C.nextCandidate({ h: 2.0, l: 1.5 }, cfg), 1.73);
  assert.equal(C.nextCandidate({ h: 2.0, l: 1.95 }, cfg), null);                 // H/L <= 1.03
  assert.equal(C.nextCandidate({ h: 0.10, l: null }, cfg), null);                // at MIN_BID
});

test('maturity: data is used one day late, and not before the earliest hour', () => {
  assert.equal(C.lastMatureDay(ctx('2026-10-14', 8), cfg), '2026-10-12');
  assert.equal(C.lastMatureDay(ctx('2026-10-14', 3), cfg), '2026-10-11');
});

test('inconclusive timeout restores H, leaves L unchanged and blocks the bracket', () => {
  let st = testing(2.0, 1.5, 1.73, '2026-10-01');
  const day = '2026-10-10';
  const w = C.evaluationWindow(st, ctx(day), cfg);
  assert.deepEqual(w, win('2026-10-02', 7));
  let r = C.decide(st, ev(st, { window: w, metrics: { impressions: 900, topIs: 0.84 } }), ctx(day), cfg);
  assert.equal(r.st.status, 'INCONCLUSIVE_TIMEOUT');
  assert.equal(r.newBid, 2.0);
  assert.equal(r.st.l, 1.5, 'L must not move on a timeout');
  assert.equal(r.st.state, 'HOLD');

  // Next day: no new evidence, so the same bracket is not retested.
  st = r.st;
  r = C.decide(st, ev(st), ctx('2026-10-11'), cfg);
  assert.equal(r.newBid, null);
  assert.equal(r.st.status, 'HOLD:BRACKET_BLOCKED');

  // After REOPEN_AFTER_DAYS (with H still fresh) the blocked bracket is retested; L is kept.
  st = Object.assign(r.st, { hEnd: '2026-11-05' });
  r = C.decide(st, ev(st), ctx('2026-11-08'), cfg);
  assert.ok(r.events[0].startsWith('REOPEN'));
  assert.equal(r.newBid, 1.73);
  assert.equal(r.st.l, 1.5);
});

test('reopen after convergence re-checks L itself; if L passes, the search continues below', () => {
  let st = holding(2.0, 1.95, '2026-10-01');                 // converged: H/L <= 1.03
  st.hEnd = '2026-11-05';
  let r = C.decide(st, ev(st), ctx('2026-11-08'), cfg);
  assert.equal(r.newBid, 1.95);
  st = r.st;
  const w = C.evaluationWindow(st, ctx('2026-11-17'), cfg);
  r = C.decide(st, ev(st, { window: w, metrics: { impressions: 900, topIs: 0.9 } }), ctx('2026-11-17'), cfg);
  assert.equal(r.st.h, 1.95);
  assert.equal(r.st.l, null);
  assert.equal(r.newBid, 1.76);                               // exploration cut below the new H
});

test('timeout with too few impressions is also inconclusive, not a fail', () => {
  const st = testing(2.0, null, 1.8, '2026-10-01');
  const w = C.evaluationWindow(st, ctx('2026-10-10'), cfg);
  const r = C.decide(st, ev(st, { window: w, metrics: { impressions: 100, topIs: 0.5 } }), ctx('2026-10-10'), cfg);
  assert.equal(r.st.status, 'INCONCLUSIVE_TIMEOUT');
  assert.equal(r.st.l, null);
  assert.equal(r.newBid, 2.0);
});

test('clear fail sets L and moves straight to the next midpoint', () => {
  const st = testing(2.0, null, 1.8, '2026-10-01');
  const day = '2026-10-06';                                   // 3 mature days (10-02..10-04)
  const w = C.evaluationWindow(st, ctx(day), cfg);
  assert.equal(w.days, 3);
  const r = C.decide(st, ev(st, { window: w, metrics: { impressions: 600, topIs: 0.70 } }), ctx(day), cfg);
  assert.deepEqual(r.events.map(e => e.split(' ')[0]), ['CLEAR_FAIL', 'CUT']);
  assert.equal(r.st.l, 1.8);
  assert.equal(r.newBid, 1.9);                                // sqrt(1.8 * 2.0)
  assert.equal(r.st.state, 'TESTING');
});

test('pass makes the candidate the new H and continues the search', () => {
  const st = testing(2.0, null, 1.8, '2026-10-01');
  const w = C.evaluationWindow(st, ctx('2026-10-10'), cfg);
  const r = C.decide(st, ev(st, { window: w, metrics: { impressions: 900, topIs: 0.91 } }), ctx('2026-10-10'), cfg);
  assert.equal(r.st.h, 1.8);
  assert.equal(r.st.hEnd, '2026-10-08');
  assert.equal(r.newBid, 1.62);
});

test('fast trigger restores H once, blocks cuts until H passes; a second trigger blocks the bracket', () => {
  let st = testing(2.0, 1.5, 1.73, '2026-10-01');
  let r = C.decide(st, ev(st, { fast: { trigger: true, detail: 'x' } }), ctx('2026-10-02'), cfg);
  assert.equal(r.st.status, 'FAST_RESTORE');
  assert.equal(r.newBid, 2.0);
  assert.equal(r.st.l, 1.5);
  assert.equal(r.st.cutsBlocked, 'yes');

  st = r.st;
  r = C.decide(st, ev(st), ctx('2026-10-03'), cfg);
  assert.equal(r.st.status, 'HOLD:RECOVERY');
  assert.equal(r.newBid, null);

  // H passes a full window again -> recovery done -> one retry of the bracket.
  st = r.st;
  const day = '2026-10-11';
  const w = C.evaluationWindow(st, ctx(day), cfg);
  assert.equal(w.days, 7);
  r = C.decide(st, ev(st, { window: w, metrics: { impressions: 900, topIs: 0.9 } }), ctx(day), cfg);
  assert.equal(r.newBid, 1.73);

  st = r.st;
  r = C.decide(st, ev(st, { fast: { trigger: true, detail: 'x' } }), ctx('2026-10-12'), cfg);
  assert.equal(r.st.blockedH, 2.0);
  assert.equal(r.st.blockedL, 1.5);
});

test('a bid changed outside the script restarts from BASELINE', () => {
  const st = holding(2.0, 1.5, '2026-10-10');
  const r = C.decide(st, ev(st, { currentBid: 2.5 }), ctx('2026-10-10'), cfg);
  assert.equal(r.st.status, 'MANUAL_CHANGE');
  assert.equal(r.st.state, 'BASELINE');
  assert.equal(r.st.h, null);
  assert.equal(r.st.l, null);
  assert.equal(r.newBid, null);
});

test('changed bid adjustments void the test: restore H as a hint and revalidate', () => {
  const st = testing(2.0, 1.5, 1.73, '2026-10-01');
  const r = C.decide(st, ev(st, { fp: 'fp2' }), ctx('2026-10-03'), cfg);
  assert.equal(r.st.status, 'NOT_COMPARABLE');
  assert.equal(r.st.state, 'BASELINE');
  assert.equal(r.newBid, 2.0);
  assert.equal(r.st.h, null);
  assert.equal(r.st.l, 1.5, 'L kept as a hint');
  assert.equal(r.st.fp, 'fp2');
});

test('an unknown fingerprint (query failure) is not treated as a change', () => {
  const st = testing(2.0, 1.5, 1.73, '2026-10-01');
  const r = C.decide(st, ev(st, { fp: 'NA' }), ctx('2026-10-03'), cfg);
  assert.equal(r.st.state, 'TESTING');
  assert.equal(r.st.fp, FP);
});

test('excluded dates in a test window restore H without touching L or blocking', () => {
  const st = testing(2.0, 1.5, 1.73, '2026-10-01');
  const day = '2026-10-10';
  const w = C.evaluationWindow(st, ctx(day), cfg);
  const exc = [{ start: '2026-10-05', end: '2026-10-05' }];
  const r = C.decide(st, ev(st, { window: w, metrics: { impressions: 900, topIs: 0.95 } }), ctx(day, 8, exc), cfg);
  assert.equal(r.st.status, 'NOT_COMPARABLE');
  assert.equal(r.newBid, 2.0);
  assert.equal(r.st.l, 1.5);
  assert.equal(r.st.blockedH, null);
});

test('no cut is started when the planned window hits excluded dates', () => {
  const st = holding(2.0, null, '2026-10-10');
  const exc = [{ start: '2026-10-15', end: '2026-10-16' }];
  const r = C.decide(st, ev(st), ctx('2026-10-10', 8, exc), cfg);
  assert.equal(r.newBid, null);
  assert.equal(r.st.status, 'HOLD:EXCLUDED_DATES_AHEAD');
});

test('baseline clear fail raises the bid and records L; budget limits block the raise once', () => {
  const st = C.newKeywordState(kw(2.0), ctx('2026-10-01'), cfg, FP);
  const day = '2026-10-10';
  const w = C.evaluationWindow(st, ctx(day), cfg);
  let r = C.decide(st, ev(st, { window: w, metrics: { impressions: 900, topIs: 0.6 } }), ctx(day), cfg);
  assert.equal(r.st.status, 'CLEAR_FAIL_RAISED');
  assert.equal(r.newBid, 2.2);
  assert.equal(r.st.l, 2.0);

  r = C.decide(st, ev(st, { window: w, metrics: { impressions: 900, topIs: 0.6 }, budgetLost: 0.2 }), ctx(day), cfg);
  assert.equal(r.st.status, 'BUDGET_LIMITED');
  assert.equal(r.newBid, null);
  assert.equal(r.events.length, 1);
  const again = C.decide(r.st, ev(r.st, { window: w, metrics: { impressions: 900, topIs: 0.6 }, budgetLost: 0.2 }),
    ctx(day, 9), cfg);
  assert.equal(again.events.length, 0, 'repeated budget limit is not re-logged every hour');
});

test('persistent fail needs two non-overlapping windows below T', () => {
  let st = C.newKeywordState(kw(2.0), ctx('2026-10-01'), cfg, FP);
  const below = { impressions: 900, topIs: 0.83 };
  let r = C.decide(st, ev(st, { window: C.evaluationWindow(st, ctx('2026-10-10'), cfg), metrics: below }),
    ctx('2026-10-10'), cfg);
  assert.equal(r.newBid, null);
  assert.equal(r.st.belowCount, 1);
  st = r.st;
  r = C.decide(st, ev(st, { window: C.evaluationWindow(st, ctx('2026-10-11'), cfg), metrics: below }),
    ctx('2026-10-11'), cfg);                                  // overlapping window: not counted
  assert.equal(r.st.belowCount, 1);
  st = r.st;
  r = C.decide(st, ev(st, { window: C.evaluationWindow(st, ctx('2026-10-17'), cfg), metrics: below }),
    ctx('2026-10-17'), cfg);
  assert.equal(r.st.status, 'PERSISTENT_FAIL_RAISED');
  assert.equal(r.newBid, 2.2);
});

test('sparse keyword keeps its bid and is flagged INSUFFICIENT_DATA', () => {
  const st = C.newKeywordState(kw(2.0), ctx('2026-10-01'), cfg, FP);
  const w = C.evaluationWindow(st, ctx('2026-10-10'), cfg);
  const r = C.decide(st, ev(st, { window: w, metrics: { impressions: 120, topIs: 0.95 } }), ctx('2026-10-10'), cfg);
  assert.equal(r.newBid, null);
  assert.equal(r.st.flag, 'INSUFFICIENT_DATA');
});

test('fastCheck: triggers only on a confirmed drop in both windows with enough volume', () => {
  const start = C.dayNum('2026-10-05') * 24 + 9;
  const end = start + 12;
  const cand = {}, base = {};
  for (let s = start; s < end; s++) {
    cand[s] = { imp: 10, top: 5 };                            // 50% now
    const key = C.weekday(C.fromDayNum(Math.floor(s / 24))) + ':' + (s % 24);
    base[key] = { imp: 10, top: 9 };                          // 90% under H
  }
  assert.equal(C.fastCheck(cand, base, start, end, cfg).trigger, true);
  // Only the latest window dropped: no trigger.
  for (let s = start; s < start + 6; s++) cand[s] = { imp: 10, top: 9 };
  assert.equal(C.fastCheck(cand, base, start, end, cfg).trigger, false);
  // Too few hours since the cut.
  assert.equal(C.fastCheck(cand, base, start, start + 11, cfg).trigger, false);
  // Missing baseline never triggers.
  assert.equal(C.fastCheck(cand, {}, start, end, cfg).trigger, false);
});

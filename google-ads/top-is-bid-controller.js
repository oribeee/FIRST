/**
 * Top IS Bid Controller (Google Ads Script)
 *
 * Goal: for each eligible keyword, find and hold the LOWEST TESTED max CPC bid
 * whose Search top impression share meets TARGET_TOP_IS.
 *
 * It does NOT identify the last top-of-page slot. Google exposes no metric for
 * that; "lowest tested bid that keeps Top IS on target" is the measurable proxy.
 *
 * Scope: enabled Search campaigns using Manual CPC. Keywords below the
 * impression minimum are left untouched and logged as INSUFFICIENT_DATA.
 *
 * Schedule: hourly. Slow-loop decisions use complete, matured days and so
 * change at most about once a day; the hourly fast loop can only RESTORE the
 * last passing bid after a cut. Convergence takes weeks by design.
 *
 * State lives in a Google Sheet (tabs: State, Log, ExcludedDates). Start with
 * DRY_RUN: true; a dry run writes "State (dry run)" and the log, never bids.
 *
 * All thresholds below are untested pilot values, not validated constants.
 */

var CONFIG = {
  SPREADSHEET_URL: 'PASTE_GOOGLE_SHEET_URL_HERE',
  DRY_RUN: true,

  // Optional campaign filter: only campaigns whose name contains this text.
  CAMPAIGN_NAME_CONTAINS: '',

  // --- Target and evidence (slow loop) ---
  TARGET_TOP_IS: 0.85,          // T: required Search top impression share
  PASS_MARGIN: 0.02,            // pass:       Top IS >= T + 0.02 over a full window
  CLEAR_FAIL_MARGIN: 0.05,      // clear fail: Top IS <= T - 0.05
  TEST_DAYS: 7,                 // full window = 7 complete account-time-zone days
  MIN_TEST_IMPRESSIONS: 500,    // Google Search impressions required in a window
  EARLY_FAIL_MIN_DAYS: 3,       // a clear fail may end a window after this many days
  SLOW_MATURE_AFTER_DAYS: 1,    // extra days to wait before a day's data is used
  SLOW_LOOP_EARLIEST_HOUR: 6,   // before this hour, yesterday is treated as unreported
  ASSUME_BID_UNCHANGED_DAYS: 0, // on first sight, trust this many past mature days at the current bid

  // --- Bid search ---
  EXPLORE_CUT: 0.10,            // cut size while no failing bound L is known
  BRACKET_STOP_RATIO: 1.03,     // stop bisecting when H / L <= this
  RAISE_STEP: 0.10,             // raise after a confirmed Top IS failure with no valid H
  MIN_BID: 0.10,
  MAX_BID: 10.00,
  H_MAX_AGE_DAYS: 21,           // revalidate H before cutting if its window is older
  REOPEN_AFTER_DAYS: 28,        // after holding this long, probe below H again
  BUDGET_LOST_TOP_IS_MAX: 0.05, // campaign budget-lost top IS above this blocks raises

  // --- Fast loop (restore-only) ---
  FAST_LOOP_ENABLED: true,
  FAST_REPORTING_LAG_HOURS: 3,  // ignore the most recent hours
  FAST_WINDOW_HOURS: 6,         // two non-overlapping windows of this length
  FAST_MIN_IMPRESSIONS: 30,     // per window, for both candidate and baseline
  FAST_DROP_POINTS: 0.15        // trigger when Top % falls this far below baseline in both windows
};

var STATE_FIELDS = [
  'key', 'campaignId', 'adGroupId', 'criterionId', 'campaign', 'adGroup', 'keyword', 'matchType',
  'state', 'status', 'flag', 'bid', 'h', 'hStart', 'hEnd', 'hFp', 'l',
  'changeDate', 'changeHour', 'windowStart', 'fp', 'blockedH', 'blockedL',
  'inconclusiveCount', 'cutsBlocked', 'belowCount', 'belowEnd', 'holdSince',
  'lastWindow', 'lastImpressions', 'lastTopIs', 'topOfPageCpcEstimate', 'updated'
];
var NUMERIC_FIELDS = {
  bid: 1, h: 1, l: 1, changeHour: 1, blockedH: 1, blockedL: 1, inconclusiveCount: 1,
  belowCount: 1, lastImpressions: 1, lastTopIs: 1, topOfPageCpcEstimate: 1
};
var LOG_HEADER = ['time', 'mode', 'key', 'campaign', 'adGroup', 'keyword', 'match',
  'stateBefore', 'stateAfter', 'events', 'bidBefore', 'bidAfter', 'H', 'L',
  'window', 'impressions', 'topIs', 'flag'];
var EPS = 1e-9;

// ===================================================================
// Pure helpers (no Google APIs; unit-tested in Node)
// ===================================================================

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function dayNum(ymd) {
  var p = ymd.split('-');
  return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
}
function fromDayNum(n) {
  var d = new Date(n * 86400000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}
function addDays(ymd, n) { return fromDayNum(dayNum(ymd) + n); }
function weekday(ymd) { return new Date(dayNum(ymd) * 86400000).getUTCDay(); }
function minYmd(a, b) { return a < b ? a : b; }
function maxYmd(a, b) { return a > b ? a : b; }
function round2(x) { return Math.round(x * 100) / 100; }
function sameBid(a, b) { return a != null && b != null && Math.abs(a - b) < 0.005; }
function sameOrBothNull(a, b) { return (a == null && b == null) || sameBid(a, b); }

/** Last day whose data the slow loop may use. */
function lastMatureDay(ctx, cfg) {
  var extra = ctx.hour < cfg.SLOW_LOOP_EARLIEST_HOUR ? 1 : 0;
  return addDays(ctx.today, -1 - cfg.SLOW_MATURE_AFTER_DAYS - extra);
}

/**
 * Window to evaluate. TESTING: the fixed window from the cut (max TEST_DAYS).
 * BASELINE/HOLD: the latest TEST_DAYS mature days, never before windowStart.
 */
function evaluationWindow(st, ctx, cfg) {
  var last = lastMatureDay(ctx, cfg);
  var start, end;
  if (st.state === 'TESTING') {
    start = st.windowStart;
    end = minYmd(addDays(start, cfg.TEST_DAYS - 1), last);
  } else {
    start = maxYmd(st.windowStart, addDays(last, -(cfg.TEST_DAYS - 1)));
    end = last;
  }
  var days = dayNum(end) - dayNum(start) + 1;
  return days > 0 ? { start: start, end: end, days: days } : null;
}

/** Latest end date of an excluded range overlapping [start, end], or null. */
function excludedOverlap(start, end, excluded) {
  var latest = null;
  (excluded || []).forEach(function (r) {
    if (r.start <= end && r.end >= start && (latest == null || r.end > latest)) latest = r.end;
  });
  return latest;
}

/**
 * CLEAR_FAIL | PASS | BELOW_TARGET | INCONCLUSIVE | INSUFFICIENT_DATA | WAIT.
 * The band between the clear-fail line and the pass line is never a pass.
 */
function classify(win, m, cfg) {
  var T = cfg.TARGET_TOP_IS;
  var enough = m != null && m.topIs != null && m.impressions >= cfg.MIN_TEST_IMPRESSIONS;
  if (enough && win.days >= cfg.EARLY_FAIL_MIN_DAYS && m.topIs <= T - cfg.CLEAR_FAIL_MARGIN + EPS) {
    return 'CLEAR_FAIL';
  }
  if (win.days < cfg.TEST_DAYS) return 'WAIT';
  if (!enough) return 'INSUFFICIENT_DATA';
  if (m.topIs >= T + cfg.PASS_MARGIN - EPS) return 'PASS';
  if (m.topIs < T - EPS) return 'BELOW_TARGET';
  return 'INCONCLUSIVE';
}

/** Next bid to test below H, or null when the search has converged. */
function nextCandidate(st, cfg) {
  var H = st.h;
  if (H == null) return null;
  if (st.l != null) {
    if (H / st.l <= cfg.BRACKET_STOP_RATIO + EPS) return null;
    var mid = round2(Math.sqrt(st.l * H));      // geometric midpoint
    if (mid <= st.l + 0.005 || mid >= H - 0.005) return null;
    return mid;
  }
  var cut = Math.max(cfg.MIN_BID, round2(H * (1 - cfg.EXPLORE_CUT)));
  return cut >= H - 0.005 ? null : cut;
}

function raisedBid(b, cfg) {
  return Math.min(cfg.MAX_BID, Math.max(round2(b * (1 + cfg.RAISE_STEP)), round2(b + 0.01)));
}

function newKeywordState(kw, ctx, cfg, fp) {
  var trusted = cfg.ASSUME_BID_UNCHANGED_DAYS || 0;
  return {
    key: kw.key, campaignId: kw.campaignId, adGroupId: kw.adGroupId, criterionId: kw.criterionId,
    campaign: kw.campaign, adGroup: kw.adGroup, keyword: kw.keyword, matchType: kw.matchType,
    state: 'BASELINE', status: 'NEW', flag: '', bid: kw.bid, h: null, hStart: '', hEnd: '', hFp: '',
    l: null, changeDate: ctx.today, changeHour: ctx.hour,
    windowStart: trusted > 0 ? addDays(lastMatureDay(ctx, cfg), -(trusted - 1)) : addDays(ctx.today, 1),
    fp: fp, blockedH: null, blockedL: null, inconclusiveCount: 0, cutsBlocked: '',
    belowCount: 0, belowEnd: '', holdSince: '', lastWindow: '', lastImpressions: null,
    lastTopIs: null, topOfPageCpcEstimate: kw.topOfPageCpc, updated: ''
  };
}

/**
 * Restore-only fast check. Compares Top % in the last two non-overlapping
 * windows of completed hours since the cut against the same weekday+hour
 * pairs recorded while H was validated. Missing or thin data never triggers.
 *
 * candSlots: {slotIndex: {imp, top}}, slotIndex = dayNum * 24 + hour
 * baseByDowHour: {'dow:hour': {imp, top}}
 * slotStart (inclusive) .. slotEnd (exclusive): usable slots since the cut
 */
function fastCheck(candSlots, baseByDowHour, slotStart, slotEnd, cfg) {
  var W = cfg.FAST_WINDOW_HOURS;
  if (slotEnd - slotStart < 2 * W) return { trigger: false, detail: 'fast:not enough hours' };
  var details = [];
  for (var w = 0; w < 2; w++) {
    var from = slotEnd - (2 - w) * W, to = from + W;
    var c = { imp: 0, top: 0 }, b = { imp: 0, top: 0 };
    for (var s = from; s < to; s++) {
      var cs = candSlots[s];
      if (cs) { c.imp += cs.imp; c.top += cs.top; }
      var bs = baseByDowHour[weekday(fromDayNum(Math.floor(s / 24))) + ':' + (s % 24)];
      if (bs) { b.imp += bs.imp; b.top += bs.top; }
    }
    if (c.imp < cfg.FAST_MIN_IMPRESSIONS || b.imp < cfg.FAST_MIN_IMPRESSIONS) {
      return { trigger: false, detail: 'fast:low volume' };
    }
    var cp = c.top / c.imp, bp = b.top / b.imp;
    details.push((cp * 100).toFixed(0) + '% vs ' + (bp * 100).toFixed(0) + '%');
    if (cp > bp - cfg.FAST_DROP_POINTS + EPS) return { trigger: false, detail: 'fast:ok' };
  }
  return { trigger: true, detail: 'Top % ' + details.join(', ') };
}

/**
 * The controller. Pure: takes the stored state and this run's evidence,
 * returns the new state and the bid to set (null = no change).
 *
 * ev: { currentBid, fp, window, metrics: {impressions, topIs}, budgetLost, fast }
 * ctx: { today: 'yyyy-MM-dd', hour: 0-23, excluded: [{start, end}] }
 */
function decide(st0, ev, ctx, cfg) {
  var st = JSON.parse(JSON.stringify(st0));
  var out = { st: st, newBid: null, events: [] };

  function note(name, detail) {
    out.events.push(detail ? name + ' (' + detail + ')' : name);
    st.status = name;
  }
  function setBid(b) {
    out.newBid = b;
    st.bid = b;
    st.changeDate = ctx.today;
    st.changeHour = ctx.hour;
    st.windowStart = addDays(ctx.today, 1);
    if (ev.fp !== 'NA') st.fp = ev.fp;
    st.belowCount = 0;
    st.belowEnd = '';
  }
  // Repeated conditions (e.g. budget-limited every hour) are logged once.
  function noteOnce(name, detail) {
    if (st0.status === name) st.status = name; else note(name, detail);
  }
  function clearH() { st.h = null; st.hStart = ''; st.hEnd = ''; st.hFp = ''; }
  function enterHold() { st.state = 'HOLD'; st.holdSince = ctx.today; }
  function restoreH(reason, detail) {
    enterHold();
    setBid(st.h);
    note(reason, detail);
  }
  function blockBracket() { st.blockedH = st.h; st.blockedL = st.l; }

  // Raise after confirmed Top IS failure with no valid H (blocked by budget or ceiling).
  function raiseOrStay(reason) {
    st.state = 'BASELINE';
    if (ev.budgetLost != null && ev.budgetLost > cfg.BUDGET_LOST_TOP_IS_MAX) {
      st.flag = 'BUDGET_LIMITED';
      noteOnce('BUDGET_LIMITED', reason + '; budget-lost top IS ' + (ev.budgetLost * 100).toFixed(0) + '%, raise blocked');
      return;
    }
    if (st.bid >= cfg.MAX_BID - 0.005) {
      st.flag = 'AT_MAX_BID';
      noteOnce('AT_MAX_BID', reason + '; cannot raise');
      return;
    }
    st.flag = '';
    setBid(raisedBid(st.bid, cfg));
    note(reason + '_RAISED');
  }

  // Track Top IS < T in two separate (non-overlapping) qualified windows.
  function countBelow(win) {
    if (!st.belowEnd || win.start > st.belowEnd) {
      st.belowCount = (st.belowCount || 0) + 1;
      st.belowEnd = win.end;
    }
    return st.belowCount >= 2;
  }

  function tryCut() {
    var reopenDue = st.holdSince && dayNum(ctx.today) - dayNum(st.holdSince) >= cfg.REOPEN_AFTER_DAYS;
    function hold(reason) { if (out.events.length === 0) st.status = 'HOLD:' + reason; }
    if (st.cutsBlocked) return hold('RECOVERY');
    if (!st.hEnd || dayNum(ctx.today) - dayNum(st.hEnd) > cfg.H_MAX_AGE_DAYS) return hold('H_STALE');
    var blocked = st.blockedH != null && sameBid(st.blockedH, st.h) && sameOrBothNull(st.blockedL, st.l);
    var cand = nextCandidate(st, cfg);
    if ((blocked || cand == null) && reopenDue) {
      // Old results stay as hints: retest the blocked bracket, or, if it had
      // converged, re-check L itself in case conditions have eased.
      st.blockedH = null; st.blockedL = null; st.inconclusiveCount = 0;
      blocked = false;
      cand = nextCandidate(st, cfg);
      if (cand == null && st.l != null && st.l < st.h - 0.005) cand = st.l;
      note('REOPEN', 'held ' + cfg.REOPEN_AFTER_DAYS + '+ days; retesting below H');
    }
    if (blocked) return hold('BRACKET_BLOCKED');
    if (cand == null) return hold('CONVERGED');
    var planEnd = addDays(ctx.today, cfg.TEST_DAYS + cfg.SLOW_MATURE_AFTER_DAYS + 1);
    if (excludedOverlap(addDays(ctx.today, 1), planEnd, ctx.excluded)) return hold('EXCLUDED_DATES_AHEAD');
    st.state = 'TESTING';
    setBid(cand);
    note('CUT', 'testing ' + cand.toFixed(2) + ' below H ' + st.h.toFixed(2) +
      (st.l != null ? ', L ' + st.l.toFixed(2) : ''));
  }

  // 1. Someone else changed the bid: all evidence is void.
  if (!sameBid(ev.currentBid, st.bid)) {
    var prev = st.bid;
    st.state = 'BASELINE'; st.bid = ev.currentBid; clearH(); st.l = null;
    st.blockedH = null; st.blockedL = null; st.inconclusiveCount = 0; st.cutsBlocked = '';
    st.changeDate = ctx.today; st.changeHour = ctx.hour; st.windowStart = addDays(ctx.today, 1);
    if (ev.fp !== 'NA') st.fp = ev.fp;
    st.belowCount = 0; st.belowEnd = ''; st.flag = '';
    note('MANUAL_CHANGE', 'bid ' + prev + ' -> ' + ev.currentBid + ' outside the script; restarting');
    return out;
  }

  // 2. Bid adjustments / targeting changed: windows are not comparable.
  //    Keep H only as a starting hint (bid) and revalidate it; keep L as a hint.
  if (ev.fp !== 'NA' && st.fp !== 'NA' && st.fp !== ev.fp) {
    st.blockedH = null; st.blockedL = null; st.inconclusiveCount = 0; st.cutsBlocked = '';
    if (st.state === 'TESTING') {
      var h = st.h;
      clearH();
      st.state = 'BASELINE';
      setBid(h);
    } else {
      if (st.state === 'HOLD') clearH();
      st.state = 'BASELINE';
      st.windowStart = addDays(ctx.today, 1);
      st.fp = ev.fp; st.belowCount = 0; st.belowEnd = '';
    }
    note('NOT_COMPARABLE', 'bid adjustments or targeting changed; revalidating');
    return out;
  }

  var win = ev.window;
  if (win) {
    st.lastWindow = win.start + '..' + win.end;
    st.lastImpressions = ev.metrics ? ev.metrics.impressions : null;
    st.lastTopIs = ev.metrics ? ev.metrics.topIs : null;
  }

  // 3. State handlers.
  if (st.state === 'TESTING') {
    if (ev.fast && ev.fast.trigger) {
      st.inconclusiveCount = (st.inconclusiveCount || 0) + 1;
      st.cutsBlocked = 'yes';                     // no cuts until H passes again
      if (st.inconclusiveCount >= 2) blockBracket();
      restoreH('FAST_RESTORE', ev.fast.detail + '; test inconclusive');
      return out;
    }
    if (!win) { st.status = 'TESTING:WAIT'; return out; }
    if (excludedOverlap(win.start, win.end, ctx.excluded)) {
      restoreH('NOT_COMPARABLE', 'test window overlaps excluded dates');
      return out;
    }
    var c = classify(win, ev.metrics, cfg);
    if (c === 'WAIT') { st.status = 'TESTING:WAIT'; return out; }
    if (c === 'CLEAR_FAIL') {
      st.l = st.bid; st.inconclusiveCount = 0;
      restoreH('CLEAR_FAIL', 'L = ' + st.l.toFixed(2));
      tryCut();
      return out;
    }
    if (c === 'PASS') {
      st.h = st.bid; st.hStart = win.start; st.hEnd = win.end; st.hFp = st.fp;
      st.inconclusiveCount = 0;
      if (st.l != null && st.l >= st.h - 0.005) st.l = null;   // L itself passed: conditions eased
      enterHold();
      st.windowStart = addDays(win.end, 1);
      note('PASS', 'H = ' + st.h.toFixed(2));
      tryCut();
      return out;
    }
    // Full window without a pass or a clear fail: reject the bid, do NOT set L.
    blockBracket();
    restoreH('INCONCLUSIVE_TIMEOUT', c);
    return out;
  }

  if (st.state === 'BASELINE' || st.state === 'HOLD') {
    if (!win) {
      if (st.state === 'BASELINE') { st.status = 'BASELINE:WAIT'; return out; }
      tryCut();
      return out;
    }
    var exc = excludedOverlap(win.start, win.end, ctx.excluded);
    if (exc) {
      st.windowStart = addDays(exc, 1);
      noteOnce('NOT_COMPARABLE', 'window overlaps excluded dates');
      return out;
    }
    var k = classify(win, ev.metrics, cfg);

    if (k === 'CLEAR_FAIL' || (k === 'BELOW_TARGET' && countBelow(win))) {
      var reason = k === 'CLEAR_FAIL' ? 'CLEAR_FAIL' : 'PERSISTENT_FAIL';
      st.l = st.bid; st.inconclusiveCount = 0; st.cutsBlocked = '';
      st.blockedH = null; st.blockedL = null;
      clearH();
      raiseOrStay(reason);
      return out;
    }
    if (k === 'PASS') {
      st.h = st.bid; st.hStart = win.start; st.hEnd = win.end; st.hFp = st.fp;
      st.belowCount = 0; st.belowEnd = ''; st.cutsBlocked = ''; st.flag = '';
      if (st.l != null && st.l >= st.h - 0.005) st.l = null;   // stale hint above a passing bid
      if (st.state === 'BASELINE') {
        enterHold();
        st.windowStart = addDays(win.end, 1);
        note('PASS', 'H = ' + st.h.toFixed(2));
      }
      tryCut();
      return out;
    }
    if (k === 'INCONCLUSIVE') { st.belowCount = 0; st.belowEnd = ''; }

    if (st.state === 'BASELINE') {
      if (k === 'INSUFFICIENT_DATA') { st.flag = 'INSUFFICIENT_DATA'; st.status = 'INSUFFICIENT_DATA'; }
      else if (k === 'WAIT') st.status = 'BASELINE:WAIT';
      else { st.flag = 'NO_VALID_H'; st.status = 'NO_VALID_H:' + k; }   // observe, never cut
      return out;
    }
    if (k === 'INSUFFICIENT_DATA') st.flag = 'INSUFFICIENT_DATA';
    tryCut();
    return out;
  }

  st.status = 'UNKNOWN_STATE';
  return out;
}

// ===================================================================
// Google Ads / Sheets I/O
// ===================================================================

function main() {
  var cfg = CONFIG;
  var tz = AdsApp.currentAccount().getTimeZone();
  var now = new Date();
  var ctx = {
    today: Utilities.formatDate(now, tz, 'yyyy-MM-dd'),
    hour: parseInt(Utilities.formatDate(now, tz, 'H'), 10),
    excluded: []
  };
  var ss = SpreadsheetApp.openByUrl(cfg.SPREADSHEET_URL);
  ctx.excluded = loadExcluded(ss, tz);
  var stored = loadState(ss);
  var keywords = fetchKeywords(cfg);
  var kwKeys = Object.keys(keywords);
  Logger.log('Eligible keywords: ' + kwKeys.length + (cfg.DRY_RUN ? ' (DRY RUN)' : ''));
  if (kwKeys.length === 0) return;

  var campaignIds = unique(kwKeys.map(function (k) { return keywords[k].campaignId; }));
  var fps = fetchFingerprints(keywords, campaignIds);

  // Build current states.
  var states = {};
  kwKeys.forEach(function (k) {
    var kw = keywords[k];
    var st = stored[k] || newKeywordState(kw, ctx, cfg, fps[k]);
    st.campaign = kw.campaign; st.adGroup = kw.adGroup; st.keyword = kw.keyword;
    st.matchType = kw.matchType; st.topOfPageCpcEstimate = kw.topOfPageCpc;
    states[k] = st;
  });

  // Slow-loop evidence: one query per distinct window.
  var windows = {}, byWindow = {};
  kwKeys.forEach(function (k) {
    var w = evaluationWindow(states[k], ctx, cfg);
    windows[k] = w;
    if (w) {
      var wk = w.start + '|' + w.end;
      (byWindow[wk] = byWindow[wk] || []).push(k);
    }
  });
  var metrics = {}, budgetLost = {};
  Object.keys(byWindow).forEach(function (wk) {
    var parts = wk.split('|'), keys = byWindow[wk];
    var m = fetchWindowMetrics(keys.map(function (k) { return keywords[k]; }), parts[0], parts[1]);
    var b = fetchBudgetLost(unique(keys.map(function (k) { return keywords[k].campaignId; })), parts[0], parts[1]);
    keys.forEach(function (k) {
      metrics[k] = m[k] || { impressions: 0, topIs: null };
      budgetLost[k] = b[keywords[k].campaignId];
    });
  });

  // Fast-loop evidence for keywords under test.
  var fast = {};
  if (cfg.FAST_LOOP_ENABLED) {
    try {
      fast = computeFast(states, keywords, fps, ctx, cfg);
    } catch (e) {
      Logger.log('WARNING: fast loop disabled this run: ' + e);
    }
  }

  // Decide.
  var results = {}, changes = [];
  kwKeys.forEach(function (k) {
    var ev = {
      currentBid: keywords[k].bid, fp: fps[k], window: windows[k],
      metrics: metrics[k], budgetLost: budgetLost[k], fast: fast[k] || null
    };
    var r = decide(states[k], ev, ctx, cfg);
    r.st.updated = ctx.today + ' ' + pad2(ctx.hour) + ':00';
    results[k] = r;
    if (r.newBid != null && !sameBid(r.newBid, keywords[k].bid)) {
      changes.push({ key: k, adGroupId: keywords[k].adGroupId, criterionId: keywords[k].criterionId, bid: r.newBid });
    }
  });

  // Apply bids (live only). Keep the old state for any keyword that failed.
  if (!cfg.DRY_RUN && changes.length) {
    var failed = applyBids(changes);
    failed.forEach(function (k) {
      results[k].st = states[k];
      results[k].st.status = 'APPLY_ERROR';
      results[k].events.push('APPLY_ERROR');
    });
  }

  // Log and persist.
  var stamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm');
  var logRows = [];
  kwKeys.forEach(function (k) {
    var before = states[k], r = results[k], after = r.st;
    var changed = r.events.length > 0 || before.state !== after.state || before.status !== after.status ||
      !sameOrBothNull(before.bid, after.bid);
    if (!changed && stored[k]) return;
    logRows.push([stamp, cfg.DRY_RUN ? 'DRY' : 'LIVE', k, after.campaign, after.adGroup, after.keyword,
      after.matchType, stored[k] ? before.state : 'NEW', after.state, r.events.join('; ') || after.status,
      keywords[k].bid, after.bid, after.h, after.l, after.lastWindow, after.lastImpressions,
      after.lastTopIs, after.flag]);
  });
  appendLog(ss, logRows);
  saveState(ss, cfg.DRY_RUN ? 'State (dry run)' : 'State', kwKeys.map(function (k) { return results[k].st; }));
  Logger.log('Bid changes ' + (cfg.DRY_RUN ? 'proposed' : 'applied') + ': ' + changes.length +
    '; log rows: ' + logRows.length);
}

function unique(arr) {
  var seen = {}, out = [];
  arr.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } });
  return out;
}
function chunk(arr, n) {
  var out = [];
  for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function microsToBid(m) { return m == null ? null : round2(Number(m) / 1e6); }

function fetchKeywords(cfg) {
  var q = 'SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ' +
    'ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ' +
    'ad_group_criterion.keyword.match_type, ad_group_criterion.effective_cpc_bid_micros, ' +
    'ad_group_criterion.position_estimates.top_of_page_cpc_micros ' +
    'FROM ad_group_criterion ' +
    "WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE " +
    "AND ad_group_criterion.status = 'ENABLED' AND ad_group.status = 'ENABLED' " +
    "AND campaign.status = 'ENABLED' AND campaign.advertising_channel_type = 'SEARCH' " +
    "AND campaign.bidding_strategy_type = 'MANUAL_CPC'";
  if (cfg.CAMPAIGN_NAME_CONTAINS) {
    q += " AND campaign.name LIKE '%" + cfg.CAMPAIGN_NAME_CONTAINS.replace(/'/g, "\\'") + "%'";
  }
  var out = {}, rows = AdsApp.search(q);
  while (rows.hasNext()) {
    var r = rows.next();
    var key = String(r.adGroup.id) + ':' + String(r.adGroupCriterion.criterionId);
    var est = r.adGroupCriterion.positionEstimates;
    out[key] = {
      key: key, campaignId: String(r.campaign.id), adGroupId: String(r.adGroup.id),
      criterionId: String(r.adGroupCriterion.criterionId), campaign: r.campaign.name,
      adGroup: r.adGroup.name, keyword: r.adGroupCriterion.keyword.text,
      matchType: r.adGroupCriterion.keyword.matchType,
      bid: microsToBid(r.adGroupCriterion.effectiveCpcBidMicros),
      topOfPageCpc: est && est.topOfPageCpcMicros != null ? microsToBid(est.topOfPageCpcMicros) : null
    };
  }
  return out;
}

/** Top IS and Google Search impressions for the whole window (not daily averages). */
function fetchWindowMetrics(kws, start, end) {
  var out = {};
  chunk(unique(kws.map(function (k) { return k.adGroupId; })), 300).forEach(function (ids) {
    var q = 'SELECT ad_group.id, ad_group_criterion.criterion_id, segments.ad_network_type, ' +
      'metrics.impressions, metrics.search_top_impression_share FROM keyword_view ' +
      "WHERE segments.date BETWEEN '" + start + "' AND '" + end + "' " +
      "AND segments.ad_network_type = 'SEARCH' AND ad_group.id IN (" + ids.join(',') + ')';
    var rows = AdsApp.search(q);
    while (rows.hasNext()) {
      var r = rows.next();
      var share = r.metrics.searchTopImpressionShare;
      out[String(r.adGroup.id) + ':' + String(r.adGroupCriterion.criterionId)] = {
        impressions: Number(r.metrics.impressions || 0),
        topIs: share == null ? null : Number(share)
      };
    }
  });
  return out;
}

function fetchBudgetLost(campaignIds, start, end) {
  var out = {};
  chunk(campaignIds, 300).forEach(function (ids) {
    var q = 'SELECT campaign.id, metrics.search_budget_lost_top_impression_share FROM campaign ' +
      "WHERE segments.date BETWEEN '" + start + "' AND '" + end + "' AND campaign.id IN (" + ids.join(',') + ')';
    var rows = AdsApp.search(q);
    while (rows.hasNext()) {
      var r = rows.next();
      var v = r.metrics.searchBudgetLostTopImpressionShare;
      out[String(r.campaign.id)] = v == null ? null : Number(v);
    }
  });
  return out;
}

/**
 * Fingerprint of bid adjustments and targeting that make windows non-comparable:
 * campaign device / schedule / location / language criteria and ad group bid modifiers.
 */
function fetchFingerprints(keywords, campaignIds) {
  var camp = {}, ag = {};
  try {
    chunk(campaignIds, 300).forEach(function (ids) {
      var rows = AdsApp.search('SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.type, ' +
        'campaign_criterion.status, campaign_criterion.negative, campaign_criterion.bid_modifier ' +
        "FROM campaign_criterion WHERE campaign_criterion.type IN ('DEVICE', 'AD_SCHEDULE', 'LOCATION', " +
        "'PROXIMITY', 'LANGUAGE') AND campaign.id IN (" + ids.join(',') + ')');
      while (rows.hasNext()) {
        var r = rows.next(), c = r.campaignCriterion;
        (camp[String(r.campaign.id)] = camp[String(r.campaign.id)] || []).push(
          [c.criterionId, c.type, c.status, c.negative, c.bidModifier].join('/'));
      }
      var rows2 = AdsApp.search('SELECT ad_group.id, ad_group_bid_modifier.criterion_id, ' +
        'ad_group_bid_modifier.bid_modifier FROM ad_group_bid_modifier WHERE campaign.id IN (' + ids.join(',') + ')');
      while (rows2.hasNext()) {
        var r2 = rows2.next(), m = r2.adGroupBidModifier;
        (ag[String(r2.adGroup.id)] = ag[String(r2.adGroup.id)] || []).push([m.criterionId, m.bidModifier].join('/'));
      }
    });
  } catch (e) {
    Logger.log('WARNING: fingerprint query failed, change detection disabled this run: ' + e);
    var none = {};
    Object.keys(keywords).forEach(function (k) { none[k] = 'NA'; });
    return none;
  }
  var out = {};
  Object.keys(keywords).forEach(function (k) {
    var kw = keywords[k];
    var s = (camp[kw.campaignId] || []).sort().join(',') + '|' + (ag[kw.adGroupId] || []).sort().join(',');
    out[k] = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s));
  });
  return out;
}

/** Hourly rows -> {key: {slotIndex: {imp, top}}}. Top impressions = Top % x impressions. */
function fetchHourly(adGroupIds, start, end) {
  var out = {};
  chunk(adGroupIds, 300).forEach(function (ids) {
    var q = 'SELECT ad_group.id, ad_group_criterion.criterion_id, segments.date, segments.hour, ' +
      'segments.ad_network_type, metrics.impressions, metrics.top_impression_percentage FROM keyword_view ' +
      "WHERE segments.date BETWEEN '" + start + "' AND '" + end + "' " +
      "AND segments.ad_network_type = 'SEARCH' AND ad_group.id IN (" + ids.join(',') + ')';
    var rows = AdsApp.search(q);
    while (rows.hasNext()) {
      var r = rows.next();
      var key = String(r.adGroup.id) + ':' + String(r.adGroupCriterion.criterionId);
      var imp = Number(r.metrics.impressions || 0);
      var slot = dayNum(r.segments.date) * 24 + Number(r.segments.hour);
      var o = (out[key] = out[key] || {});
      o[slot] = { imp: imp, top: imp * Number(r.metrics.topImpressionPercentage || 0) };
    }
  });
  return out;
}

function computeFast(states, keywords, fps, ctx, cfg) {
  var res = {};
  var testing = Object.keys(states).filter(function (k) {
    var st = states[k];
    // Missing baseline, or a baseline recorded under different adjustments, disables the fast loop.
    return st.state === 'TESTING' && st.hStart && st.hEnd && fps[k] !== 'NA' &&
      st.hFp === fps[k] && st.fp === fps[k];
  });
  if (!testing.length) return res;
  var nowSlot = dayNum(ctx.today) * 24 + ctx.hour;
  var slotEnd = nowSlot - cfg.FAST_REPORTING_LAG_HOURS;
  var candStartDate = fromDayNum(Math.floor((slotEnd - 2 * cfg.FAST_WINDOW_HOURS) / 24));

  var cand = fetchHourly(unique(testing.map(function (k) { return keywords[k].adGroupId; })), candStartDate, ctx.today);
  var byH = {};
  testing.forEach(function (k) {
    var wk = states[k].hStart + '|' + states[k].hEnd;
    (byH[wk] = byH[wk] || []).push(k);
  });
  Object.keys(byH).forEach(function (wk) {
    var p = wk.split('|'), keys = byH[wk];
    var base = fetchHourly(unique(keys.map(function (k) { return keywords[k].adGroupId; })), p[0], p[1]);
    keys.forEach(function (k) {
      var st = states[k];
      var byDowHour = {};
      var slots = base[k] || {};
      Object.keys(slots).forEach(function (s) {
        var key = weekday(fromDayNum(Math.floor(s / 24))) + ':' + (s % 24);
        var b = (byDowHour[key] = byDowHour[key] || { imp: 0, top: 0 });
        b.imp += slots[s].imp; b.top += slots[s].top;
      });
      var slotStart = dayNum(st.changeDate) * 24 + Number(st.changeHour) + 1;  // first full hour after the cut
      res[k] = fastCheck(cand[k] || {}, byDowHour, slotStart, slotEnd, cfg);
    });
  });
  return res;
}

function applyBids(changes) {
  var want = {};
  changes.forEach(function (c) { want[c.key] = c.bid; });
  var done = {};
  chunk(changes, 5000).forEach(function (part) {
    var it = AdsApp.keywords().withIds(part.map(function (c) {
      return [Number(c.adGroupId), Number(c.criterionId)];
    })).get();
    while (it.hasNext()) {
      var kw = it.next();
      var key = String(kw.getAdGroup().getId()) + ':' + String(kw.getId());
      if (want[key] == null) continue;
      try {
        kw.bidding().setCpc(want[key]);
        done[key] = true;
      } catch (e) {
        Logger.log('Bid change failed for ' + key + ': ' + e);
      }
    }
  });
  return Object.keys(want).filter(function (k) { return !done[k]; });
}

// ---------- Sheet storage ----------

function getSheet(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function loadState(ss) {
  var sh = getSheet(ss, 'State', STATE_FIELDS);
  var out = {};
  if (sh.getLastRow() < 2) return out;
  var vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
  var header = vals[0];
  for (var i = 1; i < vals.length; i++) {
    var st = {};
    header.forEach(function (f, j) {
      var v = vals[i][j];
      st[f] = NUMERIC_FIELDS[f] ? (v === '' ? null : Number(v)) : v;
    });
    if (st.key) out[st.key] = st;
  }
  return out;
}

function saveState(ss, name, states) {
  var sh = getSheet(ss, name, STATE_FIELDS);
  sh.clearContents();
  var rows = [STATE_FIELDS].concat(states.map(function (st) {
    return STATE_FIELDS.map(function (f) { return st[f] == null ? '' : String(st[f]); });
  }));
  var range = sh.getRange(1, 1, rows.length, STATE_FIELDS.length);
  range.setNumberFormat('@');           // keep dates and IDs as text
  range.setValues(rows);
}

function appendLog(ss, rows) {
  if (!rows.length) return;
  var sh = getSheet(ss, 'Log', LOG_HEADER);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, LOG_HEADER.length).setValues(rows);
}

/** ExcludedDates tab: start | end | reason (holidays, promotions, outages, targeting changes). */
function loadExcluded(ss, tz) {
  var sh = getSheet(ss, 'ExcludedDates', ['start', 'end', 'reason']);
  if (sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  function ymd(v) {
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    return String(v).trim();
  }
  return vals.filter(function (r) { return r[0] !== ''; }).map(function (r) {
    var s = ymd(r[0]);
    return { start: s, end: r[1] === '' ? s : ymd(r[1]) };
  });
}

// Node test hook; ignored inside Google Ads Scripts.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG: CONFIG, decide: decide, classify: classify, nextCandidate: nextCandidate,
    evaluationWindow: evaluationWindow, lastMatureDay: lastMatureDay, fastCheck: fastCheck,
    excludedOverlap: excludedOverlap, newKeywordState: newKeywordState, addDays: addDays,
    dayNum: dayNum, fromDayNum: fromDayNum, weekday: weekday
  };
}

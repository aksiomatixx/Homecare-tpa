'use strict';

/**
 * commutationService.js — DEU Table 1 PV lookup + Template B commutation.
 *
 * Authority: 8 CCR §10169 / §10169.1. Table 1 at
 *   docs/regulatory/deu_table1_pv_pd.csv.
 * Do not hardcode or modify PV values — they are regulatory data.
 * Methodology = DEU Commutation Instructions (Jan 2001), Template B
 * (Commutation of PD off the far end).
 *
 * Table 1 embeds a 3% annual discount rate. LC §5800 late-payment interest
 * is 10% annual simple.
 *
 * Pure functions. No database access, no Supabase imports, no AI calls.
 */

const fs   = require('fs');
const path = require('path');

// ── DEU policy constants ─────────────────────────────────────────────────────
const DEU_POLICY = {
  INTEREST_RATE_ANNUAL:      0.03,                              // embedded in Table 1
  LATE_PAYMENT_RATE_ANNUAL:  0.10,                              // LC §5800
  TABLE_1_MAX_WEEKS:         950,
  TABLE_1_SOURCE:            'docs/regulatory/deu_table1_pv_pd.csv',
};

// ── CSV load (synchronous at require time) ───────────────────────────────────
const CSV_PATH = path.join(__dirname, '..', '..', '..', 'docs', 'regulatory', 'deu_table1_pv_pd.csv');

function _loadTable1() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`commutationService: DEU Table 1 missing at ${CSV_PATH}`);
  }
  const raw = fs.readFileSync(CSV_PATH, 'utf8').trim();
  const lines = raw.split(/\r?\n/);
  if (lines[0].trim().toLowerCase() !== 'weeks,pv') {
    throw new Error(`commutationService: DEU Table 1 header mismatch — got "${lines[0]}"`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const [weeksStr, pvStr] = lines[i].split(',');
    const weeks = parseInt(weeksStr, 10);
    const pv    = parseFloat(pvStr);
    if (!Number.isFinite(weeks) || !Number.isFinite(pv)) {
      throw new Error(`commutationService: DEU Table 1 row ${i + 1} parse failed`);
    }
    rows.push({ weeks, pv });
  }
  if (rows.length !== DEU_POLICY.TABLE_1_MAX_WEEKS) {
    throw new Error(
      `commutationService: DEU Table 1 expected ${DEU_POLICY.TABLE_1_MAX_WEEKS} rows, got ${rows.length}`,
    );
  }
  // Verify first and last row integrity (defence in depth against file corruption).
  if (rows[0].weeks !== 1)   throw new Error(`commutationService: DEU Table 1 first row weeks=${rows[0].weeks}, expected 1`);
  if (rows[rows.length - 1].weeks !== 950) throw new Error(`commutationService: DEU Table 1 last row weeks=${rows[rows.length - 1].weeks}, expected 950`);
  return rows;
}

const DEU_TABLE_1 = _loadTable1();

// ── PV lookup (with linear interpolation) ────────────────────────────────────
function getPvForWeeks(weeks) {
  if (!Number.isFinite(weeks)) {
    throw new Error('INVALID_WEEKS');
  }
  if (weeks < 0) {
    throw new Error('INVALID_WEEKS');
  }
  if (weeks === 0) return 0;
  if (weeks > DEU_POLICY.TABLE_1_MAX_WEEKS) {
    throw new Error('DEU_RANGE_EXCEEDED');
  }

  const whole = Math.floor(weeks);
  const frac  = weeks - whole;

  // Row index for week N is N-1 (rows are 1-indexed in the CSV).
  const lo = DEU_TABLE_1[whole - 1];

  if (frac === 0) {
    return lo.pv;
  }

  // whole is guaranteed < TABLE_1_MAX_WEEKS here because weeks <= 950 and frac > 0 implies weeks < 950
  const hi = DEU_TABLE_1[whole];
  return lo.pv + frac * (hi.pv - lo.pv);
}

// ── Reverse lookup: weeks that give a target PV ──────────────────────────────
function getWeeksForPv(pv) {
  if (!Number.isFinite(pv)) {
    throw new Error('INVALID_PV');
  }
  if (pv <= 0) return 0;
  const maxPv = DEU_TABLE_1[DEU_TABLE_1.length - 1].pv;
  if (pv > maxPv) {
    throw new Error('DEU_RANGE_EXCEEDED');
  }

  // Binary search for the row where pv first exceeds target.
  let lo = 0, hi = DEU_TABLE_1.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (DEU_TABLE_1[mid].pv < pv) lo = mid + 1;
    else hi = mid;
  }
  // DEU_TABLE_1[lo].pv >= pv. If lo === 0, we're below the first row.
  if (lo === 0) {
    // Interpolate between PV(0)=0 and PV(1)=DEU_TABLE_1[0].pv
    return pv / DEU_TABLE_1[0].pv;
  }
  const before = DEU_TABLE_1[lo - 1];
  const after  = DEU_TABLE_1[lo];
  const span   = after.pv - before.pv;
  if (span === 0) return before.weeks;
  return before.weeks + (pv - before.pv) / span;
}

// ── LC §5800 late-payment interest ───────────────────────────────────────────
function computeLateInterest(amount, docDate, actualPayDate) {
  const a = parseFloat(amount) || 0;
  if (a <= 0) return 0;
  const d1 = new Date(docDate + (docDate.includes('T') ? '' : 'T00:00:00Z'));
  const d2 = new Date(actualPayDate + (actualPayDate.includes('T') ? '' : 'T00:00:00Z'));
  const days = Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 0;
  return Math.round(a * days * DEU_POLICY.LATE_PAYMENT_RATE_ANNUAL / 365 * 100) / 100;
}

// ── DEU Template B: commutation of PD off the far end ────────────────────────
function commutePdOffFarEnd({ weeklyRate, weeksRemainingAtDoc, amountToCommute, docDate, actualPayDate }) {
  const rate = parseFloat(weeklyRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('INVALID_WEEKLY_RATE');
  }
  const wks = parseFloat(weeksRemainingAtDoc);
  if (!Number.isFinite(wks) || wks < 0) {
    throw new Error('INVALID_WEEKS');
  }
  if (wks > DEU_POLICY.TABLE_1_MAX_WEEKS) {
    throw new Error('DEU_RANGE_EXCEEDED');
  }
  const amt = parseFloat(amountToCommute);
  if (!Number.isFinite(amt) || amt < 0) {
    throw new Error('INVALID_AMOUNT');
  }

  // Step 2g: PV of all remaining PD at DOC.
  const pvRemainingAtDoc = Math.round(rate * getPvForWeeks(wks) * 100) / 100;

  // Step 3c: Commuted (undiscounted) value of all remaining PD =
  //   nominal total dollars still owed over the remaining weeks.
  const commutedValueAllPd = Math.round(wks * rate * 100) / 100;

  // Step 8c: Weeks eliminated by taking amountToCommute off the far end.
  const weeksEliminatedRaw = rate === 0 ? 0 : amt / rate;
  if (weeksEliminatedRaw > wks + 1e-9) {
    throw new Error('COMMUTE_AMOUNT_EXCEEDS_REMAINING_PD');
  }
  const weeksEliminated = Math.round(weeksEliminatedRaw * 10000) / 10000;

  // Step 6j: Weeks remaining after commutation.
  const weeksRemainingAfterCommutation = Math.round((wks - weeksEliminatedRaw) * 10000) / 10000;

  // Step 5c: PV of PD still owed after commutation (discounted at DOC).
  const pvRemainingAfterCommutation = Math.round(
    rate * getPvForWeeks(weeksRemainingAfterCommutation) * 100,
  ) / 100;

  // Step 4c: PV (at DOC) of the amount commuted off the far end =
  //   pvRemainingAtDoc - pvRemainingAfterCommutation.
  const pvOfAmountToCommute = Math.round(
    (pvRemainingAtDoc - pvRemainingAfterCommutation) * 100,
  ) / 100;

  // Step 7c: Nominal dollars still owed on the PD payment stream after commutation.
  const pdStillOwedAfterDoc = Math.round(
    weeksRemainingAfterCommutation * rate * 100,
  ) / 100;

  // Step 9: LC §5800 late-payment interest on the commuted amount.
  const interestOwed = computeLateInterest(amt, docDate, actualPayDate);

  return {
    pvRemainingAtDoc,
    commutedValueAllPd,
    pvOfAmountToCommute,
    pvRemainingAfterCommutation,
    weeksRemainingAfterCommutation,
    pdStillOwedAfterDoc,
    weeksEliminated,
    interestOwed,
  };
}

module.exports = {
  DEU_TABLE_1,
  DEU_POLICY,
  getPvForWeeks,
  getWeeksForPv,
  computeLateInterest,
  commutePdOffFarEnd,
};

'use strict';

/**
 * rfaService — M7 RFA Decision Pipeline.
 *
 * Orchestrates the full RFA lifecycle from receipt to decision:
 *   1. createRFA      — persist RFA, seed diary, trigger async AI evaluation
 *   2. evaluateRFA    — AI MTUS evaluation → route to correct outcome
 *   3. adjusterApproveRFA   — adjuster manually approves
 *   4. adjusterRouteToURO   — adjuster escalates to Enlyte URO
 *
 * Decision routing (_resolveDecision):
 *   - Surgical CPT codes (10000–69999 or Category III /^\d{4}T$/) → route_to_uro
 *   - AI recommends approval, MTUS-consistent                    → adjuster_review
 *   - AI MTUS-inconsistent                                        → route_to_uro
 *   - Otherwise (AI says physician_review, MTUS-consistent)       → adjuster_review
 *
 * DB columns follow the actual initial_schema.sql column names (not data-model.md).
 * Circular dependency with claimService avoided via lazy require.
 */

const { supabase }        = require('./supabase');
const config = require('../config');
const enlyte              = require('./enlyteService');
const logger              = require('../logger');
const { addBusinessDays } = require('../utils/businessDays');

// ── M22A WCIS SROI 4P hook — DEFERRED ────────────────────────────
// The revised M22A spec calls for a hook on "rfaService.denyRfa"
// that enqueues SROI 4P (Specific Benefit Denied) when
// payload_context.denies_benefit === true. That function does not
// exist in the current rfaService — the RFA lifecycle today is
// createRFA → evaluateRFA → (auto_approve | adjuster_review |
// route_to_uro), with URO handling denial determinations via
// Enlyte asynchronously.
//
// No WCIS trigger is wired from rfaService in M22A. When the URO
// decision return path is implemented (separate milestone), that
// is the natural hook point for SROI 4P:
//   On URO denial return → enqueueIfReportable('specific_benefit_denied',
//     ..., payload_context: { denied_benefit_codes: [...], source: 'uro' })
// The TRIGGER_EVENT_TO_MTC entry 'specific_benefit_denied' remains
// wired in wcisConstants so the wire-up in the URO-return milestone
// is drop-in.

// Lazy require to break circular dependency: rfaService ↔ claimService
function getClaimService() {
  return require('./claimService');
}

// Lazy require to avoid loading noticeService before it is fully initialised
function _getNoticeService() {
  return require('./noticeService');
}

// Fire-and-forget notice helper — logs errors, never throws
function _fireNotice(fn, ...args) {
  setImmediate(() => {
    fn(...args).catch(err =>
      logger.error({ msg: 'rfaService: notice trigger failed', fn: fn.name, err: err.message }),
    );
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if any CPT code is a surgical procedure.
 * Surgical = range 10000–69999 OR Category III codes (e.g. "0123T").
 */
function _isSurgical(cptCodes) {
  if (!Array.isArray(cptCodes) || cptCodes.length === 0) return false;
  return cptCodes.some(code => {
    const n = parseInt(code, 10);
    return (n >= 10000 && n <= 69999) || /^\d{4}T$/i.test(String(code));
  });
}

/**
 * Returns true if the claim's date of injury is within the last 30 days.
 */
function _isFirst30Days(dateOfInjury) {
  if (!dateOfInjury) return false;
  const daysSince = Math.floor(
    (Date.now() - new Date(dateOfInjury).getTime()) / (1000 * 60 * 60 * 24)
  );
  return daysSince < 30;
}

/**
 * Map AI output + claim context → internal routing decision.
 *
 * Returns one of: 'adjuster_review' | 'route_to_uro'
 */
function _resolveDecision(aiResult, rfa, claim) {
  // 1. Surgical CPT override — always goes to URO regardless of AI
  if (_isSurgical(rfa.cpt_codes || [])) {
    return 'route_to_uro';
  }
  // Approval is a human disposition. Missing or inconsistent evidence
  // must not be promoted to approval by a model recommendation.
  if (aiResult.mtusConsistency !== true) {
    return 'route_to_uro';
  }
  // MTUS-consistent recommendations always go to the adjuster queue.
  return 'adjuster_review';
}

/**
 * Calculate the statutory response deadline.
 * Expedited (CCR §9792.9.1): 72 hours from receipt.
 * Standard:                  5 business days from receipt.
 */
function _calcDeadline(receivedAt, urgency) {
  if (urgency === 'expedited') {
    return new Date(new Date(receivedAt).getTime() + 72 * 60 * 60 * 1000).toISOString();
  }
  return addBusinessDays(new Date(receivedAt), 5).toISOString();
}

/**
 * Build a minimal claim snapshot for logging / event data.
 */
function _claimSnapshot(claim) {
  return {
    claimNumber:  claim.claimNumber,
    dateOfInjury: claim.dateOfInjury,
    bodyPart:     claim.bodyPart,
    status:       claim.status,
  };
}

// ── Diary helpers ─────────────────────────────────────────────────────────────

async function _seedRFADiary(claimId, rfaId, deadline) {
  const row = {
    claim_id:           claimId,
    rfa_id:             rfaId,
    diary_type:         'RFA_RESPONSE_DUE',
    due_date:           deadline.split('T')[0],
    assigned_to:        config.adjuster.email,
    priority:           'HIGH',
    status:             'open',
    notes:              `RFA response due — CCR §9792.9.1. RFA ID: ${rfaId}`,
    auto_generated:     true,
    generated_by_event: 'rfa_received',
  };
  const { error } = await supabase.from('diaries').insert(row);
  if (error) {
    logger.error({ msg: 'rfaService._seedRFADiary: insert failed', error: error.message, rfaId });
  }
}

async function _completeRFADiary(claimId, rfaId) {
  const now = new Date().toISOString();
  const { data: diaries } = await supabase
    .from('diaries')
    .select('id')
    .eq('claim_id', claimId)
    .eq('rfa_id', rfaId)
    .eq('diary_type', 'RFA_RESPONSE_DUE')
    .eq('status', 'open');

  if (!diaries || diaries.length === 0) return;

  for (const d of diaries) {
    await supabase
      .from('diaries')
      .update({ status: 'completed', completed_at: now, completed_by: 'system', updated_at: now })
      .eq('id', d.id);
  }
}

// ── Outcome writers ───────────────────────────────────────────────────────────

async function _queueForAdjusterReview(rfaId, claimId, aiResult) {
  const now = new Date().toISOString();
  await supabase.from('rfas').update({
    decision:         'pending_adjuster_review',
    decision_made_at: now,
    decision_made_by: 'ai_system',
    updated_at:       now,
  }).eq('id', rfaId);

  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'rfa_received',
    timestamp: now,
    data:      {
      rfaId,
      decision:        'pending_adjuster_review',
      aiRecommendation: aiResult.recommendedAction,
      rationale:        aiResult.rationale,
    },
  });
  logger.info({ msg: 'rfaService: queued for adjuster review', rfaId, claimId });
}

async function _routeToEnlyte(rfaId, claimId, rfa, claim, aiResult, reason) {
  const now = new Date().toISOString();
  let referralId = null;

  try {
    const result = await enlyte.submitReferral(rfa, claim, reason || 'Routed by RFA decision engine');
    referralId = result.referralId;
    if (!referralId) throw new Error('URO did not confirm a referral ID');
  } catch (err) {
    logger.error({ msg: 'rfaService._routeToEnlyte: submitReferral failed', err: err.message, rfaId });
    throw new Error('URO referral failed; RFA remains unresolved and its response diary stays open');
  }

  await supabase.from('rfas').update({
    decision:          'sent_to_uro',
    decision_made_at:  now,
    decision_made_by:  'ai_system',
    enlyte_referral_id: referralId,
    enlyte_sent_at:    now,
    updated_at:        now,
  }).eq('id', rfaId);

  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'rfa_received',
    timestamp: now,
    data:      {
      rfaId,
      decision:         'sent_to_uro',
      enlyteReferralId: referralId,
      reason,
    },
  });
  logger.info({ msg: 'rfaService: routed to Enlyte URO', rfaId, claimId, referralId });
}

async function _deferRFA(rfaId, claimId, reason) {
  const now = new Date().toISOString();
  await supabase.from('rfas').update({
    decision:         'deferred',
    decision_made_at: now,
    decision_made_by: 'ai_system',
    updated_at:       now,
  }).eq('id', rfaId);

  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'rfa_received',
    timestamp: now,
    data:      { rfaId, decision: 'deferred', reason },
  });
  logger.info({ msg: 'rfaService: deferred', rfaId, claimId, reason });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Persist a new RFA, seed the statutory response-due diary, then trigger
 * async AI evaluation (via setImmediate so the HTTP response returns first).
 */
async function createRFA(claimId, rfaData, receivedVia) {
  const now       = new Date().toISOString();
  const urgency   = rfaData.urgency || 'standard';
  const deadline  = _calcDeadline(now, urgency);

  const rfaRow = {
    claim_id:             claimId,
    received_at:          now,
    received_via:         receivedVia || 'portal',
    requesting_physician: rfaData.requestingPhysician || null,
    requesting_npi:       rfaData.requestingNpi || null,
    treatment_description: rfaData.treatmentDescription,
    cpt_codes:            rfaData.cptCodes || [],
    icd10_codes:          rfaData.icd10Codes || [],
    urgency,
    response_due_at:      deadline,
    decision:             null,
    created_at:           now,
    updated_at:           now,
  };

  const { data: inserted, error } = await supabase
    .from('rfas')
    .insert(rfaRow)
    .select()
    .single();

  if (error || !inserted) {
    throw new Error(`rfaService.createRFA: DB insert failed — ${error?.message}`);
  }

  const rfaId = inserted.id;

  // Seed the statutory diary
  await _seedRFADiary(claimId, rfaId, deadline);

  // Log the claim event
  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'rfa_received',
    timestamp: now,
    data:      {
      rfaId,
      receivedVia,
      urgency,
      deadline,
      cptCodes:    rfaData.cptCodes || [],
      treatmentDescription: rfaData.treatmentDescription,
    },
  });

  logger.info({ msg: 'rfaService.createRFA: created', rfaId, claimId, urgency, deadline });

  // Trigger async AI evaluation — runs after HTTP response is sent
  setImmediate(() => evaluateRFA(rfaId).catch(err =>
    logger.error({ msg: 'RFA evaluation requires retry', rfaId, err: err.message })));

  return inserted;
}

/**
 * AI MTUS evaluation loop. Called asynchronously after createRFA.
 * Also callable directly by admin or for re-evaluation.
 */
async function evaluateRFA(rfaId) {
  const aiService = require('./aiService');

  // Fetch the RFA
  const { data: rfa, error: rfaErr } = await supabase
    .from('rfas')
    .select('*')
    .eq('id', rfaId)
    .single();

  if (rfaErr || !rfa) {
    logger.error({ msg: 'rfaService.evaluateRFA: RFA not found', rfaId });
    return;
  }

  // Fetch the claim
  const claim = await getClaimService().getClaim(rfa.claim_id);
  if (!claim) {
    logger.error({ msg: 'rfaService.evaluateRFA: claim not found', rfaId, claimId: rfa.claim_id });
    await _deferRFA(rfaId, rfa.claim_id, 'Claim not found — manual review required');
    return;
  }

  // Build RFA shape that aiService.evaluateRFA expects
  const rfaForAI = {
    acceptedDiagnosis:    claim.bodyPart,
    requestedTreatment:   rfa.treatment_description,
    requestedCptCodes:    rfa.cpt_codes || [],
    requestingPhysician:  rfa.requesting_physician,
    rfaReceivedDate:      rfa.received_at,
  };

  let aiResult;
  try {
    aiResult = await aiService.evaluateRFA(rfaForAI, claim);
  } catch (err) {
    logger.error({ msg: 'rfaService.evaluateRFA: AI call failed', err: err.message, rfaId });
    await _deferRFA(rfaId, rfa.claim_id, `AI evaluation failed: ${err.message}`);
    return;
  }

  // Persist the evaluation record
  const now = new Date().toISOString();
  await supabase.from('rfa_evaluations').insert({
    rfa_id:                  rfaId,
    mtus_consistent:         aiResult.mtusConsistency,
    within_frequency_limits: aiResult.withinFrequencyLimits ?? null,
    within_duration_limits:  aiResult.withinDurationLimits ?? null,
    formulary_status:        aiResult.formularyStatus || 'n_a',
    first_30_days:           _isFirst30Days(claim.dateOfInjury),
    surgical:                _isSurgical(rfa.cpt_codes || []),
    recommendation:          _resolveDecision(aiResult, rfa, claim),
    rationale:               aiResult.rationale,
    evaluated_at:            now,
  });

  // Route based on decision
  const decision = _resolveDecision(aiResult, rfa, claim);

  if (decision === 'adjuster_review') {
    await _queueForAdjusterReview(rfaId, rfa.claim_id, aiResult);
    // No notice yet — pending human decision
  } else if (decision === 'route_to_uro') {
    const reason = _isSurgical(rfa.cpt_codes || [])
      ? 'Surgical procedure — URO required per CCR §9792.6.1'
      : 'MTUS-inconsistent treatment — physician review required';
    await _routeToEnlyte(rfaId, rfa.claim_id, rfa, claim, aiResult, reason);
    // Referral is not a determination. Notices belong to a verified
    // physician determination return path, not submission.
  }
}

/**
 * Adjuster manually approves an RFA that was queued for review.
 */
async function adjusterApproveRFA(rfaId, adjusterEmail) {
  const now = new Date().toISOString();

  const { data: rfa } = await supabase.from('rfas').select('*').eq('id', rfaId).single();
  if (!rfa) return null;

  await supabase.from('rfas').update({
    decision:         'adjuster_approved',
    decision_made_at: now,
    decision_made_by: adjusterEmail,
    updated_at:       now,
  }).eq('id', rfaId);

  await supabase.from('claim_events').insert({
    claim_id:  rfa.claim_id,
    type:      'rfa_approved',
    timestamp: now,
    data:      { rfaId, decision: 'adjuster_approved', decidedBy: adjusterEmail },
  });

  await _completeRFADiary(rfa.claim_id, rfaId);
  _fireNotice(_getNoticeService().generateRfaLetter, rfaId);
  // Link the adjuster's action back to the most recent ai_decisions
  // row so the audit trail shows model rec → human override pairing.
  try {
    await require('./aiDecisionsService').linkHumanDecision(rfa.claim_id, 'rfa_mtus', {
      human_reviewer_id: null, human_decision: `adjuster_approved by ${adjusterEmail}`,
    });
  } catch { /* non-fatal */ }
  logger.info({ msg: 'rfaService.adjusterApproveRFA: approved', rfaId, adjusterEmail });

  return getRFA(rfaId);
}

/**
 * Adjuster manually escalates an RFA to Enlyte URO.
 */
async function adjusterRouteToURO(rfaId, adjusterEmail, reason) {
  const { data: rfa } = await supabase.from('rfas').select('*').eq('id', rfaId).single();
  if (!rfa) return null;

  const claim = await getClaimService().getClaim(rfa.claim_id);

  await _routeToEnlyte(rfaId, rfa.claim_id, rfa, claim, null, reason || 'Escalated by adjuster');

  // Update decision_made_by to reflect adjuster override
  const now = new Date().toISOString();
  await supabase.from('rfas').update({
    decision_made_by: adjusterEmail,
    updated_at: now,
  }).eq('id', rfaId);

  // Referral alone does not trigger determination or IMR notices.
  try {
    await require('./aiDecisionsService').linkHumanDecision(rfa.claim_id, 'rfa_mtus', {
      human_reviewer_id: null, human_decision: `routed_to_uro by ${adjusterEmail}`,
    });
  } catch { /* non-fatal */ }
  logger.info({ msg: 'rfaService.adjusterRouteToURO', rfaId, adjusterEmail });
  return getRFA(rfaId);
}

/**
 * Fetch a single RFA with its latest evaluation.
 */
async function getRFA(rfaId) {
  const { data: rfa, error } = await supabase
    .from('rfas')
    .select('*')
    .eq('id', rfaId)
    .single();

  if (error || !rfa) return null;

  // Attach latest evaluation
  const { data: evals } = await supabase
    .from('rfa_evaluations')
    .select('*')
    .eq('rfa_id', rfaId)
    .order('evaluated_at', { ascending: false })
    .limit(1);

  return { ...rfa, evaluation: evals?.[0] || null };
}

/**
 * List RFAs with optional filters.
 * @param {string|object} filters  claimId string (legacy) or { claimId, status }
 */
async function listRFAs(filters = {}) {
  const opts = typeof filters === 'string' ? { claimId: filters } : filters;
  const { claimId, status } = opts;

  let q = supabase.from('rfas').select('*').order('created_at', { ascending: false });
  if (claimId) q = q.eq('claim_id', claimId);
  if (status)  q = q.eq('decision', status);

  const { data, error } = await q;
  if (error) throw new Error(`rfaService.listRFAs: ${error.message}`);
  return data || [];
}

module.exports = {
  createRFA,
  evaluateRFA,
  adjusterApproveRFA,
  adjusterRouteToURO,
  getRFA,
  listRFAs,
  // Exported for testing
  _isSurgical,
  _isFirst30Days,
  _resolveDecision,
  _calcDeadline,
};

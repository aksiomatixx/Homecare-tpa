'use strict';

// ── Mock Supabase ─────────────────────────────────────────────────────────────
jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

/**
 * Integration tests — M7 RFA Decision Pipeline.
 *
 * Covers:
 *   POST /api/v1/rfas               — create RFA, deadline calc, diary seeding
 *   GET  /api/v1/rfas               — list RFAs for claim
 *   GET  /api/v1/rfas/:id           — get single RFA with evaluation
 *   POST /api/v1/rfas/:id/approve   — adjuster approval
 *   POST /api/v1/rfas/:id/route-to-uro — adjuster escalation
 *   rfaService._isSurgical          — CPT classification helper
 *   rfaService._resolveDecision     — routing logic unit tests
 *   rfaService.evaluateRFA          — full AI pipeline paths
 *
 * Run:
 *   npm test -- tests/integration/rfa-engine.test.js
 */

const request      = require('supertest');
const app          = require('../../src/index');
const { generateAdminToken } = require('../../src/middleware/auth');
const claimService = require('../../src/services/claimService');
const rfaService   = require('../../src/services/rfaService');
const aiService    = require('../../src/services/aiService');
const { supabase } = require('../../src/services/supabase');

jest.mock('../../src/services/aiService');
jest.mock('../../src/services/filehandler', () => ({
  setReserves:    jest.fn().mockResolvedValue({ status: 'ok' }),
  createClaim:    jest.fn().mockResolvedValue({ claimId: 'fh_mock', status: 'created' }),
  createDiary:    jest.fn().mockResolvedValue({ diaryId: 'diy_mock', status: 'created' }),
  completeDiary:  jest.fn().mockResolvedValue({ status: 'completed' }),
  attachDocument: jest.fn().mockResolvedValue({ documentId: 'doc_mock' }),
  getLedger:      jest.fn().mockResolvedValue({ entries: [] }),
  recordPayment:  jest.fn().mockResolvedValue({ paymentId: 'pay_mock' }),
}));
jest.mock('../../src/services/enlyteService', () => ({
  submitReferral:    jest.fn().mockResolvedValue({ referralId: 'ENL-MOCK-001', status: 'submitted', estimatedResponseAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() }),
  getReferralStatus: jest.fn().mockResolvedValue({ referralId: 'ENL-MOCK-001', status: 'pending', determination: null }),
}));

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });
const AUTH       = `Bearer ${adminToken}`;

const CLAIM_ID = 'claim_rfa_test_001';

// ── Default AI mock response ──────────────────────────────────────────────────
const AI_AUTO_APPROVE = {
  recommendedAction:      'auto_approve',
  mtusConsistency:        true,
  rationale:              'Physical therapy is MTUS-consistent for soft-tissue lumbar injuries within 30 days.',
  urgency:                'standard',
  requiresIMRNotice:      false,
  withinFrequencyLimits:  true,
  withinDurationLimits:   true,
  formularyStatus:        'n_a',
  notes:                  '',
};

const AI_PHYSICIAN_REVIEW_MTUS_CONSISTENT = {
  recommendedAction:      'physician_review',
  mtusConsistency:        true,
  rationale:              'Treatment exceeds 30 days — physician review required.',
  urgency:                'standard',
  requiresIMRNotice:      false,
  withinFrequencyLimits:  true,
  withinDurationLimits:   false,
  formularyStatus:        'n_a',
  notes:                  '',
};

const AI_PHYSICIAN_REVIEW_MTUS_INCONSISTENT = {
  recommendedAction:      'physician_review',
  mtusConsistency:        false,
  rationale:              'MRI not indicated per MTUS — no red flags documented.',
  urgency:                'standard',
  requiresIMRNotice:      false,
  withinFrequencyLimits:  false,
  withinDurationLimits:   false,
  formularyStatus:        'n_a',
  notes:                  '',
};

// ── Seed helpers ──────────────────────────────────────────────────────────────
function seedClaim() {
  return claimService._seedClaim({
    id:                CLAIM_ID,
    claimNumber:       'HHW-2026-RFA01',
    employerId:        'employer-test',
    status:            'active_medical',
    dateOfInjury:      '2026-04-01',
    bodyPart:          'Lower Back',
    injuryType:        'Strain',
    injuryDescription: 'Patient injured lower back while lifting.',
    aww:               900,
    tdRate:            600,
    filehandlerId:     'fh_mock_rfa',
    aiAnalysis:        null,
    priority:          null,
    createdAt:         new Date().toISOString(),
    updatedAt:         new Date().toISOString(),
    employee: {
      adpEmployeeId: 'EMP-RFA-001',
      firstName:     'Jane',
      lastName:      'Worker',
      dob:           '1985-03-10',
    },
    events:  [],
    diaries: [],
  });
}

async function seedRFAInStore(overrides = {}) {
  const row = {
    id:                    'rfa_test_001',
    claim_id:              CLAIM_ID,
    received_at:           new Date().toISOString(),
    received_via:          'portal',
    requesting_physician:  'Dr. Smith',
    treatment_description: 'Physical therapy — 12 sessions',
    cpt_codes:             ['97110', '97014'],
    icd10_codes:           ['M54.5'],
    urgency:               'standard',
    response_due_at:       new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    decision:              null,
    created_at:            new Date().toISOString(),
    updated_at:            new Date().toISOString(),
    ...overrides,
  };
  await supabase.from('rfas').insert(row);
  return row;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
beforeEach(() => {
  supabase._resetStore(['rfas', 'rfa_evaluations', 'diaries', 'claim_events']);
  aiService.evaluateRFA.mockResolvedValue(AI_AUTO_APPROVE);
  seedClaim();
});

afterEach(() => {
  jest.clearAllMocks();
});

// =============================================================================
// ── 1. Helper unit tests ──────────────────────────────────────────────────────
// =============================================================================

describe('rfaService._isSurgical', () => {
  test('returns false for empty array', () => {
    expect(rfaService._isSurgical([])).toBe(false);
  });

  test('returns false for non-surgical therapy codes', () => {
    expect(rfaService._isSurgical(['97110', '97014', '97012'])).toBe(false);
  });

  test('returns true for surgical range 10000–69999', () => {
    expect(rfaService._isSurgical(['27447'])).toBe(true); // Total knee arthroplasty
  });

  test('returns true for lower surgical range boundary (10000)', () => {
    expect(rfaService._isSurgical(['10000'])).toBe(true);
  });

  test('returns true for upper surgical range boundary (69999)', () => {
    expect(rfaService._isSurgical(['69999'])).toBe(true);
  });

  test('returns false for E&M code just below surgical range', () => {
    expect(rfaService._isSurgical(['99213'])).toBe(false);
  });

  test('returns true for Category III code (e.g. 0123T)', () => {
    expect(rfaService._isSurgical(['0123T'])).toBe(true);
  });

  test('returns true for mixed array containing one surgical code', () => {
    expect(rfaService._isSurgical(['97110', '27447', '97014'])).toBe(true);
  });

  test('returns false for null/undefined (defensive)', () => {
    expect(rfaService._isSurgical(null)).toBe(false);
    expect(rfaService._isSurgical(undefined)).toBe(false);
  });
});

// =============================================================================
// ── 2. _resolveDecision unit tests ───────────────────────────────────────────
// =============================================================================

describe('rfaService._resolveDecision', () => {
  const claim = { dateOfInjury: '2026-04-01', bodyPart: 'Lower Back' };

  test('surgical CPT → route_to_uro regardless of AI recommendation', () => {
    const rfa = { cpt_codes: ['27447'] };
    expect(rfaService._resolveDecision(AI_AUTO_APPROVE, rfa, claim)).toBe('route_to_uro');
  });

  test('surgical Category III CPT → route_to_uro', () => {
    const rfa = { cpt_codes: ['0123T'] };
    expect(rfaService._resolveDecision(AI_AUTO_APPROVE, rfa, claim)).toBe('route_to_uro');
  });

  test('AI auto_approve + MTUS consistent → human review', () => {
    const rfa = { cpt_codes: ['97110'] };
    expect(rfaService._resolveDecision(AI_AUTO_APPROVE, rfa, claim)).toBe('adjuster_review');
  });

  test('AI physician_review + MTUS consistent → adjuster_review', () => {
    const rfa = { cpt_codes: ['97110'] };
    expect(rfaService._resolveDecision(AI_PHYSICIAN_REVIEW_MTUS_CONSISTENT, rfa, claim)).toBe('adjuster_review');
  });

  test('AI physician_review + MTUS inconsistent → route_to_uro', () => {
    const rfa = { cpt_codes: ['97110'] };
    expect(rfaService._resolveDecision(AI_PHYSICIAN_REVIEW_MTUS_INCONSISTENT, rfa, claim)).toBe('route_to_uro');
  });
});

// =============================================================================
// ── 3. _calcDeadline unit tests ───────────────────────────────────────────────
// =============================================================================

describe('rfaService._calcDeadline', () => {
  test('expedited: deadline is 72 hours from now', () => {
    const now      = new Date().toISOString();
    const deadline = rfaService._calcDeadline(now, 'expedited');
    const diffHours = (new Date(deadline) - new Date(now)) / (1000 * 60 * 60);
    expect(diffHours).toBeCloseTo(72, 0);
  });

  test('standard: deadline is approximately 5 business days', () => {
    const now      = new Date().toISOString();
    const deadline = rfaService._calcDeadline(now, 'standard');
    const diffDays = (new Date(deadline) - new Date(now)) / (1000 * 60 * 60 * 24);
    // 5 business days = 5–9 calendar days depending on weekends
    expect(diffDays).toBeGreaterThanOrEqual(5);
    expect(diffDays).toBeLessThanOrEqual(11);
  });
});

// =============================================================================
// ── 4. POST /api/v1/rfas — Create RFA ────────────────────────────────────────
// =============================================================================

describe('POST /api/v1/rfas', () => {
  test('creates RFA and returns 201 with id and deadline', async () => {
    const res = await request(app)
      .post('/api/v1/rfas')
      .set('Authorization', AUTH)
      .send({
        claimId:              CLAIM_ID,
        treatmentDescription: 'Physical therapy — 12 sessions',
        cptCodes:             ['97110', '97014'],
        icd10Codes:           ['M54.5'],
        requestingPhysician:  'Dr. Smith',
        urgency:              'standard',
        receivedVia:          'fax',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.claim_id).toBe(CLAIM_ID);
    expect(res.body.response_due_at).toBeTruthy();
    expect(res.body.decision).toBeNull();
  });

  test('returns 400 when treatmentDescription is missing', async () => {
    const res = await request(app)
      .post('/api/v1/rfas')
      .set('Authorization', AUTH)
      .send({ claimId: CLAIM_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  test('returns 400 when claimId is missing', async () => {
    const res = await request(app)
      .post('/api/v1/rfas')
      .set('Authorization', AUTH)
      .send({ treatmentDescription: 'PT sessions' });

    expect(res.status).toBe(400);
  });

  test('returns 401 when no auth token', async () => {
    const res = await request(app)
      .post('/api/v1/rfas')
      .send({ claimId: CLAIM_ID, treatmentDescription: 'PT sessions' });

    expect(res.status).toBe(401);
  });

  test('expedited RFA has 72-hour deadline', async () => {
    const before = Date.now();
    const res = await request(app)
      .post('/api/v1/rfas')
      .set('Authorization', AUTH)
      .send({
        claimId:              CLAIM_ID,
        treatmentDescription: 'Emergency surgery',
        cptCodes:             ['27447'],
        urgency:              'expedited',
      });

    expect(res.status).toBe(201);
    const deadline = new Date(res.body.response_due_at).getTime();
    const diffHours = (deadline - before) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThan(71);
    expect(diffHours).toBeLessThan(73);
  });

  test('seeds RFA_RESPONSE_DUE diary after creation', async () => {
    await request(app)
      .post('/api/v1/rfas')
      .set('Authorization', AUTH)
      .send({
        claimId:              CLAIM_ID,
        treatmentDescription: 'Physical therapy',
        cptCodes:             ['97110'],
        urgency:              'standard',
      });

    const { data: diaries } = await supabase
      .from('diaries')
      .select('*')
      .eq('claim_id', CLAIM_ID)
      .eq('diary_type', 'RFA_RESPONSE_DUE');

    // Diary must exist; status may be 'open' or 'completed' depending on
    // whether the async evaluateRFA fired before this assertion
    expect(diaries.length).toBeGreaterThan(0);
    expect(['open', 'completed']).toContain(diaries[0].status);
  });

  test('logs rfa_received claim_event after creation', async () => {
    await request(app)
      .post('/api/v1/rfas')
      .set('Authorization', AUTH)
      .send({
        claimId:              CLAIM_ID,
        treatmentDescription: 'Physical therapy',
        cptCodes:             ['97110'],
        urgency:              'standard',
      });

    const { data: events } = await supabase
      .from('claim_events')
      .select('*')
      .eq('claim_id', CLAIM_ID)
      .eq('type', 'rfa_received');

    expect(events.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// ── 5. GET /api/v1/rfas — List RFAs ──────────────────────────────────────────
// =============================================================================

describe('GET /api/v1/rfas', () => {
  test('returns empty list when no RFAs exist for claim', async () => {
    const res = await request(app)
      .get('/api/v1/rfas')
      .set('Authorization', AUTH)
      .query({ claimId: CLAIM_ID });

    expect(res.status).toBe(200);
    expect(res.body.rfas).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  test('returns seeded RFAs for claim', async () => {
    await seedRFAInStore();
    const res = await request(app)
      .get('/api/v1/rfas')
      .set('Authorization', AUTH)
      .query({ claimId: CLAIM_ID });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.rfas[0].id).toBe('rfa_test_001');
  });

  test('returns 400 when claimId is missing', async () => {
    const res = await request(app)
      .get('/api/v1/rfas')
      .set('Authorization', AUTH);

    expect(res.status).toBe(400);
  });

  test('returns 401 without auth', async () => {
    const res = await request(app)
      .get('/api/v1/rfas')
      .query({ claimId: CLAIM_ID });

    expect(res.status).toBe(401);
  });
});

// =============================================================================
// ── 6. GET /api/v1/rfas/:id — Get single RFA ─────────────────────────────────
// =============================================================================

describe('GET /api/v1/rfas/:id', () => {
  test('returns RFA with evaluation field', async () => {
    await seedRFAInStore();
    const res = await request(app)
      .get('/api/v1/rfas/rfa_test_001')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('rfa_test_001');
    expect(res.body).toHaveProperty('evaluation');
  });

  test('returns 404 for non-existent RFA', async () => {
    const res = await request(app)
      .get('/api/v1/rfas/rfa_nonexistent')
      .set('Authorization', AUTH);

    expect(res.status).toBe(404);
  });
});

// =============================================================================
// ── 7. POST /api/v1/rfas/:id/approve — Adjuster approve ──────────────────────
// =============================================================================

describe('POST /api/v1/rfas/:id/approve', () => {
  test('approves a pending RFA and returns adjuster_approved decision', async () => {
    await seedRFAInStore({ decision: 'pending_adjuster_review' });

    const res = await request(app)
      .post('/api/v1/rfas/rfa_test_001/approve')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('adjuster_approved');
  });

  test('returns 404 for non-existent RFA', async () => {
    const res = await request(app)
      .post('/api/v1/rfas/rfa_nonexistent/approve')
      .set('Authorization', AUTH);

    expect(res.status).toBe(404);
  });

  test('logs rfa_approved claim_event on approval', async () => {
    await seedRFAInStore({ decision: 'pending_adjuster_review' });

    await request(app)
      .post('/api/v1/rfas/rfa_test_001/approve')
      .set('Authorization', AUTH);

    const { data: events } = await supabase
      .from('claim_events')
      .select('*')
      .eq('claim_id', CLAIM_ID)
      .eq('type', 'rfa_approved');

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].data.decision).toBe('adjuster_approved');
  });
});

// =============================================================================
// ── 8. POST /api/v1/rfas/:id/route-to-uro — Adjuster escalation ──────────────
// =============================================================================

describe('POST /api/v1/rfas/:id/route-to-uro', () => {
  test('routes to URO and returns sent_to_uro decision', async () => {
    await seedRFAInStore({ decision: 'pending_adjuster_review' });

    const res = await request(app)
      .post('/api/v1/rfas/rfa_test_001/route-to-uro')
      .set('Authorization', AUTH)
      .send({ reason: 'Complex case — adjuster escalating' });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('sent_to_uro');
    expect(res.body.enlyte_referral_id).toBeTruthy();
  });

  test('calls enlyteService.submitReferral', async () => {
    const enlyte = require('../../src/services/enlyteService');
    await seedRFAInStore({ decision: 'pending_adjuster_review' });

    await request(app)
      .post('/api/v1/rfas/rfa_test_001/route-to-uro')
      .set('Authorization', AUTH)
      .send({ reason: 'Adjuster escalation' });

    expect(enlyte.submitReferral).toHaveBeenCalledTimes(1);
  });

  test('returns 404 for non-existent RFA', async () => {
    const res = await request(app)
      .post('/api/v1/rfas/rfa_nonexistent/route-to-uro')
      .set('Authorization', AUTH)
      .send({ reason: 'test' });

    expect(res.status).toBe(404);
  });
});

// =============================================================================
// ── 9. evaluateRFA — AI pipeline paths ───────────────────────────────────────
// =============================================================================

describe('rfaService.evaluateRFA — auto_approve path', () => {
  test('requires human approval when AI recommends it and codes are not surgical', async () => {
    aiService.evaluateRFA.mockResolvedValueOnce(AI_AUTO_APPROVE);

    const rfa = await seedRFAInStore({
      id:        'rfa_eval_auto',
      cpt_codes: ['97110', '97014'],
    });

    await rfaService.evaluateRFA('rfa_eval_auto');

    const { data: updated } = await supabase
      .from('rfas').select('*').eq('id', 'rfa_eval_auto').single();

    expect(updated.decision).toBe('pending_adjuster_review');
    expect(updated.decision_made_by).toBe('ai_system');
  });

  test('creates rfa_evaluation row after auto-approve', async () => {
    aiService.evaluateRFA.mockResolvedValueOnce(AI_AUTO_APPROVE);
    await seedRFAInStore({ id: 'rfa_eval_auto2', cpt_codes: ['97110'] });

    await rfaService.evaluateRFA('rfa_eval_auto2');

    const { data: evals } = await supabase
      .from('rfa_evaluations').select('*').eq('rfa_id', 'rfa_eval_auto2');

    expect(evals.length).toBe(1);
    expect(evals[0].mtus_consistent).toBe(true);
    expect(evals[0].recommendation).toBe('adjuster_review');
  });

  test('keeps the RFA_RESPONSE_DUE diary open until human approval', async () => {
    aiService.evaluateRFA.mockResolvedValueOnce(AI_AUTO_APPROVE);
    await seedRFAInStore({ id: 'rfa_eval_diary', cpt_codes: ['97110'] });

    // Seed a diary to be completed
    await supabase.from('diaries').insert({
      id:         'diary_rfa_001',
      claim_id:   CLAIM_ID,
      diary_type: 'RFA_RESPONSE_DUE',
      due_date:   new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      status:     'open',
    });

    await rfaService.evaluateRFA('rfa_eval_diary');

    const { data: diary } = await supabase
      .from('diaries').select('*').eq('id', 'diary_rfa_001').single();

    expect(diary.status).toBe('open');
  });
});

describe('rfaService.evaluateRFA — adjuster_review path', () => {
  test('sets decision to pending_adjuster_review when MTUS-consistent but not auto_approve', async () => {
    aiService.evaluateRFA.mockResolvedValueOnce(AI_PHYSICIAN_REVIEW_MTUS_CONSISTENT);
    await seedRFAInStore({ id: 'rfa_eval_adj', cpt_codes: ['97110'] });

    await rfaService.evaluateRFA('rfa_eval_adj');

    const { data: updated } = await supabase
      .from('rfas').select('*').eq('id', 'rfa_eval_adj').single();

    expect(updated.decision).toBe('pending_adjuster_review');
  });

  test('creates rfa_evaluation with adjuster_review recommendation', async () => {
    aiService.evaluateRFA.mockResolvedValueOnce(AI_PHYSICIAN_REVIEW_MTUS_CONSISTENT);
    await seedRFAInStore({ id: 'rfa_eval_adj2', cpt_codes: ['97110'] });

    await rfaService.evaluateRFA('rfa_eval_adj2');

    const { data: evals } = await supabase
      .from('rfa_evaluations').select('*').eq('rfa_id', 'rfa_eval_adj2');

    expect(evals[0].recommendation).toBe('adjuster_review');
  });
});

describe('rfaService.evaluateRFA — route_to_uro path', () => {
  test('routes to Enlyte when CPT codes are surgical (overrides AI)', async () => {
    aiService.evaluateRFA.mockResolvedValueOnce(AI_AUTO_APPROVE);
    await seedRFAInStore({ id: 'rfa_eval_surg', cpt_codes: ['27447'] });

    await rfaService.evaluateRFA('rfa_eval_surg');

    const { data: updated } = await supabase
      .from('rfas').select('*').eq('id', 'rfa_eval_surg').single();

    expect(updated.decision).toBe('sent_to_uro');
    expect(updated.enlyte_referral_id).toBeTruthy();
  });

  test('routes to URO when AI says MTUS-inconsistent', async () => {
    aiService.evaluateRFA.mockResolvedValueOnce(AI_PHYSICIAN_REVIEW_MTUS_INCONSISTENT);
    await seedRFAInStore({ id: 'rfa_eval_incons', cpt_codes: ['97110'] });

    await rfaService.evaluateRFA('rfa_eval_incons');

    const { data: updated } = await supabase
      .from('rfas').select('*').eq('id', 'rfa_eval_incons').single();

    expect(updated.decision).toBe('sent_to_uro');
  });

  test('creates evaluation with route_to_uro recommendation for surgical', async () => {
    aiService.evaluateRFA.mockResolvedValueOnce(AI_AUTO_APPROVE);
    await seedRFAInStore({ id: 'rfa_eval_surg2', cpt_codes: ['27447'] });

    await rfaService.evaluateRFA('rfa_eval_surg2');

    const { data: evals } = await supabase
      .from('rfa_evaluations').select('*').eq('rfa_id', 'rfa_eval_surg2');

    expect(evals[0].recommendation).toBe('route_to_uro');
    expect(evals[0].surgical).toBe(true);
  });
});

describe('rfaService.evaluateRFA — error paths', () => {
  test('defers RFA when AI service throws', async () => {
    aiService.evaluateRFA.mockRejectedValueOnce(new Error('API timeout'));
    await seedRFAInStore({ id: 'rfa_eval_err', cpt_codes: ['97110'] });

    await rfaService.evaluateRFA('rfa_eval_err');

    const { data: updated } = await supabase
      .from('rfas').select('*').eq('id', 'rfa_eval_err').single();

    expect(updated.decision).toBe('deferred');
  });

  test('handles non-existent RFA gracefully', async () => {
    await expect(rfaService.evaluateRFA('rfa_nonexistent')).resolves.toBeUndefined();
  });
});

describe('pilot readiness regressions', () => {
  test('approval closes only the matching RFA diary', async () => {
    await seedRFAInStore({ id: 'rfa_scope_a' });
    await seedRFAInStore({ id: 'rfa_scope_b' });
    await supabase.from('diaries').insert([
      { id: 'scope_a', claim_id: CLAIM_ID, rfa_id: 'rfa_scope_a', diary_type: 'RFA_RESPONSE_DUE', status: 'open' },
      { id: 'scope_b', claim_id: CLAIM_ID, rfa_id: 'rfa_scope_b', diary_type: 'RFA_RESPONSE_DUE', status: 'open' },
      { id: 'scope_legacy', claim_id: CLAIM_ID, diary_type: 'RFA_RESPONSE_DUE', status: 'open' },
    ]);
    await rfaService.adjusterApproveRFA('rfa_scope_a', 'reviewer@example.test');
    const { data } = await supabase.from('diaries').select('*');
    expect(data.find(d => d.id === 'scope_a').status).toBe('completed');
    expect(data.find(d => d.id === 'scope_b').status).toBe('open');
    expect(data.find(d => d.id === 'scope_legacy').status).toBe('open');
  });

  test('vendor outage does not produce a sent referral', async () => {
    await seedRFAInStore({ id: 'rfa_outage' });
    require('../../src/services/enlyteService').submitReferral.mockRejectedValueOnce(new Error('offline'));
    await expect(rfaService.adjusterRouteToURO('rfa_outage', 'reviewer@example.test')).rejects.toThrow('URO referral failed');
    const rfa = await rfaService.getRFA('rfa_outage');
    expect(rfa.decision).toBeNull();
    expect(rfa.enlyte_sent_at).toBeUndefined();
  });

  test('contradictory model approval routes to physician review', () => {
    expect(rfaService._resolveDecision({ recommendedAction: 'auto_approve', mtusConsistency: false }, { cpt_codes: ['97110'] }, {})).toBe('route_to_uro');
  });
});

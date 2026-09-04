'use strict';

/**
 * noticeService.test.js
 *
 * Tests two concerns:
 *
 * A) TRIGGER WIRING — verifies that claimService and rfaService call the
 *    correct noticeService functions at the right moments.  Real services
 *    are used; only their external dependencies (Supabase, ADP, FileHandler,
 *    AI, Enlyte, Lob) are mocked.  noticeService methods are spied on so
 *    their real PDF/DB logic is bypassed.
 *
 * B) NOTICE GUARD — verifies that generateDenialNotice throws synchronously
 *    when adjusterId is absent, making auto-trigger impossible.
 *
 * C) NOTICES TABLE WRITES — verifies that each notice generator writes a row
 *    to the `notices` table.  Because _drawIABlock is called synchronously
 *    before the DB write, a successful insert confirms the I&A block ran.
 */

// ── External-dependency mocks (must precede all service imports) ──────────────

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

jest.mock('../../src/services/lobService', () => ({
  sendLetter: jest.fn().mockResolvedValue({
    letterId:         'ltr_MOCK-test',
    status:           'queued',
    estimatedDelivery:'2026-04-25',
  }),
  getLetterStatus: jest.fn().mockResolvedValue({ letterId: 'ltr_MOCK-test', status: 'in_transit' }),
}));

jest.mock('../../src/services/adp', () => ({
  getEmployeeWithFinancials: jest.fn().mockResolvedValue({
    firstName:        'Maria',
    lastName:         'Santos',
    dob:              '1981-03-15',
    associateOID:     'aoid-ns-001',
    address:          { line1: '1234 Main St', city: 'Los Angeles', state: 'CA', zip: '90001' },
    phone:            '2135551234',
    jobTitle:         'Home Health Aide',
    hireDate:         '2020-01-01',
    aww:              750.75,
    tdRate:           500.50,
    weeksCalculated:  26,
    payStatements:    [],
  }),
}));

jest.mock('../../src/services/filehandler', () => ({
  createClaim:  jest.fn().mockResolvedValue({ claimId: 'fh-mock-ns-001', status: 'active' }),
  setReserves:  jest.fn().mockResolvedValue({}),
}));

jest.mock('../../src/services/aiService', () => ({
  analyzeCompensability: jest.fn().mockResolvedValue({
    compensability:            'Likely Compensable',
    compensabilityScore:       85,
    priority:                  'High',
    suggestedMedicalReserve:   10000,
    suggestedIndemnityReserve: 8000,
    suggestedExpenseReserve:   1000,
    redFlags:                  [],
    nextActions:               [],
    rationale:                 'Mock',
  }),
  // Default: returns auto_approve — individual tests override this
  evaluateRFA: jest.fn().mockResolvedValue({
    mtusConsistency:       true,
    withinFrequencyLimits: true,
    withinDurationLimits:  true,
    formularyStatus:       'n_a',
    recommendedAction:     'auto_approve',
    rationale:             'MTUS consistent — mock',
  }),
  _callClaude: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../src/services/enlyteService', () => ({
  submitReferral: jest.fn().mockResolvedValue({
    referralId:          'ENL-MOCK-ns-001',
    status:              'submitted',
    estimatedResponseAt: '2026-05-01T00:00:00.000Z',
  }),
  getReferralStatus: jest.fn().mockResolvedValue({ referralId: 'ENL-MOCK-ns-001', status: 'pending', determination: null }),
}));

// ── Service imports ───────────────────────────────────────────────────────────

const noticeService = require('../../src/services/noticeService');
const claimService  = require('../../src/services/claimService');
const rfaService    = require('../../src/services/rfaService');
const aiService     = require('../../src/services/aiService');
const { supabase }  = require('../../src/services/supabase');

// ── Shared test fixtures ──────────────────────────────────────────────────────

const MOCK_CLAIM = {
  id:          'claim-ns-test-001',
  claimNumber: 'HHW-2026-NS1',
  employee: {
    firstName: 'Maria',
    lastName:  'Santos',
    address:   { line1: '1234 Main St', city: 'Los Angeles', state: 'CA', zip: '90001' },
  },
  dateOfInjury:    '2026-01-15',
  bodyPart:        'Lower Back',
  injuryType:      'Strain',
  employerName:    'BrightCare Home Health',
  filed_at:        '2026-01-16T00:00:00.000Z',
  createdAt:       '2026-01-16T00:00:00.000Z',
  aww:             750.75,
  tdRate:          500.50,
};

const MOCK_RFA = {
  id:                   'rfa-ns-test-001',
  claim_id:             'claim-ns-test-001',
  treatment_description:'Physical therapy x 12 visits',
  cpt_codes:            ['97110'],
  icd10_codes:          ['M54.5'],
  urgency:              'standard',
  received_at:          '2026-02-01T00:00:00.000Z',
  created_at:           '2026-02-01T00:00:00.000Z',
  updated_at:           '2026-02-01T00:00:00.000Z',
  response_due_at:      '2026-02-06T17:00:00.000Z',
  decision:             null,
  requesting_physician: 'Dr. Lee',
  requesting_npi:       '1234567890',
  evaluation:           null,
};

// ── Drain all queued setImmediate callbacks ───────────────────────────────────
// Two drains handle: (1) the setImmediate registered by the service, and
// (2) any setImmediate registered inside those callbacks (nested).
async function drainSetImmediates() {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

// ═══════════════════════════════════════════════════════════════════════════
// A) TRIGGER WIRING
// ═══════════════════════════════════════════════════════════════════════════

describe('Trigger wiring — claimService', () => {
  let dwc7Spy;

  beforeEach(() => {
    claimService._resetClaims();
    dwc7Spy = jest.spyOn(noticeService, 'generateDwc7').mockResolvedValue(null);
  });

  afterEach(() => {
    dwc7Spy.mockRestore();
  });

  it('generateDwc7 is called after claim creation', async () => {
    await claimService.createClaim(
      {
        adpEmployeeId:     'BC-001',
        dateOfInjury:      '2026-01-15',
        bodyPart:          'Lower Back',
        injuryType:        'Strain',
        injuryDescription: 'Injured while assisting patient',
        employerName:      'BrightCare Home Health',
      },
      'employer-brightcare-001',
    );

    await drainSetImmediates();

    expect(dwc7Spy).toHaveBeenCalledTimes(1);
    expect(dwc7Spy).toHaveBeenCalledWith(expect.stringMatching(/^claim_/));
  });
});

describe('Trigger wiring — rfaService', () => {
  let rfaLtrSpy, imrSpy;

  beforeEach(async () => {
    claimService._resetClaims();
    // Seed the claim so rfaService can fetch it
    claimService._seedClaim({ ...MOCK_CLAIM });
    // Seed the RFA into the supabase mock store
    supabase._resetStore(['rfas', 'rfa_evaluations', 'diaries', 'claim_events', 'notices', 'audit_log']);
    await supabase.from('rfas').insert(MOCK_RFA);

    rfaLtrSpy = jest.spyOn(noticeService, 'generateRfaLetter').mockResolvedValue(null);
    imrSpy    = jest.spyOn(noticeService, 'generateImrRightsNotice').mockResolvedValue(null);
  });

  afterEach(() => {
    rfaLtrSpy.mockRestore();
    imrSpy.mockRestore();
    aiService.evaluateRFA.mockResolvedValue({
      mtusConsistency:       true,
      withinFrequencyLimits: true,
      withinDurationLimits:  true,
      formularyStatus:       'n_a',
      recommendedAction:     'auto_approve',
      rationale:             'MTUS consistent — mock',
    });
  });

  it('an AI approval recommendation does not send a determination', async () => {
    // Default mock already returns auto_approve
    await rfaService.evaluateRFA(MOCK_RFA.id);
    await drainSetImmediates();

    expect(rfaLtrSpy).not.toHaveBeenCalled();
    expect(imrSpy).not.toHaveBeenCalled();
  });

  it('a referral does not send a determination', async () => {
    aiService.evaluateRFA.mockResolvedValue({
      mtusConsistency:   false,
      recommendedAction: 'physician_review',
      rationale:         'MTUS inconsistent — mock',
    });

    await rfaService.evaluateRFA(MOCK_RFA.id);
    await drainSetImmediates();

    expect(rfaLtrSpy).not.toHaveBeenCalled();
  });

  it('a referral does not send IMR rights before a physician determination', async () => {
    aiService.evaluateRFA.mockResolvedValue({
      mtusConsistency:   false,
      recommendedAction: 'physician_review',
      rationale:         'MTUS inconsistent — mock',
    });

    await rfaService.evaluateRFA(MOCK_RFA.id);
    await drainSetImmediates();

    expect(imrSpy).not.toHaveBeenCalled();
  });

  it('generateImrRightsNotice is NOT called on an auto_approve decision', async () => {
    // Default mock returns auto_approve
    await rfaService.evaluateRFA(MOCK_RFA.id);
    await drainSetImmediates();

    expect(imrSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B) DENIAL GUARD
// ═══════════════════════════════════════════════════════════════════════════

describe('generateDenialNotice — manual-only guard', () => {
  it('throws synchronously when adjusterId is undefined', async () => {
    await expect(noticeService.generateDenialNotice('claim-001', undefined))
      .rejects.toThrow('adjusterId is required');
  });

  it('throws synchronously when adjusterId is an empty string', async () => {
    await expect(noticeService.generateDenialNotice('claim-001', ''))
      .rejects.toThrow('adjusterId is required');
  });

  it('throws synchronously when adjusterId is whitespace only', async () => {
    await expect(noticeService.generateDenialNotice('claim-001', '   '))
      .rejects.toThrow('adjusterId is required');
  });

  it('auto-trigger guard: a system call without adjusterId always throws', async () => {
    // Simulate a system path that forgets to pass adjusterId — must never produce a notice
    const systemTrigger = () => noticeService.generateDenialNotice('claim-001');
    await expect(systemTrigger()).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C) NOTICES TABLE WRITES + DWC I&A BLOCK INVARIANT
// ═══════════════════════════════════════════════════════════════════════════
//
// _drawIABlock is called synchronously inside each generator before the DB
// write.  If a `notices` row is present in the mock store after the call,
// _drawIABlock executed — the I&A block was rendered.

describe('notices table writes', () => {
  let getClaim, getRFA;

  beforeEach(() => {
    supabase._resetStore(['notices', 'audit_log']);
    // Spy on the lazy-required claimService.getClaim so noticeService finds the claim
    getClaim = jest.spyOn(claimService, 'getClaim').mockResolvedValue({ ...MOCK_CLAIM });
    getRFA   = jest.spyOn(rfaService,   'getRFA'  ).mockResolvedValue({ ...MOCK_RFA });
  });

  afterEach(() => {
    getClaim.mockRestore();
    getRFA.mockRestore();
  });

  it('DWC-7: inserts a notices row with notice_type=dwc7 (confirms I&A block ran)', async () => {
    await noticeService.generateDwc7(MOCK_CLAIM.id);

    const { data: rows } = await supabase.from('notices').select('*').eq('claim_id', MOCK_CLAIM.id);
    const row = rows.find(r => r.notice_type === 'dwc7');
    expect(row).toBeDefined();
    expect(row.lob_letter_id).toBe('ltr_MOCK-test');
  });

  it('TD benefit: inserts a notices row with notice_type=td_benefit (confirms I&A block ran)', async () => {
    await noticeService.generateTdNotice(MOCK_CLAIM.id);

    const { data: rows } = await supabase.from('notices').select('*').eq('claim_id', MOCK_CLAIM.id);
    const row = rows.find(r => r.notice_type === 'td_benefit');
    expect(row).toBeDefined();
    expect(row.lob_letter_id).toBe('ltr_MOCK-test');
  });

  it('RFA determination: inserts a notices row with notice_type=rfa_determination (confirms I&A block ran)', async () => {
    await noticeService.generateRfaLetter(MOCK_RFA.id);

    const { data: rows } = await supabase.from('notices').select('*').eq('claim_id', MOCK_CLAIM.id);
    const row = rows.find(r => r.notice_type === 'rfa_determination');
    expect(row).toBeDefined();
    expect(row.lob_letter_id).toBe('ltr_MOCK-test');
  });

  it('IMR rights: inserts a notices row with notice_type=imr_rights (confirms I&A block ran)', async () => {
    await noticeService.generateImrRightsNotice(MOCK_RFA.id);

    const { data: rows } = await supabase.from('notices').select('*').eq('claim_id', MOCK_CLAIM.id);
    const row = rows.find(r => r.notice_type === 'imr_rights');
    expect(row).toBeDefined();
    expect(row.lob_letter_id).toBe('ltr_MOCK-test');
  });

  it('Denial: inserts a notices row with notice_type=denial when adjusterId is provided', async () => {
    await noticeService.generateDenialNotice(MOCK_CLAIM.id, 'adjuster@homecaretpa.com');

    const { data: rows } = await supabase.from('notices').select('*').eq('claim_id', MOCK_CLAIM.id);
    const row = rows.find(r => r.notice_type === 'denial');
    expect(row).toBeDefined();
    expect(row.lob_letter_id).toBe('ltr_MOCK-test');
  });
});

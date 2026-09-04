-- Apply before deploying the matching backend. Unmatched legacy diaries
-- remain open for review; never infer ownership from claim_id alone.
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS rfa_id UUID REFERENCES rfas(id);
CREATE INDEX IF NOT EXISTS idx_diaries_rfa_id ON diaries(rfa_id);

UPDATE diaries d SET rfa_id = r.id
FROM rfas r
WHERE d.rfa_id IS NULL
  AND d.claim_id = r.claim_id
  AND d.diary_type = 'RFA_RESPONSE_DUE'
  AND d.notes = 'RFA response due — CCR §9792.9.1. RFA ID: ' || r.id::text;

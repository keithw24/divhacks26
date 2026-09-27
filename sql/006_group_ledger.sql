-- Group night ledger. Member keys are hashes of Photon ids / names, not phone numbers.
CREATE TABLE IF NOT EXISTS group_night_ledger (
  id uuid PRIMARY KEY,
  space_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('expense', 'transfer')),
  payer_key text NOT NULL,
  payer_name text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  memo text,
  payee_key text,
  payee_name text,
  shares jsonb,
  payment_id text,
  explorer_url text
);

CREATE INDEX IF NOT EXISTS group_night_ledger_space_idx
  ON group_night_ledger (space_id, created_at DESC);

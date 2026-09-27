-- Operational user directory for cross-channel identity and public Testnet wallets.
-- Signing seeds and private keys must never be stored here.
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id                    text        PRIMARY KEY,
    display_name               text,
    photon_identifier_hash     text,
    wallet_address             text        NOT NULL DEFAULT '0',
    backboard_assistant_id     text,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_profiles_wallet_address_check CHECK (
        wallet_address = '0'
        OR wallet_address ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'
    ),
    CONSTRAINT user_profiles_photon_hash_check CHECK (
        photon_identifier_hash IS NULL
        OR photon_identifier_hash ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_photon_identifier_hash_idx
    ON user_profiles (photon_identifier_hash)
    WHERE photon_identifier_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_profiles_display_name_idx
    ON user_profiles (lower(display_name))
    WHERE display_name IS NOT NULL;

COMMENT ON TABLE user_profiles IS
    'Application identities and public XRPL Testnet addresses. No signing material.';
COMMENT ON COLUMN user_profiles.wallet_address IS
    'Public XRPL Testnet classic address; literal 0 means no wallet is provisioned.';
COMMENT ON COLUMN user_profiles.photon_identifier_hash IS
    'SHA-256 of normalized Photon sender identity; raw phone/email is not stored.';

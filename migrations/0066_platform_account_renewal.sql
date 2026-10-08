-- Developer OAuth credentials are purpose-separated from playback Cookie vaults.
CREATE TABLE platform_oauth_accounts (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider IN ('douyin','tiktok')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'revoked' CHECK(state IN ('connected','expired','revoked')),
 token_encrypted text, access_expires_at timestamptz, refresh_expires_at timestamptz,
 config_binding text CHECK(config_binding IS NULL OR config_binding ~ '^[0-9a-f]{64}$'),
 granted_scopes text[] NOT NULL DEFAULT '{}',
 auto_renew boolean NOT NULL DEFAULT false,
 consent_login_hash text CHECK(consent_login_hash IS NULL OR consent_login_hash ~ '^[0-9a-f]{64}$'),
 renewal_state text NOT NULL DEFAULT 'disabled' CHECK(renewal_state IN ('disabled','scheduled','running','uncertain','reauthorization_required')),
 operation_nonce uuid, operation_expires_at timestamptz, next_refresh_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,provider), CHECK((operation_nonce IS NULL)=(operation_expires_at IS NULL)),
 CHECK(NOT auto_renew OR (token_encrypted IS NOT NULL AND consent_login_hash IS NOT NULL)),
 CHECK(state<>'revoked' OR (token_encrypted IS NULL AND NOT auto_renew)),
 CHECK(state<>'connected' OR token_encrypted IS NOT NULL),
 CHECK(token_encrypted IS NULL OR (length(token_encrypted)>0 AND access_expires_at IS NOT NULL AND refresh_expires_at IS NOT NULL AND config_binding IS NOT NULL))
);
CREATE TABLE platform_oauth_requests (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider IN ('douyin','tiktok')),
 auth_login_hash text NOT NULL CHECK(auth_login_hash ~ '^[0-9a-f]{64}$'),
 account_id uuid NOT NULL REFERENCES platform_oauth_accounts(id) ON DELETE CASCADE,
 account_revision bigint NOT NULL CHECK(account_revision>0), config_binding text NOT NULL CHECK(config_binding ~ '^[0-9a-f]{64}$'),
 status text NOT NULL CHECK(status IN ('pending','confirmed','expired','failed')),
 mode text NOT NULL CHECK(mode IN ('web','qr')), exchange_started boolean NOT NULL DEFAULT false,
 state_hash text NOT NULL UNIQUE CHECK(state_hash ~ '^[0-9a-f]{64}$'),
 secret_encrypted text, consent_to_renew boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL, next_poll_at timestamptz NOT NULL,
 operation_nonce uuid, operation_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(expires_at<=created_at+interval '5 minutes'), CHECK((operation_nonce IS NULL)=(operation_expires_at IS NULL)),
 CHECK(status='pending' OR (secret_encrypted IS NULL AND operation_nonce IS NULL))
);
CREATE UNIQUE INDEX platform_oauth_one_pending ON platform_oauth_requests(user_id,provider) WHERE status='pending';
CREATE INDEX platform_oauth_due ON platform_oauth_accounts(next_refresh_at) WHERE auto_renew;
-- Bili refresh grants are bound to an exact playback account revision and login.
-- The optional refresh material is retained only after a new consented QR login.
ALTER TABLE platform_login_requests ADD COLUMN consent_to_renew boolean NOT NULL DEFAULT false;
CREATE TABLE platform_account_renewals (
 account_id uuid PRIMARY KEY REFERENCES platform_accounts(id) ON DELETE CASCADE,
 credential_revision bigint NOT NULL CHECK(credential_revision>0),
 consent_login_hash text NOT NULL CHECK(consent_login_hash ~ '^[0-9a-f]{64}$'),
 refresh_encrypted text NOT NULL CHECK(length(refresh_encrypted)>0),
 state text NOT NULL CHECK(state IN ('scheduled','running','uncertain','reauthorization_required')),
 operation_nonce uuid, operation_expires_at timestamptz,
 next_refresh_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 day',
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((operation_nonce IS NULL)=(operation_expires_at IS NULL))
);
-- Replacement, expiration, and unlink delete old refresh custody immediately.
-- The renewing transaction re-inserts its freshly encrypted, new-revision grant.
CREATE FUNCTION discard_platform_renewal_on_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revision IS DISTINCT FROM OLD.revision THEN
  DELETE FROM platform_account_renewals WHERE account_id=OLD.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER platform_renewal_revision AFTER UPDATE ON platform_accounts FOR EACH ROW EXECUTE FUNCTION discard_platform_renewal_on_change();
CREATE FUNCTION protect_platform_oauth_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.user_id,NEW.provider,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.provider,OLD.created_at) THEN
  RAISE EXCEPTION 'platform_oauth_identity_immutable';
 END IF;
 IF (NEW.token_encrypted,NEW.auto_renew,NEW.consent_login_hash,NEW.config_binding,NEW.access_expires_at,NEW.refresh_expires_at,NEW.state,NEW.granted_scopes)
  IS DISTINCT FROM (OLD.token_encrypted,OLD.auto_renew,OLD.consent_login_hash,OLD.config_binding,OLD.access_expires_at,OLD.refresh_expires_at,OLD.state,OLD.granted_scopes)
  AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'platform_oauth_revision_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER platform_oauth_identity BEFORE UPDATE ON platform_oauth_accounts FOR EACH ROW EXECUTE FUNCTION protect_platform_oauth_identity();
-- Request authority and overall deadline are immutable across poll/callback.
CREATE FUNCTION protect_platform_oauth_request_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.user_id,NEW.provider,NEW.auth_login_hash,NEW.account_id,NEW.account_revision,
     NEW.config_binding,NEW.mode,NEW.state_hash,NEW.consent_to_renew,NEW.expires_at,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.provider,OLD.auth_login_hash,OLD.account_id,OLD.account_revision,
     OLD.config_binding,OLD.mode,OLD.state_hash,OLD.consent_to_renew,OLD.expires_at,OLD.created_at) THEN
  RAISE EXCEPTION 'platform_oauth_request_identity_immutable';
 END IF;
 IF (OLD.status<>'pending' AND NEW.status IS DISTINCT FROM OLD.status)
   OR (OLD.exchange_started AND NOT NEW.exchange_started) THEN
  RAISE EXCEPTION 'platform_oauth_request_terminal_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER platform_oauth_request_identity BEFORE UPDATE ON platform_oauth_requests
 FOR EACH ROW EXECUTE FUNCTION protect_platform_oauth_request_identity();

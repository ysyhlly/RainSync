-- Authorization tickets remain short-lived and single-use. Lifecycle records
-- deliberately contain no bearer token, data URL or cleartext source path.
CREATE TABLE agent_transfer_runs (
    id uuid PRIMARY KEY,
    agent_id uuid NOT NULL REFERENCES agents(id),
    resource_hash text NOT NULL,
    head boolean NOT NULL,
    byte_range text,
    status text NOT NULL DEFAULT 'offered'
        CHECK (status IN ('offered','connected','streaming','completed','failed','cancelled')),
    bytes_delivered bigint NOT NULL DEFAULT 0 CHECK (bytes_delivered >= 0),
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz NOT NULL DEFAULT now()+interval '30 seconds',
    finished_at timestamptz,
    CHECK ((finished_at IS NOT NULL) = (status IN ('completed','failed','cancelled')))
);
CREATE INDEX agent_transfer_runs_active ON agent_transfer_runs(lease_until)
    WHERE finished_at IS NULL;
CREATE INDEX agent_transfer_runs_history ON agent_transfer_runs(finished_at)
    WHERE finished_at IS NOT NULL;
-- Pre-upgrade tickets have no lifecycle owner and cannot be resumed safely.
DELETE FROM agent_transfers;

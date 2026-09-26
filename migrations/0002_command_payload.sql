-- NULL identifies pre-upgrade records whose request cannot be reconstructed.
-- They must be refused on replay rather than treated as a verified duplicate.
ALTER TABLE command_results ADD COLUMN request_payload jsonb;

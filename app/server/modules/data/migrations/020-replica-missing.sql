-- Preserve loss evidence even after a new session creates an empty CODEX_HOME.
ALTER TABLE agent_data.conversations ADD COLUMN replica_missing boolean NOT NULL DEFAULT false;

ALTER TABLE agent_data.user_runtimes ADD COLUMN IF NOT EXISTS migrated_at timestamptz;

ALTER TABLE agent_data.users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE agent_data.users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE agent_data.users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user'));
ALTER TABLE agent_data.users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE agent_data.users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS users_username ON agent_data.users(instance_id,username);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_data.users'::regclass AND conname='users_username_normalized') THEN
    ALTER TABLE agent_data.users ADD CONSTRAINT users_username_normalized CHECK(username IS NULL OR (username=lower(btrim(username)) AND username<>''));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS agent_data.auth_sessions (
  instance_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  client_hint text,
  PRIMARY KEY(instance_id,id),
  FOREIGN KEY(instance_id,user_id) REFERENCES agent_data.users(instance_id,id)
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON agent_data.auth_sessions(instance_id,user_id);
-- 相同 locator 在不同用户物理根下不再冲突；旧记录和 locator 不改写。
ALTER TABLE agent_data.resources DROP CONSTRAINT IF EXISTS resources_instance_id_locator_key;
CREATE UNIQUE INDEX IF NOT EXISTS resources_owner_locator ON agent_data.resources(instance_id,owner_id,locator);

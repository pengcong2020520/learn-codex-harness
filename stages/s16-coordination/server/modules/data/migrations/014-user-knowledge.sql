ALTER TABLE agent_data.knowledge_bases ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE agent_data.knowledge_bases ADD COLUMN IF NOT EXISTS user_created boolean NOT NULL DEFAULT false;
ALTER TABLE agent_data.permission_events ADD COLUMN IF NOT EXISTS detail jsonb;

ALTER TABLE agent_data.knowledge_bases ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','system'));

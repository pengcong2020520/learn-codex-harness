ALTER TABLE agent_data.tasks ADD COLUMN knowledge jsonb;
CREATE TABLE agent_data.knowledge_bases (
 instance_id uuid NOT NULL, id text NOT NULL, owner_id uuid NOT NULL,
 source_root text NOT NULL, wiki_root text NOT NULL,
 PRIMARY KEY(instance_id,id), FOREIGN KEY(instance_id,owner_id) REFERENCES agent_data.users(instance_id,id)
);
CREATE INDEX knowledge_bases_owner ON agent_data.knowledge_bases(instance_id,owner_id);
CREATE TABLE agent_data.knowledge_mounts (
 instance_id uuid NOT NULL, agent_id text NOT NULL, kb_id text NOT NULL,
 desired_mode text NOT NULL CHECK(desired_mode IN ('wiki','rag')),
 effective_mode text NOT NULL CHECK(effective_mode IN ('wiki','rag')),
 PRIMARY KEY(instance_id,agent_id,kb_id), FOREIGN KEY(instance_id,kb_id) REFERENCES agent_data.knowledge_bases(instance_id,id)
);
CREATE INDEX knowledge_mounts_kb ON agent_data.knowledge_mounts(instance_id,kb_id);
CREATE TABLE agent_data.wiki_pages (
 instance_id uuid NOT NULL, kb_id text NOT NULL, slug text NOT NULL, current_version uuid,
 PRIMARY KEY(instance_id,kb_id,slug), FOREIGN KEY(instance_id,kb_id) REFERENCES agent_data.knowledge_bases(instance_id,id)
);
CREATE TABLE agent_data.wiki_versions (
 instance_id uuid NOT NULL, id uuid NOT NULL, kb_id text NOT NULL, slug text NOT NULL,
 revision text NOT NULL, blob text NOT NULL, sources jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(instance_id,id), FOREIGN KEY(instance_id,kb_id,slug) REFERENCES agent_data.wiki_pages(instance_id,kb_id,slug)
);
CREATE INDEX wiki_versions_page ON agent_data.wiki_versions(instance_id,kb_id,slug);
ALTER TABLE agent_data.wiki_pages ADD FOREIGN KEY(instance_id,current_version) REFERENCES agent_data.wiki_versions(instance_id,id);
CREATE TABLE agent_data.knowledge_indexes (
 instance_id uuid NOT NULL, kb_id text NOT NULL, revision uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('building','ready','failed')),
 manifest jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(instance_id,kb_id,revision), FOREIGN KEY(instance_id,kb_id) REFERENCES agent_data.knowledge_bases(instance_id,id)
);
ALTER TABLE agent_data.knowledge_bases ADD COLUMN index_revision uuid;
ALTER TABLE agent_data.knowledge_bases ADD FOREIGN KEY(instance_id,id,index_revision) REFERENCES agent_data.knowledge_indexes(instance_id,kb_id,revision);
-- Independent from chat outbox: indexing does not require or impersonate a Codex Thread.
CREATE TABLE agent_data.knowledge_jobs (
 instance_id uuid NOT NULL, id uuid NOT NULL, kb_id text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed')),
 error text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(instance_id,id), FOREIGN KEY(instance_id,kb_id) REFERENCES agent_data.knowledge_bases(instance_id,id)
);
CREATE INDEX knowledge_jobs_pending ON agent_data.knowledge_jobs(instance_id,created_at) WHERE state='queued';
CREATE INDEX knowledge_jobs_kb ON agent_data.knowledge_jobs(instance_id,kb_id);

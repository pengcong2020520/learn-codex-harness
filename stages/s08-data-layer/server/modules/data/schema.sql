-- Product data only. Never open or migrate Codex's own SQLite databases.
CREATE SCHEMA IF NOT EXISTS agent_data;
CREATE TABLE IF NOT EXISTS agent_data.migrations(version integer PRIMARY KEY, checksum text NOT NULL);
CREATE TABLE agent_data.users (
  instance_id uuid NOT NULL, id uuid NOT NULL, name text NOT NULL,
  PRIMARY KEY(instance_id, id)
);
CREATE TABLE agent_data.agent_versions (
  instance_id uuid NOT NULL, hash text NOT NULL, descriptor jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(instance_id, hash)
);
CREATE TABLE agent_data.conversations (
  instance_id uuid NOT NULL, id text NOT NULL, owner_id uuid NOT NULL, agent_hash text,
  name text NOT NULL DEFAULT '', cwd text NOT NULL, paused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(instance_id, id), FOREIGN KEY(instance_id, owner_id) REFERENCES agent_data.users,
  FOREIGN KEY(instance_id, agent_hash) REFERENCES agent_data.agent_versions
);
CREATE INDEX conversations_owner ON agent_data.conversations(instance_id, owner_id, updated_at DESC);
CREATE TABLE agent_data.tasks (
  instance_id uuid NOT NULL, id text NOT NULL, thread_id text NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY, text text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('enqueue','append')), target_turn_id text, turn_id text, agent_hash text,
  status text NOT NULL CHECK(status IN ('queued','starting','steering','running','completed','failed','interrupted','unconfirmed')),
  error text, created_at bigint NOT NULL, PRIMARY KEY(instance_id, id),
  FOREIGN KEY(instance_id, thread_id) REFERENCES agent_data.conversations,
  FOREIGN KEY(instance_id, agent_hash) REFERENCES agent_data.agent_versions
);
CREATE INDEX tasks_thread ON agent_data.tasks(instance_id, thread_id, sequence);
CREATE INDEX tasks_pending ON agent_data.tasks(instance_id, thread_id) WHERE status = 'queued';
CREATE TABLE agent_data.outbox (
  instance_id uuid NOT NULL, thread_id text NOT NULL, generation bigint NOT NULL DEFAULT 1,
  due_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(instance_id, thread_id),
  FOREIGN KEY(instance_id, thread_id) REFERENCES agent_data.conversations
);
CREATE TABLE agent_data.notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, instance_id uuid NOT NULL,
  thread_id text NOT NULL, task_id text NOT NULL, status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(instance_id, task_id) REFERENCES agent_data.tasks
);
CREATE INDEX outbox_due ON agent_data.outbox(instance_id, due_at);
CREATE INDEX notifications_thread ON agent_data.notifications(instance_id, thread_id, id);
CREATE TABLE agent_data.resources (
  instance_id uuid NOT NULL, id uuid NOT NULL, owner_id uuid NOT NULL, source_id text NOT NULL,
  locator text NOT NULL, kind text NOT NULL CHECK(kind IN ('original','knowledge','artifact')),
  state text NOT NULL CHECK(state IN ('pending','ready','stale','revoked','unconfirmed')),
  current_version uuid, human_edited boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(instance_id, id), UNIQUE(instance_id, locator),
  FOREIGN KEY(instance_id, owner_id) REFERENCES agent_data.users
);
CREATE INDEX resources_owner ON agent_data.resources(instance_id, owner_id, source_id);
CREATE TABLE agent_data.resource_versions (
  instance_id uuid NOT NULL, id uuid NOT NULL, resource_id uuid NOT NULL,
  revision text NOT NULL, blob text NOT NULL, bytes integer NOT NULL CHECK(bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(instance_id, id),
  UNIQUE(instance_id, resource_id, id),
  FOREIGN KEY(instance_id, resource_id) REFERENCES agent_data.resources
);
ALTER TABLE agent_data.resources ADD CONSTRAINT current_resource_version
  FOREIGN KEY(instance_id, id, current_version) REFERENCES agent_data.resource_versions(instance_id, resource_id, id);
CREATE TABLE agent_data.dependencies (
  instance_id uuid NOT NULL, derived_id uuid NOT NULL, source_id uuid NOT NULL, source_version uuid NOT NULL,
  PRIMARY KEY(instance_id, derived_id, source_id), CHECK(derived_id <> source_id),
  FOREIGN KEY(instance_id, derived_id) REFERENCES agent_data.resources,
  FOREIGN KEY(instance_id, source_id, source_version) REFERENCES agent_data.resource_versions(instance_id, resource_id, id)
);
CREATE INDEX dependencies_source ON agent_data.dependencies(instance_id, source_id);
CREATE TABLE agent_data.artifacts (
  instance_id uuid NOT NULL, thread_id text NOT NULL, turn_id text NOT NULL, item_id text NOT NULL,
  resource_id uuid NOT NULL, version_id uuid NOT NULL,
  PRIMARY KEY(instance_id, thread_id, turn_id, item_id),
  FOREIGN KEY(instance_id, thread_id) REFERENCES agent_data.conversations,
  FOREIGN KEY(instance_id, resource_id, version_id) REFERENCES agent_data.resource_versions(instance_id, resource_id, id)
);
CREATE TABLE agent_data.preferences (
  instance_id uuid NOT NULL, owner_id uuid NOT NULL, key text NOT NULL, value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(instance_id, owner_id, key),
  FOREIGN KEY(instance_id, owner_id) REFERENCES agent_data.users
);
CREATE TABLE agent_data.imports (
  instance_id uuid NOT NULL, kind text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(instance_id,kind)
);

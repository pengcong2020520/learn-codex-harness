-- PG is authoritative. Publishing/recovery flags keep dispatch closed across a failed etcd write.
ALTER TABLE agent_data.shard_owners
 ADD COLUMN replica text CHECK(replica IN ('node-a','node-b','node-c')),
 ADD COLUMN replica_ready boolean NOT NULL DEFAULT false,
 ADD COLUMN previous_primary text,
 ADD COLUMN publishing boolean NOT NULL DEFAULT false,
 ADD COLUMN recovering boolean NOT NULL DEFAULT false,
 ADD COLUMN paused boolean NOT NULL DEFAULT false,
 ADD CHECK(replica IS NULL OR replica <> node_id);
CREATE TABLE agent_data.replication_positions (
 user_id uuid PRIMARY KEY, owner_id uuid NOT NULL CHECK(owner_id=user_id),
 shard_id text NOT NULL REFERENCES agent_data.shard_owners,
 epoch bigint NOT NULL, last_task_sequence bigint NOT NULL,
 replicated_at timestamptz NOT NULL DEFAULT now(), content_hash text NOT NULL
);
-- An unfinished pair of directory imports must never become a promotable snapshot.
CREATE TABLE agent_data.replication_transfers (
 user_id uuid PRIMARY KEY, owner_id uuid NOT NULL CHECK(owner_id=user_id),
 shard_id text NOT NULL REFERENCES agent_data.shard_owners, epoch bigint NOT NULL,
 token uuid NOT NULL, started_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER shard_owner_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_data.replication_positions
 FOR EACH ROW EXECUTE FUNCTION agent_data.require_shard_owner();
CREATE TRIGGER shard_owner_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_data.replication_transfers
 FOR EACH ROW EXECUTE FUNCTION agent_data.require_shard_owner();
ALTER TABLE agent_data.tasks ADD COLUMN finished_at timestamptz;
CREATE FUNCTION agent_data.task_finished_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('completed','failed','interrupted','needs-review','cancelled') THEN NEW.finished_at=now(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_finished_at BEFORE UPDATE ON agent_data.tasks FOR EACH ROW EXECUTE FUNCTION agent_data.task_finished_at();
ALTER TABLE agent_data.tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE agent_data.tasks ADD CONSTRAINT tasks_status_check CHECK(status IN
 ('queued','starting','steering','running','completed','failed','interrupted','unconfirmed','needs-review','waiting','cancelled','proposed','replica_missing'));

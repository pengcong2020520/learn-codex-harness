CREATE TABLE agent_data.move_operations (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES agent_data.user_shards(user_id),
 from_shard text NOT NULL REFERENCES agent_data.shard_owners(shard_id),
 to_shard text NOT NULL REFERENCES agent_data.shard_owners(shard_id),
 control_node text NOT NULL CHECK(control_node IN ('node-a','node-b','node-c')),
 source_node text NOT NULL CHECK(source_node IN ('node-a','node-b','node-c')),
 target_node text NOT NULL CHECK(target_node IN ('node-a','node-b','node-c')),
 state text NOT NULL CHECK(state IN ('paused','copying','copied','switched','resumed','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
 CHECK(from_shard <> to_shard), CHECK(expires_at > created_at AND expires_at <= created_at + interval '30 minutes')
);
CREATE INDEX ON agent_data.move_operations(user_id, created_at DESC);
CREATE TRIGGER cluster_term_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_data.move_operations
 FOR EACH STATEMENT EXECUTE FUNCTION agent_data.require_cluster_term();
-- Upgrade existing installations too; provisioning repeats these grants for new roles.
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['agent_node_a','agent_node_b','agent_node_c'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('GRANT SELECT, INSERT, UPDATE ON agent_data.move_operations TO %I', r);
   EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON agent_data.users, agent_data.auth_sessions, agent_data.agent_versions, agent_data.plans, agent_data.imports FROM %I', r);
   EXECUTE format('GRANT UPDATE(plan_id) ON agent_data.users TO %I', r);
   EXECUTE format('GRANT INSERT, UPDATE(last_seen_at, revoked_at) ON agent_data.auth_sessions TO %I', r);
   EXECUTE format('GRANT INSERT ON agent_data.agent_versions TO %I', r);
  END IF;
 END LOOP;
END $$;

-- Draining work may finish in paused; copying and later states reject all old writes.
CREATE OR REPLACE FUNCTION agent_data.check_shard(owner uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,agent_data AS $$
DECLARE actual record; supplied text := current_setting('app.node',true);
BEGIN
 -- Lock BOTH mappings until commit: migration cannot overtake an old owner's transaction.
 SELECT s.node_id,s.epoch,u.shard_id,u.paused INTO actual FROM user_shards u JOIN shard_owners s USING(shard_id)
 WHERE u.user_id=owner FOR SHARE OF u,s;
 IF actual IS NULL OR (actual.paused AND EXISTS(SELECT 1 FROM move_operations WHERE user_id=owner AND state IN ('copying','copied','switched','failed'))) OR actual.node_id IS DISTINCT FROM supplied OR
    actual.epoch::text IS DISTINCT FROM nullif(current_setting('app.shard_epoch',true),'') OR
    current_user <> 'agent_' || replace(supplied,'-','_') THEN
  RAISE EXCEPTION 'missing, foreign or stale shard owner' USING ERRCODE='SH001', DETAIL=json_build_object(
    'ownerId',owner,'shardId',actual.shard_id,'primary',actual.node_id,'epoch',actual.epoch::text,
    'nodeId',supplied,'suppliedEpoch',current_setting('app.shard_epoch',true))::text;
 END IF;
END $$;

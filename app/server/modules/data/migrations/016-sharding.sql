-- s18: business rows are fenced by their user's shard, NOT by the control term.
CREATE TABLE agent_data.shard_owners (
 shard_id text PRIMARY KEY CHECK(shard_id IN ('0','1','2')),
 node_id text CHECK(node_id IN ('node-a','node-b','node-c')), epoch bigint NOT NULL CHECK(epoch>=0)
);
CREATE TABLE agent_data.user_shards (
 user_id uuid PRIMARY KEY, shard_id text NOT NULL REFERENCES agent_data.shard_owners,
 paused boolean NOT NULL DEFAULT false
);
CREATE TRIGGER cluster_term_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_data.shard_owners
 FOR EACH STATEMENT EXECUTE FUNCTION agent_data.require_cluster_term();
CREATE TRIGGER cluster_term_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_data.user_shards
 FOR EACH STATEMENT EXECUTE FUNCTION agent_data.require_cluster_term();

CREATE FUNCTION agent_data.row_owner(tab text, r jsonb) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,agent_data AS $$
DECLARE owner uuid; inst uuid := (r->>'instance_id')::uuid;
BEGIN
 IF r ? 'owner_id' THEN RETURN (r->>'owner_id')::uuid; END IF;
 IF tab='user_runtimes' THEN RETURN (r->>'user_id')::uuid; END IF;
 IF tab='permission_events' THEN
  IF r->>'resource_type'='knowledge' THEN SELECT owner_id INTO owner FROM knowledge_bases WHERE instance_id=inst AND id=r->>'resource_id';
  ELSIF r->>'resource_type'='skill' THEN SELECT owner_id INTO owner FROM hub_skills WHERE instance_id=inst AND id=r->>'resource_id'; END IF;
  RETURN coalesce(owner,(r->'before_state'->>'owner_id')::uuid,(r->>'actor_id')::uuid);
 END IF;
 IF tab='resource_grants' THEN
  IF r->>'resource_type'='knowledge' THEN SELECT owner_id INTO owner FROM knowledge_bases WHERE instance_id=inst AND id=r->>'resource_id';
  ELSE SELECT owner_id INTO owner FROM hub_skills WHERE instance_id=inst AND id=r->>'resource_id'; END IF;
 ELSIF tab='skill_share_requests' THEN SELECT owner_id INTO owner FROM hub_skills WHERE instance_id=inst AND id=r->>'skill_id';
 ELSIF r ? 'thread_id' THEN SELECT owner_id INTO owner FROM conversations WHERE instance_id=inst AND id=r->>'thread_id';
 ELSIF r ? 'kb_id' THEN SELECT owner_id INTO owner FROM knowledge_bases WHERE instance_id=inst AND id=r->>'kb_id';
 ELSIF tab='resource_versions' THEN SELECT owner_id INTO owner FROM resources WHERE instance_id=inst AND id=(r->>'resource_id')::uuid;
 ELSIF tab='dependencies' THEN SELECT owner_id INTO owner FROM resources WHERE instance_id=inst AND id=(r->>'derived_id')::uuid;
 END IF;
 RETURN owner;
END $$;
CREATE FUNCTION agent_data.check_shard(owner uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,agent_data AS $$
DECLARE actual record; supplied text := current_setting('app.node',true);
BEGIN
 -- Lock BOTH mappings until commit: migration cannot overtake an old owner's transaction.
 SELECT s.node_id,s.epoch INTO actual FROM user_shards u JOIN shard_owners s USING(shard_id)
 WHERE u.user_id=owner FOR SHARE OF u,s;
 IF actual IS NULL OR actual.node_id IS DISTINCT FROM supplied OR
    actual.epoch::text IS DISTINCT FROM nullif(current_setting('app.shard_epoch',true),'') OR
    current_user <> 'agent_' || replace(supplied,'-','_') THEN
  RAISE EXCEPTION 'missing, foreign or stale shard owner' USING ERRCODE='SH001';
 END IF;
END $$;
CREATE FUNCTION agent_data.require_shard_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,agent_data AS $$
BEGIN
 IF current_setting('app.maintenance',true)='on' AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF TG_OP<>'INSERT' THEN PERFORM agent_data.check_shard(agent_data.row_owner(TG_TABLE_NAME,to_jsonb(OLD))); END IF;
 IF TG_OP<>'DELETE' THEN PERFORM agent_data.check_shard(agent_data.row_owner(TG_TABLE_NAME,to_jsonb(NEW))); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
-- Node identities are SQL roles, not an unchecked caller-supplied app.node.
CREATE FUNCTION agent_data.require_global_node() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,agent_data AS $$
BEGIN
 IF current_setting('app.maintenance',true)='on' AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RETURN NULL; END IF;
 IF current_user NOT IN ('agent_node_a','agent_node_b','agent_node_c') OR
    current_user IS DISTINCT FROM 'agent_' || replace(current_setting('app.node',true),'-','_') THEN
  RAISE EXCEPTION 'global write requires a node role' USING ERRCODE='SH001';
 END IF;
 IF TG_TABLE_NAME IN ('plans','imports') OR (TG_TABLE_NAME='agent_versions' AND TG_OP<>'INSERT') THEN
  RAISE EXCEPTION 'administrative or immutable global table' USING ERRCODE='42501';
 END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='agent_data'
  AND tablename NOT IN ('migrations','cluster_term','shard_owners','user_shards') LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS cluster_term_guard ON agent_data.%I',t.tablename);
  IF t.tablename IN ('users','auth_sessions','agent_versions','plans','imports') THEN
   EXECUTE format('CREATE TRIGGER global_node_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_data.%I FOR EACH STATEMENT EXECUTE FUNCTION agent_data.require_global_node()',t.tablename);
  ELSE
   EXECUTE format('CREATE TRIGGER shard_owner_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_data.%I FOR EACH ROW EXECUTE FUNCTION agent_data.require_shard_owner()',t.tablename);
  END IF;
 END LOOP;
END $$;

-- 同一事务中的版本哨兵使直接重跑 SQL 也成为 no-op；不重置上线后的授权与权益。
DO $hub_migration$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='agent_data' AND table_name='users' AND column_name='plan_id') THEN RETURN; END IF;
CREATE TABLE agent_data.plans (
 id text PRIMARY KEY, name text NOT NULL, agents text[] NOT NULL, tool_groups text[] NOT NULL,
 daily_tokens bigint NOT NULL, max_concurrent_turns integer NOT NULL,
 max_knowledge_bases integer NOT NULL, max_private_skills integer NOT NULL
);
INSERT INTO agent_data.plans VALUES
 ('basic','basic',ARRAY['writing'],ARRAY['files','knowledge'],200000,1,3,3),
 ('pro','pro',ARRAY['*'],ARRAY['*'],1000000,2,20,20);
ALTER TABLE agent_data.users ADD COLUMN plan_id text NOT NULL DEFAULT 'basic' REFERENCES agent_data.plans(id);
ALTER TABLE agent_data.knowledge_bases DROP CONSTRAINT knowledge_bases_visibility_check;
ALTER TABLE agent_data.knowledge_bases ADD CONSTRAINT knowledge_bases_visibility_check CHECK(visibility IN ('private','shared','system'));
UPDATE agent_data.knowledge_bases SET visibility='private';
CREATE TABLE agent_data.hub_skills (
 instance_id uuid NOT NULL, id text NOT NULL, owner_id uuid NOT NULL, name text NOT NULL,
 scope text NOT NULL DEFAULT 'private' CHECK(scope IN ('private','shared','system')),
 files jsonb NOT NULL, version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(instance_id,id), FOREIGN KEY(instance_id,owner_id) REFERENCES agent_data.users(instance_id,id)
);
CREATE TABLE agent_data.resource_grants (
 instance_id uuid NOT NULL, resource_type text NOT NULL CHECK(resource_type IN ('knowledge','skill')),
 resource_id text NOT NULL, grantee_id uuid NOT NULL, granted_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(instance_id,resource_type,resource_id,grantee_id),
 FOREIGN KEY(instance_id,grantee_id) REFERENCES agent_data.users(instance_id,id),
 FOREIGN KEY(instance_id,granted_by) REFERENCES agent_data.users(instance_id,id)
);
CREATE TABLE agent_data.skill_share_requests (
 instance_id uuid NOT NULL, skill_id text NOT NULL, proposed_by uuid NOT NULL, grantees uuid[] NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','approved','rejected')), reviewed_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(instance_id,skill_id), FOREIGN KEY(instance_id,skill_id) REFERENCES agent_data.hub_skills(instance_id,id)
);
CREATE TABLE agent_data.permission_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, instance_id uuid NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL,
 before_state jsonb, after_state jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION agent_data.permission_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'permission_events is append-only'; END $$;
CREATE TRIGGER permission_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON agent_data.permission_events
 FOR EACH STATEMENT EXECUTE FUNCTION agent_data.permission_append_only();
-- 锁定资源行后再计数；并发请求也不能超过 20。UPDATE 同样不能绕开校验。
CREATE FUNCTION agent_data.validate_resource_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid; resource_scope text; n integer;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'replace grants with DELETE/INSERT'; END IF;
 IF NEW.resource_type='knowledge' THEN
  SELECT owner_id,visibility INTO owner,resource_scope FROM agent_data.knowledge_bases WHERE instance_id=NEW.instance_id AND id=NEW.resource_id FOR UPDATE;
 ELSE
  SELECT owner_id,scope INTO owner,resource_scope FROM agent_data.hub_skills WHERE instance_id=NEW.instance_id AND id=NEW.resource_id FOR UPDATE;
 END IF;
 IF owner IS NULL OR resource_scope='system' THEN RAISE EXCEPTION 'resource missing or system'; END IF;
 IF owner=NEW.grantee_id OR NEW.granted_by=NEW.grantee_id THEN RAISE EXCEPTION 'cannot grant to owner or self'; END IF;
 PERFORM 1 FROM agent_data.users WHERE instance_id=NEW.instance_id AND id=NEW.grantee_id AND disabled_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'grantee missing or disabled'; END IF;
 SELECT count(*) INTO n FROM agent_data.resource_grants WHERE instance_id=NEW.instance_id AND resource_type=NEW.resource_type AND resource_id=NEW.resource_id;
 IF n>=20 AND NOT EXISTS(SELECT 1 FROM agent_data.resource_grants WHERE instance_id=NEW.instance_id AND resource_type=NEW.resource_type AND resource_id=NEW.resource_id AND grantee_id=NEW.grantee_id) THEN RAISE EXCEPTION 'grant limit 20'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_resource_grant BEFORE INSERT OR UPDATE ON agent_data.resource_grants FOR EACH ROW EXECUTE FUNCTION agent_data.validate_resource_grant();
CREATE FUNCTION agent_data.grant_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; value text;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD; ELSE r:=NEW; END IF;
 -- DELETE 也持有同一资源锁；最后一个授权撤销后恢复 private。
 IF r.resource_type='knowledge' THEN
  PERFORM 1 FROM agent_data.knowledge_bases WHERE instance_id=r.instance_id AND id=r.resource_id FOR UPDATE;
 ELSE
  PERFORM 1 FROM agent_data.hub_skills WHERE instance_id=r.instance_id AND id=r.resource_id FOR UPDATE;
 END IF;
 value:=CASE WHEN EXISTS(SELECT 1 FROM agent_data.resource_grants WHERE instance_id=r.instance_id AND resource_type=r.resource_type AND resource_id=r.resource_id) THEN 'shared' ELSE 'private' END;
 IF r.resource_type='knowledge' THEN
  UPDATE agent_data.knowledge_bases SET visibility=value WHERE instance_id=r.instance_id AND id=r.resource_id AND visibility<>'system';
 ELSE
  UPDATE agent_data.hub_skills SET scope=value WHERE instance_id=r.instance_id AND id=r.resource_id AND scope<>'system';
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER grant_scope AFTER INSERT OR DELETE ON agent_data.resource_grants FOR EACH ROW EXECUTE FUNCTION agent_data.grant_scope();
CREATE FUNCTION agent_data.validate_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE visible text; kind text; granted boolean;
BEGIN
 IF TG_TABLE_NAME='knowledge_bases' THEN visible:=NEW.visibility; kind:='knowledge'; ELSE visible:=NEW.scope; kind:='skill'; END IF;
 SELECT EXISTS(SELECT 1 FROM agent_data.resource_grants WHERE instance_id=NEW.instance_id AND resource_type=kind AND resource_id=NEW.id) INTO granted;
 IF (visible='shared')<>granted THEN RAISE EXCEPTION 'scope must match grants'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER knowledge_scope BEFORE UPDATE OF visibility ON agent_data.knowledge_bases FOR EACH ROW EXECUTE FUNCTION agent_data.validate_scope();
CREATE TRIGGER skill_scope BEFORE UPDATE OF scope ON agent_data.hub_skills FOR EACH ROW EXECUTE FUNCTION agent_data.validate_scope();
ALTER TABLE agent_data.conversations ADD COLUMN hub_knowledge text[] NOT NULL DEFAULT '{}';
UPDATE agent_data.conversations c SET hub_knowledge=ARRAY(
 SELECT DISTINCT m.kb_id FROM agent_data.knowledge_mounts m JOIN agent_data.knowledge_bases k ON k.instance_id=m.instance_id AND k.id=m.kb_id
 WHERE m.instance_id=c.instance_id AND k.owner_id=c.owner_id
);

END $hub_migration$;

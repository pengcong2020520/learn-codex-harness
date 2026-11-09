-- Diagnostics only: identical ownership/epoch/role checks, locks and maintenance exception.
CREATE OR REPLACE FUNCTION agent_data.check_shard(owner uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,agent_data AS $$
DECLARE actual record; supplied text := current_setting('app.node',true);
BEGIN
 -- Lock BOTH mappings until commit: migration cannot overtake an old owner's transaction.
 SELECT s.node_id,s.epoch,u.shard_id INTO actual FROM user_shards u JOIN shard_owners s USING(shard_id)
 WHERE u.user_id=owner FOR SHARE OF u,s;
 IF actual IS NULL OR actual.node_id IS DISTINCT FROM supplied OR
    actual.epoch::text IS DISTINCT FROM nullif(current_setting('app.shard_epoch',true),'') OR
    current_user <> 'agent_' || replace(supplied,'-','_') THEN
  RAISE EXCEPTION 'missing, foreign or stale shard owner' USING ERRCODE='SH001', DETAIL=json_build_object(
    'ownerId',owner,'shardId',actual.shard_id,'primary',actual.node_id,'epoch',actual.epoch::text,
    'nodeId',supplied,'suppliedEpoch',current_setting('app.shard_epoch',true))::text;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION agent_data.require_shard_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,agent_data AS $$
DECLARE fence_detail text;
BEGIN
 IF current_setting('app.maintenance',true)='on' AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF TG_OP<>'INSERT' THEN PERFORM agent_data.check_shard(agent_data.row_owner(TG_TABLE_NAME,to_jsonb(OLD))); END IF;
 IF TG_OP<>'DELETE' THEN PERFORM agent_data.check_shard(agent_data.row_owner(TG_TABLE_NAME,to_jsonb(NEW))); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
EXCEPTION WHEN SQLSTATE 'SH001' THEN
 GET STACKED DIAGNOSTICS fence_detail = PG_EXCEPTION_DETAIL;
 RAISE EXCEPTION 'missing, foreign or stale shard owner' USING ERRCODE='SH001', DETAIL=fence_detail, TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA;
END $$;

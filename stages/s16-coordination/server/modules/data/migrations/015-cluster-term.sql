-- Administrative connections must explicitly opt in; runtime roles are NOSUPERUSER.
CREATE TABLE agent_data.cluster_term(id int PRIMARY KEY CHECK(id=1), term bigint NOT NULL);
INSERT INTO agent_data.cluster_term VALUES (1, 0);

CREATE FUNCTION agent_data.advance_cluster_term(next_term bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, agent_data AS $$
DECLARE actual bigint;
BEGIN
  IF next_term <= 0 THEN RAISE EXCEPTION 'invalid cluster term' USING ERRCODE='CT001'; END IF;
  UPDATE agent_data.cluster_term SET term=next_term WHERE id=1 AND term < next_term;
  IF NOT FOUND THEN
    INSERT INTO agent_data.cluster_term VALUES (1, next_term) ON CONFLICT DO NOTHING;
  END IF;
  SELECT term INTO actual FROM agent_data.cluster_term WHERE id=1 FOR UPDATE;
  IF actual > next_term THEN RAISE EXCEPTION 'stale cluster term' USING ERRCODE='CT001'; END IF;
  RETURN actual;
END $$;
REVOKE ALL ON FUNCTION agent_data.advance_cluster_term(bigint) FROM PUBLIC;

-- Runtime roles may lock but cannot directly modify the singleton row.
CREATE FUNCTION agent_data.locked_cluster_term() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, agent_data AS $$
  SELECT term FROM agent_data.cluster_term WHERE id=1 FOR SHARE
$$;

-- Invoker rights are essential: current_user must remain the node, not the function owner.
CREATE FUNCTION agent_data.require_cluster_term() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, agent_data AS $$
DECLARE actual bigint; supplied text;
BEGIN
  IF current_setting('app.maintenance', true) = 'on' THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
      RAISE EXCEPTION 'maintenance requires administrative role' USING ERRCODE='42501';
    END IF;
    RETURN NULL;
  END IF;
  supplied := current_setting('app.term', true);
  -- Hold a shared row lock until COMMIT: an old transaction cannot commit after promotion.
  actual := agent_data.locked_cluster_term();
  IF supplied IS NULL OR supplied = '' OR actual IS NULL OR supplied <> actual::text THEN
    RAISE EXCEPTION 'missing or stale cluster term' USING ERRCODE='CT001';
  END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE tab record; BEGIN
  FOR tab IN SELECT tablename FROM pg_tables WHERE schemaname='agent_data'
    AND tablename NOT IN ('migrations','cluster_term') LOOP
    EXECUTE format('CREATE TRIGGER cluster_term_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_data.%I FOR EACH STATEMENT EXECUTE FUNCTION agent_data.require_cluster_term()', tab.tablename);
  END LOOP;
END $$;

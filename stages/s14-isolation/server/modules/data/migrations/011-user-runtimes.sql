CREATE TABLE IF NOT EXISTS agent_data.user_runtimes (
  instance_id uuid NOT NULL,
  user_id uuid NOT NULL,
  uid integer NOT NULL UNIQUE CHECK (uid >= 10001),
  codex_home text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(instance_id,user_id),
  FOREIGN KEY(instance_id,user_id) REFERENCES agent_data.users(instance_id,id)
);
-- CLI 与服务可能是不同进程；提交禁用事务时通知执行器，不依赖下一次 HTTP 请求。
CREATE OR REPLACE FUNCTION agent_data.notify_runtime_disabled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.disabled_at IS NOT NULL AND OLD.disabled_at IS NULL THEN
    PERFORM pg_notify('agent_runtime_disabled', json_build_object('instanceId', NEW.instance_id, 'userId', NEW.id)::text);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_disabled ON agent_data.users;
CREATE TRIGGER runtime_disabled AFTER UPDATE OF disabled_at ON agent_data.users
FOR EACH ROW EXECUTE FUNCTION agent_data.notify_runtime_disabled();

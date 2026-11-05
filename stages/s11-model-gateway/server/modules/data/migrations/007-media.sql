-- 视频任务脱离对话轮次继续运行；授权范围和归属仅由服务端写入。
CREATE TABLE agent_data.media_jobs (
  instance_id uuid NOT NULL, owner_id uuid NOT NULL, id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('submitting','queued','in_progress','completed','failed')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(instance_id,owner_id,id),
  FOREIGN KEY(instance_id,owner_id) REFERENCES agent_data.users
);
CREATE INDEX media_pending ON agent_data.media_jobs(instance_id,owner_id,status);
ALTER TABLE agent_data.usage ADD COLUMN event_key text;
ALTER TABLE agent_data.usage ADD CONSTRAINT usage_event UNIQUE(instance_id,owner_id,event_key);

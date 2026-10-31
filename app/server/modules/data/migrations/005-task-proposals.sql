-- 模型可以提议任务但不能自己批准：proposed 任务不排队、不授权，用户确认后才进入 queued；reason 记录提议理由。
ALTER TABLE agent_data.tasks ADD COLUMN reason text;
ALTER TABLE agent_data.tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE agent_data.tasks ADD CONSTRAINT tasks_status_check
  CHECK(status IN ('queued','starting','steering','running','completed','failed','interrupted','unconfirmed','needs-review','waiting','cancelled','proposed'));

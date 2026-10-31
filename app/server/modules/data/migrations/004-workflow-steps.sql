-- 多步 workflow：记录当前步骤与用户确认时的补充说明；waiting 等待用户确认，cancelled 由用户结束。
ALTER TABLE agent_data.tasks ADD COLUMN step integer NOT NULL DEFAULT 0;
ALTER TABLE agent_data.tasks ADD COLUMN note text;
ALTER TABLE agent_data.tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE agent_data.tasks ADD CONSTRAINT tasks_status_check
  CHECK(status IN ('queued','starting','steering','running','completed','failed','interrupted','unconfirmed','needs-review','waiting','cancelled'));

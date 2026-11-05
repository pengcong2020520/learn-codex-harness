-- 任务按 workflow 执行：记录 workflow、参数与验收结果；验收不通过的任务记为 needs-review。
ALTER TABLE agent_data.tasks ADD COLUMN workflow text NOT NULL DEFAULT 'chat';
ALTER TABLE agent_data.tasks ADD COLUMN params jsonb;
ALTER TABLE agent_data.tasks ADD COLUMN checks jsonb;
-- 旧的知识维护任务转换为 knowledge-maintain；knowledge 列保留不再写入，便于回退核对。
UPDATE agent_data.tasks SET workflow='knowledge-maintain', params=jsonb_build_object('kbId', knowledge->>'kbId') WHERE knowledge IS NOT NULL;
ALTER TABLE agent_data.tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE agent_data.tasks ADD CONSTRAINT tasks_status_check
  CHECK(status IN ('queued','starting','steering','running','completed','failed','interrupted','unconfirmed','needs-review'));

-- 附件路径随任务持久化；旧任务按无附件处理。
ALTER TABLE agent_data.tasks ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

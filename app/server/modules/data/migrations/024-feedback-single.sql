-- 待核对及失败任务仍占用设计流程，只有完成或明确结束才释放。
ALTER TABLE agent_data.tasks ADD COLUMN single_workflow boolean NOT NULL DEFAULT false;
ALTER TABLE agent_data.tasks ADD COLUMN feedback jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE UNIQUE INDEX tasks_single_workflow ON agent_data.tasks(instance_id,workflow)
  WHERE single_workflow AND status NOT IN ('completed','cancelled');

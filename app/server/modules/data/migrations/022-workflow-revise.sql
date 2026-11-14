-- 当前步的重做次数随任务保存；推进下一步时归零。
ALTER TABLE agent_data.tasks ADD COLUMN revise_count integer NOT NULL DEFAULT 0
  CHECK (revise_count BETWEEN 0 AND 10);

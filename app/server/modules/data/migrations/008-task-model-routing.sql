-- 用户选择与派发决策分开保存：多步任务在每步开始时更新实际模型和来源。
ALTER TABLE agent_data.tasks ADD COLUMN model text;
ALTER TABLE agent_data.tasks ADD COLUMN selected_model text;
ALTER TABLE agent_data.tasks ADD COLUMN model_source text;

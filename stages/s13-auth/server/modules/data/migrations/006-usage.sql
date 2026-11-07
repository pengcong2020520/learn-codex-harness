-- 用量独立于任务寿命；后台向量索引没有 Thread、Turn 或任务 ID。
CREATE TABLE agent_data.usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instance_id uuid NOT NULL, owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), thread_id text, turn_id text, task_id text,
  source text NOT NULL CHECK(source IN ('chat','embedding','image','video')), model text NOT NULL,
  input_tokens bigint NOT NULL CHECK(input_tokens >= 0), cached_input_tokens bigint NOT NULL CHECK(cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens),
  output_tokens bigint NOT NULL CHECK(output_tokens >= 0), reasoning_output_tokens bigint NOT NULL CHECK(reasoning_output_tokens >= 0 AND reasoning_output_tokens <= output_tokens),
  total_tokens bigint NOT NULL CHECK(total_tokens >= 0), units double precision CHECK(units >= 0),
  currency text NOT NULL CHECK(currency IN ('CNY','USD')), estimated_cost double precision CHECK(estimated_cost >= 0),
  FOREIGN KEY(instance_id, owner_id) REFERENCES agent_data.users
);
CREATE INDEX usage_time ON agent_data.usage(instance_id, owner_id, created_at);

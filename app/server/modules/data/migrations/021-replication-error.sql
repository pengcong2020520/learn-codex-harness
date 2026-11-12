ALTER TABLE agent_data.replication_transfers ADD COLUMN error text;
ALTER TABLE agent_data.replication_positions ADD COLUMN transfer_token uuid;

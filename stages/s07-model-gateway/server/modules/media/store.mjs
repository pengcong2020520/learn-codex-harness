import { Repository } from '../data/repository.mjs';

export class MediaJobs extends Repository {
  async save(job) {
    await this.query(`INSERT INTO agent_data.media_jobs(instance_id,owner_id,id,status,payload)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(instance_id,owner_id,id)
      DO UPDATE SET status=$4,payload=$5,updated_at=now()`, [job.id, job.status, job]);
    return job;
  }
  async get(id) {
    return (await this.query('SELECT payload FROM agent_data.media_jobs WHERE instance_id=$1 AND owner_id=$2 AND id=$3', [id])).rows[0]?.payload;
  }
  async pending() {
    return (await this.query("SELECT payload FROM agent_data.media_jobs WHERE instance_id=$1 AND owner_id=$2 AND status NOT IN ('completed','failed') ORDER BY created_at")).rows.map(row => row.payload);
  }
}

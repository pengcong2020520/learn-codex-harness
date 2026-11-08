// Container liveness includes hot standbys; traffic readiness is control-only.
try {
  const alive = process.argv.includes('--alive');
  const response = await fetch(`http://127.0.0.1:${process.env.AGENT_PORT || 4340}/${alive ? 'health' : 'ready'}`, { signal: AbortSignal.timeout(8000) });
  const result = await response.json();
  console.log(JSON.stringify(result));
  process.exitCode = response.ok && result.status === (alive ? 'alive' : 'ready') ? 0 : 1;
} catch { console.error('not-ready'); process.exitCode = 1; }

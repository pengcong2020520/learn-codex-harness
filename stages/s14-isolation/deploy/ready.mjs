// No token or secret on the command line; health endpoints are intentionally public on loopback.
try {
  const response = await fetch(`http://127.0.0.1:${process.env.AGENT_PORT || 4328}/ready`, { signal: AbortSignal.timeout(8000) });
  const result = await response.json();
  console.log(JSON.stringify(result));
  process.exitCode = response.ok && result.status === 'ready' ? 0 : 1;
} catch { console.error('not-ready'); process.exitCode = 1; }

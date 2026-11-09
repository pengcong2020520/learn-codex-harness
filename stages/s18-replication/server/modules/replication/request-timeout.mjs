// Node's server.requestTimeout is a total body deadline, including flowing uploads.
// Replace it on the coordinated listener only; other requests keep their 30s budget.
export function configureReplicationTimeouts(server) {
  server.requestTimeout = 0;
  server.headersTimeout = 10000;
  server.prependListener('request', (req, res) => {
    const tree = req.method === 'PUT' && req.url.split('?')[0] === '/internal/replication/tree';
    const expired = () => req.destroy(new Error('请求接收超时。'));
    let timer;
    if (tree) req.setTimeout(30000, expired); // Socket inactivity, without putting req into flowing mode.
    else { timer = setTimeout(expired, 30000); timer.unref?.(); }
    const clear = () => {
      clearTimeout(timer);
      if (tree) { req.setTimeout(0); req.removeListener('timeout', expired); }
      req.removeListener('end', clear); req.removeListener('close', clear); res.removeListener('close', clear);
    };
    req.once('end', clear); req.once('close', clear); res.once('close', clear);
  });
  return server;
}

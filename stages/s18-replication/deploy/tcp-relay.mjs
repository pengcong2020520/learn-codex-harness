// Profile-only TCP plumbing; authentication remains PostgreSQL/Redis/etcd/node authentication.
import net from 'node:net';
const servers=[];
for(const [listen,host,port] of JSON.parse(process.env.RELAYS)) {
 const server=net.createServer(client=>{
  const remote=net.connect({host,port});client.on('error',()=>remote.destroy());remote.on('error',()=>client.destroy());
  client.on('close',()=>remote.destroy());remote.on('close',()=>client.destroy());client.pipe(remote).pipe(client);
 });
 server.listen(listen,process.env.RELAY_BIND||'0.0.0.0');servers.push(server);
}
process.on('SIGTERM',()=>{for(const server of servers)server.close();});

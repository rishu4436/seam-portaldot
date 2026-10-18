// Preloaded into child processes (NODE_OPTIONS=--import): any attempt to open a socket or resolve a name is a hard error,
// so a "refusal" test can only pass if the refusal happens before any network call.
import net from 'node:net';
import dns from 'node:dns';
const deny = (what) => () => { throw new Error(`NETWORK ATTEMPTED (${what}) in an offline test`); };
net.Socket.prototype.connect = deny('socket connect');
net.connect = deny('net.connect');
net.createConnection = deny('net.createConnection');
dns.lookup = deny('dns.lookup');
dns.promises.lookup = deny('dns.promises.lookup');

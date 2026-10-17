import { io } from '/socket.io/socket.io.esm.min.js';
import { SOCKET_URL } from './config.js';

// The live game connection, behind a small interface so a deployment can swap the wire protocol
// (this file is the Socket.IO version; the cloud build replaces it with a raw-WebSocket one).
//   on(event, fn)                 server pushes: state, history, feed, fx, ping, seatInvalid,
//                                 fatal, contentChanged, plus connect_error(Error)
//   request(event, payload, opts) → Promise<reply>; rejects after opts.timeoutMs (default 8s)
//   setAuth(auth)                 credentials used on the next (re)connect
export function connect(namespace, auth) {
  const socket = io(`${SOCKET_URL}${namespace}`, { auth });
  return {
    on: (event, fn) => { socket.on(event, fn); },
    request: (event, payload, { timeoutMs = 8000 } = {}) => new Promise((resolve, reject) => {
      socket.timeout(timeoutMs).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)));
    }),
    setAuth: (next) => { socket.auth = next; },
  };
}

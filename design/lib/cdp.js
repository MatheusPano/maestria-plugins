'use strict';
const { EventEmitter } = require('node:events');

// CDP over --remote-debugging-pipe: JSON messages terminated by a NUL byte.
function encode(msg) {
  return Buffer.concat([Buffer.from(JSON.stringify(msg), 'utf8'), Buffer.from([0])]);
}

class Decoder extends EventEmitter {
  constructor() {
    super();
    this.chunks = []; // pending bytes of the current (unterminated) message
  }

  // Only the new chunk is scanned for NUL; buffers are joined once per message.
  push(chunk) {
    let rest = chunk;
    let i;
    while ((i = rest.indexOf(0)) !== -1) {
      this.chunks.push(rest.subarray(0, i));
      const raw = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      rest = rest.subarray(i + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { this.emit('error', e); continue; }
      this.emit('message', msg);
    }
    if (rest.length) this.chunks.push(rest);
  }
}

module.exports = { encode, Decoder };

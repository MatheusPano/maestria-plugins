'use strict';
const { EventEmitter } = require('node:events');

// CDP over --remote-debugging-pipe: JSON messages terminated by a NUL byte.
function encode(msg) {
  return Buffer.concat([Buffer.from(JSON.stringify(msg), 'utf8'), Buffer.from([0])]);
}

class Decoder extends EventEmitter {
  constructor() {
    super();
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let i;
    while ((i = this.buf.indexOf(0)) !== -1) {
      const raw = this.buf.subarray(0, i).toString('utf8');
      this.buf = this.buf.subarray(i + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { this.emit('error', e); continue; }
      this.emit('message', msg);
    }
  }
}

module.exports = { encode, Decoder };

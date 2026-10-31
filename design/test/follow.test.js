'use strict';
const test = require('node:test');
const assert = require('node:assert');
const follow = require('../lib/follow');

test('shouldJump: only when following and the user left the canvas alone for 5 s', () => {
  const rows = [
    [{ now: 10000, lastUserMove: 0, follow: true }, true],
    [{ now: 10000, lastUserMove: 4999, follow: true }, true],
    [{ now: 10000, lastUserMove: 5000, follow: true }, false],
    [{ now: 10000, lastUserMove: 9000, follow: true }, false],
    [{ now: 10000, lastUserMove: 0, follow: false }, false],
    [{ now: 10000, lastUserMove: 9000, follow: false }, false],
  ];
  for (const [args, want] of rows) assert.strictEqual(follow.shouldJump(args), want, JSON.stringify(args));
});

test('isUserMove: zoom/move reports right after our own command are not the user', () => {
  const rows = [
    [{ now: 1000, lastCommand: 0 }, true],
    [{ now: 1000, lastCommand: 500 }, false],
    [{ now: 1000, lastCommand: 1000 - follow.COMMAND_SETTLE_MS }, false],
    [{ now: 1000, lastCommand: 999 - follow.COMMAND_SETTLE_MS }, true],
  ];
  for (const [args, want] of rows) assert.strictEqual(follow.isUserMove(args), want, JSON.stringify(args));
});

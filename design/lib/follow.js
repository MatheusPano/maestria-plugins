'use strict';
// "Seguir o Claude": jump to a changed board only when the user has left the
// canvas alone for a while; otherwise just highlight it.

const IDLE_MS = 5000;
// ZoomView reports the scale (onZoom) and the pan (onMove) after our own
// commands too: 220 ms animation + 200 ms settle. Reports inside this window
// are ours, not the user's.
const COMMAND_SETTLE_MS = 700;

function shouldJump({ now, lastUserMove, follow }) {
  return !!follow && now - lastUserMove > IDLE_MS;
}

function isUserMove({ now, lastCommand }) {
  return now - lastCommand > COMMAND_SETTLE_MS;
}

module.exports = { shouldJump, isUserMove, IDLE_MS, COMMAND_SETTLE_MS };

// Step-based movement controller: discrete grid steps, 90-degree turns, and a
// short camera interpolation between the old and new pose.
import { DX, DY } from './grid.js';

export const STEP_TIME = 0.16;  // seconds per step animation
export const TURN_TIME = 0.13;  // seconds per 90-degree turn animation

// Relative move codes.
export const FORWARD = 0, STRAFE_RIGHT = 1, BACK = 2, STRAFE_LEFT = 3;

export class Mover {
  constructor(x, y, dir) {
    this.x = x; this.y = y; this.dir = dir;
    // Camera pose (continuous), animated toward the grid pose.
    this.cx = x + 0.5; this.cy = y + 0.5; this.ca = dir * Math.PI / 2;
    this.anim = null;   // { kind, t, dur, from:{x,y,a}, to:{x,y,a} }
    this.queued = null; // one buffered command while animating
  }

  get busy() { return this.anim !== null; }

  place(x, y, dir) {
    this.x = x; this.y = y; this.dir = dir;
    this.cx = x + 0.5; this.cy = y + 0.5; this.ca = dir * Math.PI / 2;
    this.anim = null; this.queued = null;
  }

  // Target cell of a relative move (FORWARD/STRAFE/BACK) from the grid pose.
  target(rel) {
    const d = (this.dir + rel) & 3;
    return [this.x + DX[d], this.y + DY[d], d];
  }

  // Attempt a step. `level.passable` is the collision check against the map
  // array; it runs before the move is committed, so walls never get entered.
  // Returns { ok, x, y, reason }.
  step(level, rel, isBlockedExtra = null) {
    const [nx, ny] = this.target(rel);
    if (!level.inBounds(nx, ny) || level.isSolid(nx, ny)) return { ok: false, x: nx, y: ny, reason: 'wall' };
    if (level.barrierAt(nx, ny)) return { ok: false, x: nx, y: ny, reason: 'barrier' };
    if (level.monsterAt(nx, ny)) return { ok: false, x: nx, y: ny, reason: 'monster' };
    if (isBlockedExtra && isBlockedExtra(nx, ny)) return { ok: false, x: nx, y: ny, reason: 'blocked' };
    this._animate('step', nx, ny, this.dir);
    this.x = nx; this.y = ny;
    return { ok: true, x: nx, y: ny };
  }

  turn(delta) { // delta = +1 (right) / -1 (left)
    const nd = (this.dir + delta + 4) & 3;
    this._animate('turn', this.x, this.y, nd, delta);
    this.dir = nd;
  }

  _animate(kind, x, y, dir, delta = 0) {
    const from = { x: this.cx, y: this.cy, a: this.ca };
    let ta = from.a;
    if (kind === 'turn') ta = from.a + delta * Math.PI / 2;
    else ta = dir * Math.PI / 2 + Math.round((from.a - dir * Math.PI / 2) / (2 * Math.PI)) * 2 * Math.PI;
    this.anim = { kind, t: 0, dur: kind === 'turn' ? TURN_TIME : STEP_TIME, from, to: { x: x + 0.5, y: y + 0.5, a: ta } };
  }

  // Advance the camera interpolation. Returns true when an animation finished.
  update(dt) {
    if (!this.anim) return false;
    const a = this.anim;
    a.t = Math.min(a.dur, a.t + dt);
    const k = a.t / a.dur;
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // ease in-out
    this.cx = a.from.x + (a.to.x - a.from.x) * e;
    this.cy = a.from.y + (a.to.y - a.from.y) * e;
    this.ca = a.from.a + (a.to.a - a.from.a) * e;
    if (a.t >= a.dur) {
      this.cx = a.to.x; this.cy = a.to.y;
      this.ca = this.dir * Math.PI / 2; // snap exactly to the map axis
      this.anim = null;
      return true;
    }
    return false;
  }

  // Unit vectors of the camera (north = -y).
  forwardVec() { return [Math.sin(this.ca), -Math.cos(this.ca)]; }
  rightVec() { return [Math.cos(this.ca), Math.sin(this.ca)]; }
}

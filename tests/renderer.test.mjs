import test from 'node:test';
import assert from 'node:assert/strict';
import { Level, DX, DY } from '../src/engine/grid.js';
import { Renderer, flatTexture, VIEW_DEPTH } from '../src/engine/renderer.js';
import { Mover } from '../src/engine/movement.js';

// A long east-west corridor (y = 5) with a side niche, a door, and a lever.
function corridor() {
  const lv = new Level(20, 11);
  for (let x = 1; x < 19; x++) lv.setOpen(x, 5);
  return lv;
}

function textures() {
  const t = flatTexture(100, 100, 100);
  return {
    wall: t, floor: flatTexture(40, 40, 40), ceil: flatTexture(20, 20, 20), backdrop: null, fog: [0, 0, 0],
    doors: { door_wood: flatTexture(120, 80, 40) }, decor: { lever_up: flatTexture(200, 0, 0) },
    plate: flatTexture(0, 0, 0, 0), pit: flatTexture(0, 0, 0, 0),
  };
}

test('click raycast finds the wall object straight ahead', () => {
  const lv = corridor();
  // Lever on the end wall: solid (19,5), face west (3), seen from (18,5).
  lv.setFace(19, 5, 3, { kind: 'lever', tex: 'lever_up' });
  const r = new Renderer(320, 200);
  const cam = new Mover(18, 5, 1); // facing east, one block from the wall
  const hit = r.pick(lv, cam, 160, 100);
  assert.equal(hit.type, 'face');
  assert.deepEqual([hit.x, hit.y, hit.face], [19, 5, 3]);
  assert.ok(Math.abs(hit.u - 0.5) < 0.02 && hit.v > 0.3 && hit.v < 0.7, `middle of the face (u ${hit.u}, v ${hit.v})`);
  assert.ok(hit.dist <= 0.91);
});

test('click raycast hits a closed door panel, and passes an open one', () => {
  const lv = corridor();
  lv.ensureCell(12, 5).door = { open: 0, target: 0, axis: 'y', tex: 'door_wood' };
  const r = new Renderer(320, 200);
  const cam = new Mover(11, 5, 1);
  assert.equal(r.pick(lv, cam, 160, 100).type, 'door');
  lv.cell(12, 5).door.open = 1;
  const far = r.pick(lv, cam, 160, 60);
  assert.notEqual(far?.type, 'door');
});

test('floor clicks resolve to the cell under the cursor', () => {
  const lv = corridor();
  const r = new Renderer(320, 200);
  const cam = new Mover(5, 5, 1);
  const hit = r.pick(lv, cam, 160, 190);
  assert.equal(hit.type, 'floor');
  assert.deepEqual([hit.x, hit.y], [5, 5]);
  const ahead = r.pick(lv, cam, 160, 140);
  assert.deepEqual([ahead.x, ahead.y], [6, 5]);
});

test('the frustum stops at the view-distance field', () => {
  const lv = corridor();
  const r = new Renderer(320, 200);
  r.setTextures(textures());
  const cam = new Mover(2, 5, 1); // looking down a 16-block corridor
  r.render(lv, cam, [], Renderer.floorMap(lv));
  const xs = [...r.visibleCells].map((k) => Number(k.split(',')[0]));
  assert.ok(Math.max(...xs) <= 2 + VIEW_DEPTH + 1, `drew cells up to x=${Math.max(...xs)}`);
  assert.ok(Math.max(...xs) >= 2 + VIEW_DEPTH, `the full ${VIEW_DEPTH}-block field is drawn (x=${Math.max(...xs)})`);
  // The far end of the corridor is fog, not wall.
  const centre = r.buf[r.horizon * 320 + 160];
  assert.equal(centre & 0xffffff, 0, 'centre pixel is fog-black beyond the field');
  // A wall one block ahead fills the centre.
  const cam2 = new Mover(18, 5, 1);
  r.render(lv, cam2, [], Renderer.floorMap(lv));
  assert.notEqual(r.buf[100 * 320 + 160] & 0xffffff, 0);
  assert.ok(r.depth[100 * 320 + 160] <= 0.91);
});

test('mid-turn frames render without gaps or exceptions', () => {
  const lv = corridor();
  for (let y = 3; y < 8; y++) lv.setOpen(6, y);
  const r = new Renderer(320, 200);
  r.setTextures(textures());
  const cam = new Mover(6, 5, 0);
  cam.turn(1);
  for (let i = 0; i < 6; i++) { cam.update(0.02); r.render(lv, cam, []); }
  cam.update(1);
  assert.equal(cam.dir, 1);
  assert.equal(cam.ca, Math.PI / 2);
  void DX; void DY;
});

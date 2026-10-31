// Wick bundles: groups of instances you can drop into a project in one step (the Player, a street lamp...), plus the
// helpers that turn a selection into a bundle of your own and back into instances.

import { libraryScriptSource } from './libscripts.js';

const GREY = [0.62, 0.64, 0.7];

/** The Player's limbs: name, shape and size. Positions are worked out below from these lengths. */
const LIMBS = {
  Hips: ['Block', [1.5, 0.5, 0.9]], Stomach: ['Block', [1.4, 0.5, 0.85]], Chest: ['Block', [1.7, 0.9, 0.95]],
  Neck: ['Cylinder', [0.4, 0.35, 0.4]], Head: ['Block', [1.2, 1.2, 1.2]],
  UpperArm: ['Cylinder', [0.5, 1.1, 0.5]], LowerArm: ['Cylinder', [0.45, 1.0, 0.45]], Hand: ['Ball', [0.5, 0.5, 0.5]],
  UpperLeg: ['Cylinder', [0.62, 1.2, 0.62]], LowerLeg: ['Cylinder', [0.55, 1.15, 0.55]], Foot: ['Block', [0.7, 0.3, 1.1]],
};

/** Builds the Player model standing on the ground at origin = [x, groundY, z]. */
async function buildPlayer(dm, parent, origin) {
  const [ox, gy, oz] = origin;
  const model = dm.create('Model', parent, { Name: 'Player' });
  const make = (name, shape, size, position, extra = {}) => dm.create('Part', model, {
    Name: name, Shape: shape, Size: size, Position: [ox + position[0], gy + position[1], oz + position[2]],
    Color: GREY, Anchored: true, CanCollide: false, ...extra,
  });
  const size = (n) => LIMBS[n][1];
  const root = dm.create('Part', model, {
    Name: 'Root', Shape: 'Cylinder', Size: [1.8, 5.8, 1.8], Position: [ox, gy + 2.9, oz], Transparency: 1, CastShadow: false,
    LockRotation: true, Friction: 0, Bounciness: 0, Density: 1,
  });

  // Standing pose, from the same formulas the controller uses, so the model looks right before Play.
  const legs = size('UpperLeg')[1] + size('LowerLeg')[1], foot = size('Foot')[1];
  const hipsY = foot + legs * 0.97;
  let joint = hipsY - size('Hips')[1] * 0.35;
  const centres = {};
  for (const n of ['Hips', 'Stomach', 'Chest', 'Neck']) { centres[n] = joint + size(n)[1] / 2; joint += size(n)[1]; }
  centres.Head = joint + size('Head')[1] / 2 - 0.05;
  for (const n of ['Hips', 'Stomach', 'Chest', 'Neck', 'Head']) make(n, LIMBS[n][0], size(n), [0, centres[n], 0]);

  const shoulderX = size('Chest')[0] * 0.5 + size('UpperArm')[0] * 0.45, shoulderY = centres.Chest + size('Chest')[1] * 0.36;
  const hipX = size('Hips')[0] * 0.3;
  for (const [side, sign] of [['Left', -1], ['Right', 1]]) {
    const u = size('UpperArm')[1], l = size('LowerArm')[1];
    make(`${side}UpperArm`, 'Cylinder', size('UpperArm'), [sign * shoulderX, shoulderY - u / 2, 0]);
    make(`${side}LowerArm`, 'Cylinder', size('LowerArm'), [sign * shoulderX, shoulderY - u - l / 2, 0]);
    make(`${side}Hand`, 'Ball', size('Hand'), [sign * shoulderX, shoulderY - u - l - size('Hand')[1] * 0.1, 0]);
    const ul = size('UpperLeg')[1], ll = size('LowerLeg')[1], ankle = foot;
    make(`${side}UpperLeg`, 'Cylinder', size('UpperLeg'), [sign * hipX, ankle + ll + ul / 2, 0]);
    make(`${side}LowerLeg`, 'Cylinder', size('LowerLeg'), [sign * hipX, ankle + ll / 2, 0]);
    make(`${side}Foot`, 'Block', size('Foot'), [sign * hipX, foot / 2, 0.25]);
  }
  const rig = make('CameraRig', 'Block', [0.5, 0.5, 0.5], [0, centres.Head + 0.6, 0], { Transparency: 1, CastShadow: false });
  try { dm.create('CameraPoint', rig, { Offset: [0, 0, -14], Lock: 'Part', FieldOfView: 70 }); } catch { /* the project already has a CameraPoint, which keeps the view */ }
  dm.create('Script', model, { Name: 'PlayerController', Source: await libraryScriptSource('player_controller') });
  return model;
}

function buildStreetLamp(dm, parent, [x, y, z]) {
  const lamp = dm.create('Model', parent, { Name: 'StreetLamp' });
  const dark = [0.16, 0.17, 0.2];
  dm.create('Part', lamp, { Name: 'Pole', Shape: 'Cylinder', Size: [0.45, 9, 0.45], Position: [x, y + 4.5, z], Anchored: true, Material: 'Metal', Color: dark });
  dm.create('Part', lamp, { Name: 'Arm', Size: [2.4, 0.3, 0.3], Position: [x + 1.1, y + 9.1, z], Anchored: true, Material: 'Metal', Color: dark });
  const bulb = dm.create('Part', lamp, { Name: 'Bulb', Shape: 'Ball', Size: [0.9, 0.9, 0.9], Position: [x + 2.1, y + 8.75, z], Anchored: true, Material: 'Neon', Color: [1, 0.82, 0.5], CastShadow: false });
  dm.create('PointLight', bulb, { Color: [1, 0.82, 0.55], Brightness: 220, Range: 45 });
  return lamp;
}

function buildCrates(dm, parent, [x, y, z]) {
  const stack = dm.create('Model', parent, { Name: 'CratePyramid' });
  let n = 0;
  for (let layer = 0; layer < 3; layer++) {
    const count = 3 - layer;
    for (let i = 0; i < count; i++) {
      dm.create('Part', stack, {
        Name: `Crate${++n}`, Size: [2, 2, 2], Material: 'Wood', Color: [1, 1, 1], Density: 0.6, Friction: 0.8, Bounciness: 0.05,
        Position: [x + (i - (count - 1) / 2) * 2.05, y + 1 + layer * 2.02, z],
      });
    }
  }
  return stack;
}

export const WICK_BUNDLES = [
  { id: 'player', name: 'Player', description: 'A 17-limb character: acceleration, run, crouch, coyote-time jump, procedural gait with foot IK and arm IK, and an orbit camera that avoids walls. Every limb is its own Part.', build: buildPlayer },
  { id: 'street_lamp', name: 'Street Lamp', description: 'A pole and arm with a glowing bulb and a PointLight.', build: buildStreetLamp },
  { id: 'crate_pyramid', name: 'Crate Pyramid', description: 'Six wooden crates stacked in a pyramid, ready to knock over.', build: buildCrates },
];

/** Inserts a built-in bundle under parent. origin = [x, groundY, z]. Resolves with the new top instance. */
export async function insertBuiltinBundle(dm, id, parent, origin) {
  const b = WICK_BUNDLES.find((x) => x.id === id);
  if (!b) throw new Error(`Unknown bundle "${id}"`);
  return b.build(dm, parent, origin);
}

// ---- custom bundles (saved from a selection, stored in the library as kind 'bundle') ----

/** Serialises instances into bundle data. Positions are kept as they are. */
export function bundleFromInstances(dm, name, instances) {
  const tops = instances.filter((i) => !instances.some((o) => o !== i && dm.isAncestor(o, i)));
  return { format: 'wick-bundle', version: 1, name, nodes: tops.map((i) => dm.serializeNode(i)) };
}

/** Puts a bundle's instances (fresh ids) under parent. Resolves with the new instances. */
export function instantiateBundle(dm, data, parent) {
  if (data?.format !== 'wick-bundle') throw new Error('This is not a Wick bundle');
  return data.nodes.map((n) => dm.instantiate(n, parent));
}

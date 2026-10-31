// Wick Engine physics: one Havok body per collidable Part while a game is running.
// The physics world exists only between Play and Stop, so edit mode costs nothing.
// Surfaces grip, bounce and roll according to their Material (see SURFACES), and moving bodies feel air drag,
// so nothing slides or rolls forever.
// The world is stepped here at a fixed rate (see stepper.js), never by the raw frame time, so lag cannot make physics
// unstable or slow the game down. What is drawn is interpolated between the last two steps.

import { SURFACES } from './datamodel.js';
import { FixedStepper } from './stepper.js';

const B = globalThis.BABYLON;

/** Parts are built at "stud" scale, so real-world gravity reads as floaty. Workspace.Gravity is multiplied by this. */
export const GRAVITY_SCALE = 3;

/** Seconds per physics step. Every step is exactly this long, whatever the frame rate. */
export const PHYSICS_STEP = 1 / 60;

const IMPACT_COOLDOWN_MS = 90; // one sound per pair of parts in this window (a contact reports once per touch point)

export class WickPhysics {
  constructor(scene, havok) {
    this.scene = scene;
    this.havok = havok;
    this.plugin = null;
    this.bodies = new Map(); // instance id -> { body, shape, mesh, material, mass }
    this.listening = new Set(); // instance ids whose Touched signal has a listener
    this.onTouched = null; // (id, otherId) => void
    this.onImpact = null; // (materialA, materialB, strength, [x, y, z], mass) => void
    this.active = false;
    this._lastImpact = new Map();
    this._impactObs = null;
    this.paused = false;
    this.dynamic = new Set(); // records of bodies that physics moves, with their last two stepped transforms
    this.stepper = new FixedStepper({ step: PHYSICS_STEP });
    this.onSlow = null; // (seconds) the machine could not keep up and some simulated time was given up
  }

  get count() { return this.bodies.size; }

  start(gravity) {
    // false: Havok steps by its own fixed time step, not by whatever the last frame took.
    this.plugin = new B.HavokPlugin(false, this.havok);
    this.plugin.setTimeStep(PHYSICS_STEP);
    this.scene.enablePhysics(new B.Vector3(0, -gravity * GRAVITY_SCALE, 0), this.plugin);
    this.scene.physicsEnabled = false; // Babylon must not step it as well: update() does
    this.paused = false;
    this.stepper.reset();
    this._impactObs = this.plugin.onCollisionObservable.add((ev) => this._impact(ev));
    this._lastImpact.clear();
    this.active = true;
  }

  stop() {
    for (const id of [...this.bodies.keys()]) this.remove(id);
    this.listening.clear();
    this.dynamic.clear();
    if (this.active) {
      this.plugin.onCollisionObservable.remove(this._impactObs);
      this.scene.disablePhysicsEngine();
    }
    this._impactObs = null;
    this.plugin = null;
    this.active = false;
  }

  /** Freezes or resumes the simulation. Bodies keep their velocities across a pause. */
  setPaused(paused) {
    this.paused = paused;
    this.stepper.reset(); // the time spent paused is not lag to be paid back
  }

  /**
   * Advances the simulation by dt seconds of real time, in whole fixed steps, then draws the bodies between their
   * last two stepped positions. Call once per frame, after scripts have run and before rendering.
   */
  update(dt) {
    const engine = this.active && this.scene.getPhysicsEngine();
    if (!engine || this.paused) return;
    const run = () => {
      for (const r of this.dynamic) { r.p0.copyFrom(r.p1); r.q0.copyFrom(r.q1); }
      this.scene.onBeforePhysicsObservable.notifyObservers(this.scene);
      if (typeof engine._step === 'function') engine._step(PHYSICS_STEP);
      else this.plugin.executeStep(PHYSICS_STEP, engine._physicsBodies);
      this.scene.onAfterPhysicsObservable.notifyObservers(this.scene);
      for (const r of this.dynamic) { r.p1.copyFrom(r.mesh.position); r.q1.copyFrom(r.mesh.rotationQuaternion); }
    };
    const { dropped } = this.stepper.advance(dt, run);
    if (dropped > 0) this.onSlow?.(dropped);
    const a = this.stepper.alpha;
    for (const r of this.dynamic) {
      B.Vector3.LerpToRef(r.p0, r.p1, a, r.mesh.position);
      B.Quaternion.SlerpToRef(r.q0, r.q1, a, r.mesh.rotationQuaternion);
    }
  }

  setGravity(g) { this.scene.getPhysicsEngine()?.setGravity(new B.Vector3(0, -g * GRAVITY_SCALE, 0)); }

  /** Convex hull of a Mesh part's geometry at its real size. Built from a throwaway mesh so scaling is exact. */
  _hull(mesh, size) {
    const pos = mesh.getVerticesData(B.VertexBuffer.PositionKind), idx = mesh.getIndices();
    const scaled = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) { scaled[i] = pos[i] * size[0]; scaled[i + 1] = pos[i + 1] * size[1]; scaled[i + 2] = pos[i + 2] * size[2]; }
    const tmp = new B.Mesh('wick-hull-source', this.scene);
    const vd = new B.VertexData();
    vd.positions = scaled;
    vd.indices = idx;
    vd.applyToMesh(tmp);
    try { return new B.PhysicsShapeConvexHull(tmp, this.scene); } finally { tmp.dispose(); }
  }

  _shape(p, mesh) {
    const [sx, sy, sz] = p.Size;
    if (p.Shape === 'Mesh' && p.CollisionFidelity === 'Hull') {
      try { return { shape: this._hull(mesh, p.Size), volume: sx * sy * sz * 0.6 }; } catch { /* fall back to the bounding box */ }
    }
    if (p.Shape === 'Ball') {
      return { shape: new B.PhysicsShapeSphere(B.Vector3.Zero(), sx / 2, this.scene), volume: (Math.PI * sx ** 3) / 6 };
    }
    if (p.Shape === 'Cylinder') {
      const r = Math.max(sx, sz) / 2;
      return {
        shape: new B.PhysicsShapeCylinder(new B.Vector3(0, -sy / 2, 0), new B.Vector3(0, sy / 2, 0), r, this.scene),
        volume: Math.PI * r * r * sy,
      };
    }
    return {
      shape: new B.PhysicsShapeBox(B.Vector3.Zero(), B.Quaternion.Identity(), new B.Vector3(sx, sy, sz), this.scene),
      volume: sx * sy * sz,
    };
  }

  /** Builds (or rebuilds) the body for a Part. Parts with CanCollide off are visual only. */
  add(inst, mesh) {
    this.remove(inst.id);
    const p = inst.props;
    if (!p.CanCollide) return;
    const surface = SURFACES[p.Material] ?? SURFACES.Plastic;
    const { shape, volume } = this._shape(p, mesh);
    const friction = p.Friction * surface.grip;
    shape.material = {
      friction,
      staticFriction: friction * 1.25, // it takes more force to start sliding than to keep sliding
      restitution: p.Bounciness * surface.bounce,
      frictionCombine: B.PhysicsMaterialCombineMode.GEOMETRIC_MEAN,
      restitutionCombine: B.PhysicsMaterialCombineMode.ARITHMETIC_MEAN,
    };
    const body = new B.PhysicsBody(mesh, p.Anchored ? B.PhysicsMotionType.STATIC : B.PhysicsMotionType.DYNAMIC, false, this.scene);
    body.shape = shape;
    body.disablePreStep = true;
    const rec = { body, shape, mesh, material: p.Material, mass: 0 };
    if (!p.Anchored) {
      rec.mass = Math.max(0.05, volume * p.Density);
      // Zero inertia means infinite: the body slides and jumps but never tips over (characters).
      body.setMassProperties(p.LockRotation ? { mass: rec.mass, inertia: B.Vector3.ZeroReadOnly } : { mass: rec.mass });
      // Air drag grows as a part gets lighter and smaller. Round parts get rolling resistance, which a rigid-body
      // solver does not model on its own.
      body.setLinearDamping(Math.min(2, 0.06 + 0.06 / (p.Density * Math.cbrt(volume))));
      body.setAngularDamping({ Block: 0.08, Cylinder: 0.15, Ball: 0.18 }[p.Shape] + surface.roll);
      this._listenForImpacts(body);
      rec.p0 = mesh.position.clone(); rec.p1 = mesh.position.clone();
      rec.q0 = mesh.rotationQuaternion.clone(); rec.q1 = mesh.rotationQuaternion.clone();
      this.dynamic.add(rec);
    }
    this.bodies.set(inst.id, rec);
    if (this.listening.has(inst.id)) this._watch(inst.id, rec);
  }

  remove(id) {
    const rec = this.bodies.get(id);
    if (!rec) return;
    this.bodies.delete(id);
    this.dynamic.delete(rec);
    try { rec.body.dispose(); rec.shape.dispose(); } catch { /* mesh may already be disposed */ }
  }

  /** Moves a body to its mesh's current transform (used when a script sets Position or Rotation). */
  teleport(id) {
    const rec = this.bodies.get(id);
    if (!rec) return;
    rec.body.disablePreStep = false;
    this.scene.onAfterPhysicsObservable.addOnce(() => { rec.body.disablePreStep = true; });
    if (rec.p0) { // the script's value is the truth now: nothing to interpolate from
      rec.p0.copyFrom(rec.mesh.position); rec.p1.copyFrom(rec.mesh.position);
      rec.q0.copyFrom(rec.mesh.rotationQuaternion); rec.q1.copyFrom(rec.mesh.rotationQuaternion);
    }
  }

  // ---------------------------------------------------------------- collisions

  /** Dynamic bodies report only the moment a contact starts, which is all impact sounds need. */
  _listenForImpacts(body) {
    try {
      this.plugin.setEventMask(body, this.havok.EventType.COLLISION_STARTED.value);
    } catch {
      body.setCollisionCallbackEnabled(true);
    }
  }

  _watch(id, rec) {
    if (rec.watching) return;
    rec.watching = true;
    rec.body.setCollisionCallbackEnabled(true);
    rec.body.getCollisionObservable().add((ev) => {
      if (ev.type !== 'COLLISION_STARTED') return;
      const other = ev.collidedAgainst?.transformNode?.metadata?.wickId;
      if (other) this.onTouched?.(id, other);
    });
  }

  listen(id) {
    this.listening.add(id);
    const rec = this.bodies.get(id);
    if (rec) this._watch(id, rec);
  }

  /**
   * Turns a started contact into an impact: how hard it hit (as a change in relative speed, in units per second)
   * and which two materials met. The solver's impulse is used when Havok reports one, otherwise the bodies' speeds.
   */
  _impact(ev) {
    if (ev.type !== 'COLLISION_STARTED' || !this.onImpact) return;
    const ia = ev.collider?.transformNode?.metadata?.wickId;
    const ib = ev.collidedAgainst?.transformNode?.metadata?.wickId;
    const a = this.bodies.get(ia), b = this.bodies.get(ib);
    if (!a || !b) return;

    const key = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`;
    const now = performance.now();
    if (now - (this._lastImpact.get(key) ?? 0) < IMPACT_COOLDOWN_MS) return;
    if (this._lastImpact.size > 512) this._lastImpact.clear();
    this._lastImpact.set(key, now);

    const mass = a.mass && b.mass ? Math.min(a.mass, b.mass) : a.mass || b.mass;
    if (!mass) return; // two anchored parts never make sound
    const reduced = a.mass && b.mass ? (a.mass * b.mass) / (a.mass + b.mass) : mass;
    let strength = ev.impulse > 0 ? ev.impulse / reduced : 0;
    if (!strength) {
      const va = a.body.getLinearVelocity(), vb = b.body.getLinearVelocity();
      strength = va.subtract(vb).length();
    }
    const at = ev.point ?? (a.mass ? a.mesh : b.mesh).absolutePosition;
    this.onImpact(a.material, b.material, strength, [at.x, at.y, at.z], mass);
  }

  getVelocity(id) {
    const v = this.bodies.get(id)?.body.getLinearVelocity();
    return v ? [v.x, v.y, v.z] : [0, 0, 0];
  }

  setVelocity(id, [x, y, z]) { this.bodies.get(id)?.body.setLinearVelocity(new B.Vector3(x, y, z)); }

  applyImpulse(id, [x, y, z]) {
    const rec = this.bodies.get(id);
    if (rec) rec.body.applyImpulse(new B.Vector3(x, y, z), rec.mesh.absolutePosition);
  }
}

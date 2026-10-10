// Wick Engine physics: one Havok body per collidable Part while a game is running.
// The physics world exists only between Play and Stop, so edit mode costs nothing.

const B = globalThis.BABYLON;

export class WickPhysics {
  constructor(scene, havok) {
    this.scene = scene;
    this.havok = havok;
    this.bodies = new Map(); // instance id -> { body, shape, mesh }
    this.listening = new Set(); // instance ids whose Touched signal has a listener
    this.onTouched = null; // (id, otherId) => void
    this.active = false;
  }

  get count() { return this.bodies.size; }

  start(gravity) {
    this.scene.enablePhysics(new B.Vector3(0, -gravity, 0), new B.HavokPlugin(true, this.havok));
    this.active = true;
  }

  stop() {
    for (const id of [...this.bodies.keys()]) this.remove(id);
    this.listening.clear();
    if (this.active) this.scene.disablePhysicsEngine();
    this.active = false;
  }

  setGravity(g) { this.scene.getPhysicsEngine()?.setGravity(new B.Vector3(0, -g, 0)); }

  _shape(p) {
    const [sx, sy, sz] = p.Size;
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
    const { shape, volume } = this._shape(p);
    shape.material = { friction: p.Friction, restitution: p.Bounciness };
    const body = new B.PhysicsBody(mesh, p.Anchored ? B.PhysicsMotionType.STATIC : B.PhysicsMotionType.DYNAMIC, false, this.scene);
    body.shape = shape;
    if (!p.Anchored) body.setMassProperties({ mass: Math.max(0.05, volume * p.Density) });
    body.disablePreStep = true;
    const rec = { body, shape, mesh };
    this.bodies.set(inst.id, rec);
    if (this.listening.has(inst.id)) this._watch(inst.id, rec);
  }

  remove(id) {
    const rec = this.bodies.get(id);
    if (!rec) return;
    this.bodies.delete(id);
    try { rec.body.dispose(); rec.shape.dispose(); } catch { /* mesh may already be disposed */ }
  }

  /** Moves a body to its mesh's current transform (used when a script sets Position or Rotation). */
  teleport(id) {
    const rec = this.bodies.get(id);
    if (!rec) return;
    rec.body.disablePreStep = false;
    this.scene.onAfterPhysicsObservable.addOnce(() => { rec.body.disablePreStep = true; });
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

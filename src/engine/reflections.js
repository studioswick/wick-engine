// Wick Engine reflections: Metal and Glass reflect the actual scene, not a canned environment picture.
// Every reflective Part near the camera gets its own cube-map probe placed at the Part, rendered with the Part
// itself left out (a mesh cannot reflect a texture it is drawn into). Parts without a probe, and every other
// material, reflect a sky-only probe that follows Lighting. Quality tiers decide how many probes exist and how
// sharp they are; tiers with none fall back to a plain glossy shine (see materials.js).

const B = globalThis.BABYLON;

const REASSIGN_MS = 400; // how often probes are handed to the reflective Parts nearest the camera
const MAX_DISTANCE = 150; // farther Parts keep the sky reflection

export class WickReflections {
  constructor(world) {
    this.world = world;
    this.tier = null;
    this.sky = null;
    this.slots = []; // { probe, target (instance id | null), dirty, version }
    this.assigned = new Map(); // instance id -> slot
    this.version = 0; // bumps whenever the scene changes
    this._next = 0;
    this._frame = 0;
    this._lastAssign = 0;
  }

  /** The scene changed: probes re-render the next time they are due. */
  touch() { this.version++; }

  /** Lighting changed: the sky has to be drawn again. */
  invalidateSky() {
    this.sky?.cubeTexture.resetRefreshCounter();
    this.touch();
  }

  /** Drops every probe assignment (the scene was rebuilt). */
  reset() {
    for (const s of this.slots) s.target = null;
    this.assigned.clear();
    this._lastAssign = 0;
  }

  textureFor(id) {
    return (this.assigned.get(id)?.probe ?? this.sky)?.cubeTexture ?? null;
  }

  forget(id) {
    const s = this.assigned.get(id);
    if (s) s.target = null;
    this.assigned.delete(id);
  }

  /** Applies a quality tier. Returns true when the reflection textures changed. */
  setTier(t) {
    const cur = this.tier;
    if (cur && cur.probes === t.probes && cur.probeSize === t.probeSize && cur.skySize === t.skySize) return false;
    this._dispose();
    this.tier = t;
    if (t.probes > 0) {
      this.sky = this._probe(t.skySize);
      this.sky.cubeTexture.renderListPredicate = (m) => m === this.world.sky;
    }
    return true;
  }

  _dispose() {
    for (const s of this.slots) s.probe.dispose();
    this.slots = [];
    this.assigned.clear();
    this.sky?.dispose();
    this.sky = null;
  }

  _probe(size) {
    const caps = this.world.engine.getCaps();
    const hdr = !!(caps.textureHalfFloatRender && caps.textureHalfFloatLinearFiltering); // keeps the sun's glint bright
    return new B.ReflectionProbe('wick-probe', size, this.world.scene, true, hdr);
  }

  _newSlot() {
    const slot = { probe: this._probe(this.tier.probeSize), target: null, dirty: true, version: -1 };
    const sky = this.world.sky;
    slot.probe.cubeTexture.renderListPredicate = (m) => m === sky || (!!m.metadata?.wickId && m.metadata.wickId !== slot.target);
    this.slots.push(slot);
    return slot;
  }

  _assign() {
    const { world } = this;
    const cam = world.camera.position;
    const near = [];
    for (const [id, mesh] of world.meshes) {
      const material = world.dm.find(id)?.props.Material;
      if (material !== 'Metal' && material !== 'Glass') continue;
      const d = B.Vector3.DistanceSquared(cam, mesh.position);
      if (d < MAX_DISTANCE * MAX_DISTANCE) near.push([d, id]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const want = new Set(near.slice(0, this.tier.probes).map((e) => e[1]));

    for (const s of this.slots) {
      if (s.target !== null && !want.has(s.target)) {
        const id = s.target;
        s.target = null;
        this.assigned.delete(id);
        world.materials.refreshReflection(id);
      }
    }
    for (const id of want) {
      if (this.assigned.has(id)) continue;
      const slot = this.slots.find((s) => s.target === null) ?? (this.slots.length < this.tier.probes ? this._newSlot() : null);
      if (!slot) break;
      slot.target = id;
      slot.dirty = true;
      this.assigned.set(id, slot);
      world.materials.refreshReflection(id);
    }
  }

  /** Called every frame before rendering. At most one probe is redrawn per refresh, which bounds the cost. */
  update() {
    if (!this.sky) return;
    const now = performance.now();
    if (now - this._lastAssign > REASSIGN_MS) {
      this._lastAssign = now;
      this._assign();
    }
    if (++this._frame % this.tier.every !== 0) return;
    const moving = this.world.playing && !this.world.paused;
    const n = this.slots.length;
    for (let i = 0; i < n; i++) {
      const slot = this.slots[(this._next + i) % n];
      if (slot.target === null || !(slot.dirty || moving || slot.version !== this.version)) continue;
      const mesh = this.world.meshes.get(slot.target);
      if (!mesh) continue;
      slot.probe.position.copyFrom(mesh.position);
      slot.probe.cubeTexture.resetRefreshCounter();
      slot.dirty = false;
      slot.version = this.version;
      this._next = (this._next + i + 1) % n;
      break;
    }
  }
}

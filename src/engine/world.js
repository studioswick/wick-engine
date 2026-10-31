// Wick Engine world: the Babylon scene that mirrors the data model.
// Owns rendering, the editor camera, selection/gizmos (single, multi and snapping), the CameraPoint, and the graphics
// quality tiers that WickGuard steps through when a device struggles. The sky, clouds and day/night cycle live in
// sky.js, the grass blades in grass.js.

import { WickMaterials } from './materials.js';
import { WickReflections } from './reflections.js';
import { WickSky } from './sky.js';
import { WickGrass } from './grass.js';
import { builtinMesh, builtinMeshName } from './library.js';
import { assetIdOf } from './assets.js';

const B = globalThis.BABYLON;

const DEG = Math.PI / 180;

/**
 * Graphics quality tiers. probes is how many Parts can have their own live reflection (0 turns reflections off),
 * probeSize and skySize are cube-map face sizes, every is how many frames pass between probe refreshes,
 * aniso is texture filtering and bump toggles normal maps. clouds: 3 full volumetric, 2 lite volumetric, 1 skybox
 * imitation. grass: blade settings, or null for none.
 */
export const TIERS = [
  { name: 'High', dprCap: 2, msaa: 4, bloom: true, fxaa: false, shadows: 2048, probes: 5, probeSize: 256, skySize: 256, every: 1, aniso: 8, bump: true, clouds: 3, grass: { radius: 48, density: 5, segments: 3, height: 1 } },
  { name: 'Medium', dprCap: 1.5, msaa: 2, bloom: true, fxaa: false, shadows: 1024, probes: 2, probeSize: 128, skySize: 128, every: 2, aniso: 4, bump: true, clouds: 2, grass: { radius: 28, density: 2, segments: 1, height: 0.8 } },
  { name: 'Low', dprCap: 1, msaa: 0, bloom: false, fxaa: true, shadows: 1024, probes: 0, probeSize: 0, skySize: 0, every: 1, aniso: 1, bump: false, clouds: 1, grass: null },
  { name: 'Minimal', dprCap: 0.7, msaa: 0, bloom: false, fxaa: false, shadows: 0, probes: 0, probeSize: 0, skySize: 0, every: 1, aniso: 1, bump: false, clouds: 1, grass: null },
];

/** Default snapping increments: studs to move, degrees to rotate, studs to scale. 0 turns a snap off. */
export const DEFAULT_SNAP = { move: 1, rotate: 15, scale: 0.5 };

// DOM button index (0 left, 1 middle, 2 right) to the names scripts see.
const MOUSE_NAMES = ['MouseButton1', 'MouseButton3', 'MouseButton2'];

export class WickWorld {
  constructor(canvas, dm) {
    this.canvas = canvas;
    this.dm = dm;
    this.tier = 0;
    this.playing = false;
    this.paused = false; // set by the runtime while a paused game is on screen
    this.tool = 'select';
    this.selection = []; // instances, the last one is the primary
    this.snap = { ...DEFAULT_SNAP };
    this.meshes = new Map(); // instance id -> mesh
    this.lights = new Map(); // instance id -> PointLight
    this.keys = new Set();
    this.shadowGen = null;
    this.pipeline = null;
    this.cameraIcon = null;
    this._drag = null;
    this._multi = false;
    this._dragging = false;
    this._ready = false;
    this._warned = new Set();

    // Callbacks set by the Studio and the runtime.
    this.hooks = {}; // created(inst, mesh) changed(inst, prop, mesh) willDispose(inst)
    this.onPick = null; // (inst | null, additive)
    this.onContextRequest = null; // (inst | null, clientX, clientY)
    this.onTransformCommit = null; // ()
    this.onFrame = null; // (frameMs)
    this.onMouseButton = null; // ('MouseButton1' | 'MouseButton2' | 'MouseButton3', isDown)
    this.onMouseMove = null; // (dx, dy) while playing and the right button is held
    this.onWheel = null; // (steps) while playing
    this.onContextLost = null;
    this.onWarn = null; // (text)

    this.engine = new B.Engine(canvas, true, { stencil: true, powerPreference: 'high-performance' }, false);
    this.scene = new B.Scene(this.engine);
    this.scene.skipPointerMovePicking = true;
    this.scene.clearColor = new B.Color4(0.04, 0.05, 0.08, 1);
    // Tone mapping is per material (not a post-process) so the Void texture can opt out of it.
    const ip = this.scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.contrast = 1.1;
    const info = this.engine.getGlInfo?.() ?? {};
    this.gpuName = info.renderer || 'unknown GPU';
    this.softwareRenderer = /swiftshader|llvmpipe|software|basic render/i.test(this.gpuName);

    this.materials = new WickMaterials(this.scene, dm.assets);
    this.reflections = new WickReflections(this);
    this.materials.reflections = this.reflections;

    this._initCamera();
    this.sky = new WickSky(this);
    this.skyMesh = this.sky.mesh;
    this.grass = new WickGrass(this);
    this._initSelection();
    this._bindDataModel();
    this._bindPointer();
    this._ready = true;
    this._applyQuality();

    this.engine.onContextLostObservable.add(() => this.onContextLost?.());
    this.scene.onAfterRenderObservable.add(() => this.onFrame?.(this.engine.getDeltaTime()));
    this.scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.1);
      if (!this.playing || this.paused) this.driveCamera(); // while a game runs, the runtime calls it after the simulation
      this._flyCamera();
      this._applyMulti();
      this._updateCameraIcon();
      this.sky.update(dt, this.playing && !this.paused);
      this.grass.update();
      this.reflections.update();
    });
    new ResizeObserver(() => this.engine.resize()).observe(canvas.parentElement);
    this.engine.runRenderLoop(() => this.scene.render());
  }

  // ---------------------------------------------------------------- lighting and sky

  applyLighting() { this.sky.apply(); }

  get sunHeight() { return this.sky.sunHeight; }

  /** Called by the sky whenever the sun moved: shadows switch on and off, and fade near the horizon. */
  onSunChanged() {
    if (!this._ready) return;
    if (this._shadowsWanted !== this._wantShadows()) { this._applyQuality(); return; }
    if (this.shadowGen) this.shadowGen.darkness = 0.25 + 0.75 * (1 - Math.min(1, Math.max(0, (this.sunHeight - 0.03) / 0.19)));
  }

  // ---------------------------------------------------------------- quality tiers

  setTier(tier) {
    const next = Math.min(TIERS.length - 1, Math.max(0, tier));
    if (next === this.tier) return; // the constructor already applied the starting tier
    this.tier = next;
    this._applyQuality();
  }

  _wantShadows() {
    return TIERS[this.tier].shadows > 0 && this.dm.lighting.props.ShadowsEnabled && this.sunHeight > 0.03;
  }

  _applyQuality() {
    const t = TIERS[this.tier];
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, t.dprCap));
    const bloom = t.bloom && this.dm.lighting.props.Bloom;
    if (t.msaa > 0 || bloom || t.fxaa) {
      if (!this.pipeline) this._createPipeline();
      this.pipeline.samples = Math.max(1, t.msaa);
      this.pipeline.fxaaEnabled = t.fxaa;
      this.pipeline.bloomEnabled = bloom;
    } else if (this.pipeline) {
      this.pipeline.dispose();
      this.pipeline = null;
    }
    this._applyShadows(t.shadows);
    this.sky.setTier(t);
    this.grass.setTier(t.grass);

    // Reflection textures first, then the materials that read them.
    this.reflections.setTier(t);
    if (this.materials.setLook({ reflect: t.probes > 0, bump: t.bump, aniso: t.aniso })) {
      for (const [id, mesh] of this.meshes) {
        const inst = this.dm.find(id);
        if (inst) mesh.material = this.materials.forPart(inst);
      }
    }
  }

  _createPipeline() {
    const p = new B.DefaultRenderingPipeline('wick-fx', true, this.scene, [this.camera]);
    p.bloomThreshold = 0.8;
    p.bloomWeight = 0.4;
    p.bloomKernel = 48;
    p.bloomScale = 0.5;
    p.imageProcessingEnabled = false; // materials tone-map themselves (see the constructor)
    this.pipeline = p;
  }

  /**
   * The shadow generator is created once and then resized or switched off, never rebuilt, so raising the quality
   * mid-game cannot leave stale shadow state behind. Bias scales with the map size because texel size does.
   */
  _applyShadows(size) {
    this._shadowsWanted = this._wantShadows();
    this.sky.sun.shadowEnabled = this._shadowsWanted;
    if (!this._shadowsWanted) return;
    let g = this.shadowGen;
    if (!g) {
      g = new B.ShadowGenerator(size, this.sky.sun);
      g.usePercentageCloserFiltering = true;
      g.filteringQuality = B.ShadowGenerator.QUALITY_MEDIUM;
      this.shadowGen = g;
      for (const [id, mesh] of this.meshes) if (this.dm.find(id)?.props.CastShadow) g.addShadowCaster(mesh);
    } else if (g.mapSize !== size) {
      g.mapSize = size;
    }
    const k = 2048 / size;
    g.bias = 0.0006 * k;
    g.normalBias = 0.02 * k;
    g.darkness = 0.25 + 0.75 * (1 - Math.min(1, Math.max(0, (this.sunHeight - 0.03) / 0.19)));
  }

  // ---------------------------------------------------------------- cameras

  _initCamera() {
    const cam = new B.UniversalCamera('wick-cam', new B.Vector3(20, 14, -26), this.scene);
    cam.minZ = 0.1;
    cam.maxZ = 1500;
    cam.fov = 1.0;
    cam.inputs.clear();
    cam.setTarget(new B.Vector3(0, 3, 0));
    this.camera = cam;
  }

  setKey(code, down) { if (down) this.keys.add(code); else this.keys.delete(code); }

  /** While a game runs, a CameraPoint in the Workspace owns the camera. */
  get cameraPoint() { return this.playing ? this.dm.cameraPoint : null; }
  get lookLocked() { return this.cameraPoint?.props.Lock === 'Part'; }

  /** Where a CameraPoint puts the camera: { position, forward }, or null if its Part has no mesh. */
  _cameraPose(cp) {
    const mesh = cp.parent && this.meshes.get(cp.parent.id);
    if (!mesh) return null;
    const q = mesh.rotationQuaternion;
    const m = new B.Matrix();
    q.toRotationMatrix(m);
    const o = cp.props.Offset;
    const position = mesh.position.add(B.Vector3.TransformNormal(new B.Vector3(o[0], o[1], o[2]), m));
    return { position, forward: B.Vector3.TransformNormal(new B.Vector3(0, 0, 1), m), mesh };
  }

  /** Puts the camera where the CameraPoint says. */
  driveCamera() {
    const cp = this.cameraPoint;
    if (!cp) return;
    const pose = this._cameraPose(cp);
    if (!pose) return;
    this.camera.position.copyFrom(pose.position);
    if (cp.props.Lock === 'Part') this.camera.setTarget(pose.position.add(pose.forward));
    this.camera.fov = cp.props.FieldOfView * DEG;
  }

  _flyCamera() {
    const k = this.keys;
    if (k.size === 0 || this.cameraPoint) return;
    const dt = this.engine.getDeltaTime() / 1000;
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 42 : 14) * dt;
    const f = this.camera.getDirection(B.Axis.Z);
    const r = this.camera.getDirection(B.Axis.X);
    const move = B.Vector3.Zero();
    if (k.has('KeyW')) move.addInPlace(f);
    if (k.has('KeyS')) move.subtractInPlace(f);
    if (k.has('KeyD')) move.addInPlace(r);
    if (k.has('KeyA')) move.subtractInPlace(r);
    if (k.has('KeyE')) move.y += 1;
    if (k.has('KeyQ')) move.y -= 1;
    if (move.lengthSquared() > 0) this.camera.position.addInPlace(move.normalize().scale(speed));
  }

  cameraInfo() {
    const p = this.camera.position;
    const f = this.camera.getDirection(B.Axis.Z);
    return { position: [p.x, p.y, p.z], look: [f.x, f.y, f.z], fov: this.camera.fov / DEG };
  }

  /** The Parts the selection covers (a Model or Folder stands for the Parts inside it). */
  get selectedParts() { return this._effective(); }

  /** Frames the selection (or the given instance). */
  focus(inst) {
    const parts = inst ? this._partsOf([inst]) : this._effective();
    const meshes = parts.map((p) => this.meshes.get(p.id)).filter(Boolean);
    if (!meshes.length) return;
    const min = new B.Vector3(Infinity, Infinity, Infinity), max = new B.Vector3(-Infinity, -Infinity, -Infinity);
    for (const m of meshes) {
      m.computeWorldMatrix(true);
      const b = m.getBoundingInfo().boundingBox;
      min.minimizeInPlace(b.minimumWorld);
      max.maximizeInPlace(b.maximumWorld);
    }
    const centre = min.add(max).scale(0.5), radius = max.subtract(min).length() / 2;
    const f = this.camera.getDirection(B.Axis.Z);
    this.camera.position = centre.subtract(f.scale(Math.max(6, radius * 2.4)));
  }

  /** A point in front of the camera, on the ground when the camera looks down at it. */
  insertPoint() {
    const { position: p, look: f } = this.cameraInfo();
    const t = f[1] < -0.05 ? Math.min(40, -p[1] / f[1]) : 14;
    const x = Math.round((p[0] + f[0] * t) * 2) / 2;
    const z = Math.round((p[2] + f[2] * t) * 2) / 2;
    return [x, Math.max(1, Math.round((p[1] + f[1] * t) * 2) / 2 + 2), z];
  }

  /**
   * Casts a ray against collidable Parts. direction's length is the reach. Returns { id, point, normal, distance }
   * or null. ignoreId is a Part the ray passes through (the caster itself, usually).
   */
  raycast(origin, direction, ignoreId = null) {
    const len = Math.hypot(...direction);
    if (!len) return null;
    const ray = new B.Ray(new B.Vector3(...origin), new B.Vector3(direction[0] / len, direction[1] / len, direction[2] / len), len);
    const hit = this.scene.pickWithRay(ray, (m) => {
      const id = m.metadata?.wickId;
      if (!id || id === ignoreId || !m.isEnabled()) return false;
      const inst = this.dm.find(id);
      return inst?.className === 'Part' && inst.props.CanCollide;
    });
    if (!hit?.hit) return null;
    const n = hit.getNormal(true, true) ?? B.Vector3.Up();
    return { id: hit.pickedMesh.metadata.wickId, point: [hit.pickedPoint.x, hit.pickedPoint.y, hit.pickedPoint.z], normal: [n.x, n.y, n.z], distance: hit.distance };
  }

  // ---------------------------------------------------------------- pointer input

  _pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const hit = this.scene.pick(e.clientX - r.left, e.clientY - r.top, (m) => !!m.metadata?.wickId && m.isEnabled());
    return hit?.hit ? this.dm.find(hit.pickedMesh.metadata.wickId) ?? null : null;
  }

  _bindPointer() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.focus();
      if (e.button === 1 || e.button === 2) {
        this._drag = { mode: e.button === 2 ? 'look' : 'pan', x: e.clientX, y: e.clientY, moved: 0, t: performance.now() };
        c.setPointerCapture(e.pointerId);
        e.preventDefault();
      } else if (e.button === 0 && !this.playing && !this.gizmos.isHovered) {
        this.onPick?.(this._pick(e), e.shiftKey);
      }
      this.onMouseButton?.(MOUSE_NAMES[e.button], true);
    });
    c.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      if (this.playing && d.mode === 'look') this.onMouseMove?.(dx, dy);
      if (this.cameraPoint && (d.mode === 'pan' || this.lookLocked)) return; // the CameraPoint owns the view
      if (d.mode === 'look') {
        this.camera.rotation.y += dx * 0.004;
        this.camera.rotation.x = Math.max(-1.55, Math.min(1.55, this.camera.rotation.x + dy * 0.004));
      } else {
        const r = this.camera.getDirection(B.Axis.X);
        const u = this.camera.getDirection(B.Axis.Y);
        this.camera.position.addInPlace(r.scale(-dx * 0.04)).addInPlace(u.scale(dy * 0.04));
      }
    });
    const end = (e) => {
      const d = this._drag;
      if (e.button === 1 || e.button === 2) {
        this._drag = null;
        // A short right click without dragging opens the context menu instead of moving the camera.
        if (d && d.mode === 'look' && d.moved < 5 && performance.now() - d.t < 450 && !this.playing) {
          const inst = this._pick(e);
          if (inst) this.onPick?.(inst, false);
          this.onContextRequest?.(inst, e.clientX, e.clientY);
        }
      }
      this.onMouseButton?.(MOUSE_NAMES[e.button], false);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', () => { this._drag = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      if (this.playing) this.onWheel?.(Math.sign(-dy));
      if (this.cameraPoint) return;
      const f = this.camera.getDirection(B.Axis.Z);
      this.camera.position.addInPlace(f.scale(-dy * 0.012 * (1 + Math.abs(this.camera.position.y) * 0.08)));
    }, { passive: false });
  }

  // ---------------------------------------------------------------- selection and gizmos

  _initSelection() {
    this.highlight = new B.HighlightLayer('wick-select', this.scene, { blurHorizontalSize: 0.7, blurVerticalSize: 0.7 });
    this.highlight.innerGlow = false; // outline only: a huge Part such as the baseplate must not tint the whole view
    this.pivot = new B.TransformNode('wick-pivot', this.scene);
    this.pivot.rotationQuaternion = B.Quaternion.Identity();
    const gm = new B.GizmoManager(this.scene);
    gm.usePointerToAttachGizmos = false;
    gm.positionGizmoEnabled = gm.rotationGizmoEnabled = gm.scaleGizmoEnabled = true; // create them once to hook their events
    const g = gm.gizmos;
    g.positionGizmo.updateGizmoRotationToMatchAttachedMesh = false;
    g.rotationGizmo.updateGizmoRotationToMatchAttachedMesh = false;
    for (const gizmo of [g.positionGizmo, g.rotationGizmo, g.scaleGizmo]) {
      gizmo.onDragStartObservable.add(() => this._dragStart());
      gizmo.onDragEndObservable.add(() => this._dragEnd());
    }
    this.gizmos = gm;
    this._applySnap();
    this._applyTool();
  }

  /** Snap increments: move in studs, rotate in degrees, scale in studs. 0 disables a snap. */
  setSnap(snap) {
    this.snap = { ...this.snap, ...snap };
    this._applySnap();
  }

  _applySnap() {
    const g = this.gizmos.gizmos, s = this.snap;
    g.positionGizmo.snapDistance = s.move;
    g.rotationGizmo.snapDistance = s.rotate * DEG;
    g.scaleGizmo.snapDistance = s.scale;
  }

  setTool(tool) {
    this.tool = tool;
    this._applyTool();
  }

  /** Parts covered by instances: a Part is itself, any other container stands for every Part inside it. */
  _partsOf(list) {
    const out = new Set();
    for (const inst of list) {
      if (inst.className === 'Part') out.add(inst);
      else if (!this.dm.isInGui(inst)) for (const d of this.dm.descendants(inst)) if (d.className === 'Part') out.add(d);
    }
    return [...out].filter((p) => this.meshes.has(p.id));
  }

  _effective() { return this._partsOf(this.selection); }

  _applyTool() {
    const gm = this.gizmos;
    const parts = this._effective();
    const show = !this.playing && parts.length > 0 && this.tool !== 'select';
    gm.positionGizmoEnabled = show && this.tool === 'move';
    gm.rotationGizmoEnabled = show && this.tool === 'rotate';
    gm.scaleGizmoEnabled = show && this.tool === 'scale';
    if (!show) { gm.attachToMesh(null); return; }
    const single = this.selection.length === 1 && this.selection[0].className === 'Part';
    this._multi = !single;
    if (single) {
      gm.attachToMesh(this.meshes.get(this.selection[0].id));
    } else {
      this._placePivot(parts);
      gm.attachToNode(this.pivot);
    }
  }

  _placePivot(parts) {
    const c = B.Vector3.Zero();
    for (const p of parts) c.addInPlace(this.meshes.get(p.id).position);
    this.pivot.position.copyFrom(c.scale(1 / parts.length));
    this.pivot.rotationQuaternion.copyFromFloats(0, 0, 0, 1);
    this.pivot.scaling.setAll(1);
  }

  /** Replaces the selection. Only Parts (and the Parts inside containers) are outlined and get gizmos. */
  setSelection(list) {
    this.selection = list.filter(Boolean);
    this.highlight.removeAllMeshes();
    if (!this.playing) {
      const color = B.Color3.FromHexString('#ffb02e');
      for (const p of this._effective()) this.highlight.addMesh(this.meshes.get(p.id), color);
      for (const s of this.selection) if (s.className === 'CameraPoint' && this.cameraIcon) this.highlight.addMesh(this.cameraIcon, color);
    }
    this._applyTool();
  }

  setPlaying(flag) {
    if (flag && !this.playing) this._editorCamera = { position: this.camera.position.clone(), rotation: this.camera.rotation.clone(), fov: this.camera.fov };
    this.playing = flag;
    if (!flag && this._editorCamera) {
      this.camera.position.copyFrom(this._editorCamera.position);
      this.camera.rotation.copyFrom(this._editorCamera.rotation);
      this.camera.fov = this._editorCamera.fov;
      this._editorCamera = null;
    }
    this.setSelection(this.selection);
  }

  _dragStart() {
    this._dragging = true;
    const parts = this._effective();
    if (!this._multi) {
      const m = this.gizmos.attachedMesh;
      this._beforeScale = m ? m.scaling.clone() : null;
      return;
    }
    this._start = {
      pivot: this.pivot.position.clone(),
      parts: parts.map((p) => {
        const m = this.meshes.get(p.id);
        return { inst: p, mesh: m, position: m.position.clone(), rotation: m.rotationQuaternion.clone(), scaling: m.scaling.clone() };
      }),
    };
  }

  /** While a multi-selection gizmo is dragged, moves every Part the same way the pivot moved. */
  _applyMulti() {
    if (!this._multi || !this._dragging || !this._start) return;
    const s = this._start, q = this.pivot.rotationQuaternion, k = this.pivot.scaling;
    const move = this.pivot.position.subtract(s.pivot);
    const m = new B.Matrix();
    q.toRotationMatrix(m);
    for (const p of s.parts) {
      const rel = p.position.subtract(s.pivot);
      rel.multiplyInPlace(k);
      const rotated = B.Vector3.TransformNormal(rel, m);
      p.mesh.position.copyFrom(s.pivot.add(move).add(rotated));
      p.mesh.rotationQuaternion.copyFrom(q.multiply(p.rotation));
      p.mesh.scaling.copyFrom(p.scaling.multiply(k));
    }
  }

  _dragEnd() {
    this._dragging = false;
    this._commitTransform();
    if (this._multi) { this._start = null; this._placePivot(this._effective()); }
  }

  /** Writes the gizmo-edited mesh transforms back into the data model. */
  _commitTransform() {
    const dm = this.dm;
    const parts = this._multi ? this._effective() : this.selection.slice(0, 1);
    for (const inst of parts) {
      const mesh = this.meshes.get(inst.id);
      if (!mesh) continue;
      const e = mesh.rotationQuaternion.toEulerAngles();
      dm.set(inst, 'Position', [mesh.position.x, mesh.position.y, mesh.position.z]);
      dm.set(inst, 'Rotation', [e.x / DEG, e.y / DEG, e.z / DEG]);
      let size = [mesh.scaling.x, mesh.scaling.y, mesh.scaling.z];
      if (inst.props.Shape === 'Ball') {
        // A ball keeps one diameter: use whichever axis the user actually dragged.
        const prev = this._multi ? this._start?.parts.find((p) => p.inst === inst)?.scaling : this._beforeScale;
        if (prev) {
          const diffs = [Math.abs(size[0] - prev.x), Math.abs(size[1] - prev.y), Math.abs(size[2] - prev.z)];
          const v = size[diffs.indexOf(Math.max(...diffs))];
          size = [v, v, v];
        }
      }
      dm.set(inst, 'Size', size);
    }
    this.onTransformCommit?.();
  }

  // ---------------------------------------------------------------- data model mirroring

  _bindDataModel() {
    const dm = this.dm;
    dm.on('added', (inst) => { this._syncNode(inst); this.reflections.touch(); });
    dm.on('removed', (inst) => { this._dropNode(inst); this.reflections.touch(); });
    dm.on('reparented', (inst) => { for (const d of dm.descendants(inst, true)) this._syncNode(d); this.reflections.touch(); });
    dm.on('changed', (inst, prop) => { this._onChanged(inst, prop); this.reflections.touch(); });
    dm.on('reset', () => this.rebuildAll());
  }

  rebuildAll() {
    for (const id of [...this.meshes.keys()]) this._disposeMesh(id);
    for (const id of [...this.lights.keys()]) this._disposeLight(id);
    this._disposeCameraIcon();
    this.reflections.reset();
    for (const inst of this.dm.descendants(this.dm.root)) this._syncNode(inst);
    this.applyLighting();
    this._applyQuality();
    this.setSelection(this.selection.map((s) => this.dm.find(s.id)));
  }

  _syncNode(inst) {
    if (inst.className === 'Part') {
      if (this.dm.isInWorkspace(inst)) {
        if (!this.meshes.has(inst.id)) this._createMesh(inst);
      } else {
        this._disposeMesh(inst.id);
      }
      // Re-evaluate lights and the camera point attached to this part (their mesh may have just appeared or vanished).
      for (const c of inst.children) if (c.className === 'PointLight' || c.className === 'CameraPoint') this._syncNode(c);
    } else if (inst.className === 'PointLight') {
      const mesh = inst.parent?.className === 'Part' ? this.meshes.get(inst.parent.id) : null;
      if (mesh) this._createLight(inst, mesh);
      else this._disposeLight(inst.id);
    } else if (inst.className === 'CameraPoint') {
      this._syncCameraIcon();
    }
  }

  _dropNode(inst) {
    if (inst.className === 'Part') this._disposeMesh(inst.id);
    else if (inst.className === 'PointLight') this._disposeLight(inst.id);
    else if (inst.className === 'CameraPoint') this._syncCameraIcon();
  }

  /** Geometry for a Mesh part: a built-in (wick://meshes/...) or an imported asset (asset://...). Null if missing. */
  _geometry(inst) {
    const id = inst.props.MeshId;
    const builtin = builtinMeshName(id);
    if (builtin) return builtinMesh(builtin);
    const asset = assetIdOf(id) && this.dm.assets.get(assetIdOf(id));
    if (asset?.kind === 'mesh') return asset.data;
    if (!this._warned.has(id)) {
      this._warned.add(id);
      this.onWarn?.(id ? `Mesh "${id}" was not found in the Library, so ${inst.name} shows as a block.` : `${inst.name} is a Mesh Part with no MeshId, so it shows as a block.`);
    }
    return null;
  }

  _createMesh(inst) {
    const name = `wick-part-${inst.id}`;
    let m;
    const geo = inst.props.Shape === 'Mesh' ? this._geometry(inst) : null;
    if (geo) {
      m = new B.Mesh(name, this.scene);
      const vd = new B.VertexData();
      vd.positions = geo.positions;
      vd.normals = geo.normals;
      vd.indices = geo.indices;
      if (geo.uvs) vd.uvs = geo.uvs;
      vd.applyToMesh(m);
    } else if (inst.props.Shape === 'Ball') m = B.MeshBuilder.CreateSphere(name, { diameter: 1, segments: 24 }, this.scene);
    else if (inst.props.Shape === 'Cylinder') m = B.MeshBuilder.CreateCylinder(name, { height: 1, diameter: 1, tessellation: 32 }, this.scene);
    else m = B.MeshBuilder.CreateBox(name, { size: 1 }, this.scene);
    m.metadata = { wickId: inst.id };
    m.rotationQuaternion = B.Quaternion.Identity();
    m.receiveShadows = true;
    this.meshes.set(inst.id, m);
    this._applyTransform(inst, m);
    this.materials.prepareMesh(inst, m);
    m.material = this.materials.forPart(inst);
    this._applyShadowFlag(inst, m);
    this.grass.attach(inst, m);
    this.hooks.created?.(inst, m);
    for (const c of inst.children) if (c.className === 'PointLight' || c.className === 'CameraPoint') this._syncNode(c);
  }

  _disposeMesh(id) {
    const m = this.meshes.get(id);
    if (!m) return;
    const inst = this.dm.find(id);
    if (inst) this.hooks.willDispose?.(inst);
    else this.hooks.willDispose?.({ id, className: 'Part', props: {} });
    this.shadowGen?.removeShadowCaster(m);
    this.materials.release(id);
    this.reflections.forget(id);
    this.grass.detach(id);
    this.highlight.removeMesh(m);
    if (this.gizmos.attachedMesh === m) this.gizmos.attachToMesh(null);
    for (const [lid, light] of this.lights) if (light.parent === m) this._disposeLight(lid);
    m.dispose();
    this.meshes.delete(id);
    if (this.cameraIcon && !this.dm.cameraPoint) this._disposeCameraIcon();
  }

  _applyTransform(inst, m) {
    const p = inst.props;
    m.position.set(p.Position[0], p.Position[1], p.Position[2]);
    m.rotationQuaternion.copyFrom(B.Quaternion.FromEulerAngles(p.Rotation[0] * DEG, p.Rotation[1] * DEG, p.Rotation[2] * DEG));
    if (p.Shape === 'Ball') m.scaling.set(p.Size[0], p.Size[0], p.Size[0]);
    else m.scaling.set(p.Size[0], p.Size[1], p.Size[2]);
  }

  _applyShadowFlag(inst, m) {
    if (!this.shadowGen) return;
    if (inst.props.CastShadow) this.shadowGen.addShadowCaster(m);
    else this.shadowGen.removeShadowCaster(m);
  }

  _createLight(inst, mesh) {
    this._disposeLight(inst.id);
    const light = new B.PointLight(`wick-light-${inst.id}`, B.Vector3.Zero(), this.scene);
    light.parent = mesh;
    this.lights.set(inst.id, light);
    this._applyLight(inst, light);
  }

  _applyLight(inst, light) {
    const p = inst.props;
    light.diffuse = B.Color3.FromArray(p.Color);
    light.specular = light.diffuse;
    light.intensity = p.Brightness;
    light.range = p.Range;
  }

  _disposeLight(id) {
    this.lights.get(id)?.dispose();
    this.lights.delete(id);
  }

  // ---- the CameraPoint's editor icon: a small camera body with a frustum, shown while editing ----

  _syncCameraIcon() {
    const cp = this.dm.cameraPoint;
    const mesh = cp && cp.parent && this.meshes.get(cp.parent.id);
    if (!cp || !mesh) { this._disposeCameraIcon(); return; }
    if (!this.cameraIcon) {
      const body = B.MeshBuilder.CreateBox('wick-camera-icon', { width: 1.2, height: 0.8, depth: 1 }, this.scene);
      const mat = new B.StandardMaterial('wick-camera-icon-mat', this.scene);
      mat.disableLighting = true;
      mat.emissiveColor = B.Color3.FromHexString('#f5a524');
      mat.fogEnabled = false;
      body.material = mat;
      body.rotationQuaternion = B.Quaternion.Identity();
      this.cameraIcon = body;
    }
    this.cameraIcon.metadata = { wickId: cp.id, fov: -1 };
    this._rebuildFrustum(cp);
  }

  _rebuildFrustum(cp) {
    const icon = this.cameraIcon;
    if (icon.metadata.fov === cp.props.FieldOfView) return;
    icon.metadata.fov = cp.props.FieldOfView;
    icon.getChildren().forEach((c) => c.dispose());
    const h = Math.tan((cp.props.FieldOfView * DEG) / 2) * 4, w = h * 1.78, o = B.Vector3.Zero();
    const c = [new B.Vector3(-w, -h, 4), new B.Vector3(w, -h, 4), new B.Vector3(w, h, 4), new B.Vector3(-w, h, 4)];
    const lines = B.MeshBuilder.CreateLineSystem('wick-camera-frustum', { lines: [[o, c[0]], [o, c[1]], [o, c[2]], [o, c[3]], [...c, c[0]]] }, this.scene);
    lines.color = B.Color3.FromHexString('#f5a524');
    lines.isPickable = false;
    lines.parent = icon;
  }

  _disposeCameraIcon() {
    if (!this.cameraIcon) return;
    this.highlight.removeMesh(this.cameraIcon);
    this.cameraIcon.getChildren().forEach((c) => c.dispose());
    this.cameraIcon.material?.dispose();
    this.cameraIcon.dispose();
    this.cameraIcon = null;
  }

  _updateCameraIcon() {
    const icon = this.cameraIcon;
    if (!icon) return;
    icon.setEnabled(!this.playing);
    if (this.playing) return;
    const cp = this.dm.cameraPoint;
    const pose = cp && this._cameraPose(cp);
    if (!pose) return;
    icon.position.copyFrom(pose.position);
    if (cp.props.Lock === 'Part') icon.rotationQuaternion.copyFrom(pose.mesh.rotationQuaternion);
    else icon.rotationQuaternion.copyFromFloats(0, 0, 0, 1);
  }

  _onChanged(inst, prop) {
    if (inst === this.dm.lighting) {
      this.applyLighting();
      if (prop === 'Bloom' || prop === 'ShadowsEnabled') this._applyQuality();
      return;
    }
    if (inst.className === 'PointLight') {
      const light = this.lights.get(inst.id);
      if (light) this._applyLight(inst, light);
      return;
    }
    if (inst.className === 'CameraPoint') { this._syncCameraIcon(); return; }
    if (inst.className !== 'Part') return;
    const mesh = this.meshes.get(inst.id);
    if (!mesh) return;
    if (prop === 'Shape' || (prop === 'MeshId' && inst.props.Shape === 'Mesh')) {
      // The mesh geometry depends on Shape, so rebuild it and re-hang any lights.
      const wasSelected = this.selection.includes(inst);
      this._disposeMesh(inst.id);
      this._createMesh(inst);
      if (wasSelected) this.setSelection(this.selection);
      return;
    }
    if (prop === 'Position' || prop === 'Rotation' || prop === 'Size') {
      this._applyTransform(inst, mesh);
      if (prop === 'Size') { this.materials.prepareMesh(inst, mesh); this.grass.attach(inst, mesh); }
    } else if (['Color', 'Material', 'Transparency', 'Texture', 'TextureColor'].includes(prop)) {
      this.materials.release(inst.id);
      this.reflections.forget(inst.id);
      this.materials.prepareMesh(inst, mesh);
      mesh.material = this.materials.forPart(inst);
      this.grass.attach(inst, mesh);
    } else if (prop === 'CastShadow') this._applyShadowFlag(inst, mesh);
    this.hooks.changed?.(inst, prop, mesh);
  }

  /** Live transform of a Part while physics moves it: { position, rotation } or null. */
  liveTransform(id) {
    const m = this.meshes.get(id);
    if (!m) return null;
    const e = m.rotationQuaternion.toEulerAngles();
    return { position: [m.position.x, m.position.y, m.position.z], rotation: [e.x / DEG, e.y / DEG, e.z / DEG] };
  }

  get fps() { return this.engine.getFps(); }
  get activeMeshCount() { return this.meshes.size; }
}

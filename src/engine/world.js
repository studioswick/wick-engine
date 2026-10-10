// Wick Engine world: the Babylon scene that mirrors the data model.
// Owns rendering, the editor camera, selection/gizmos, the sky and sun, and the graphics quality tiers
// that WickGuard steps through when a device struggles.

const B = globalThis.BABYLON;

const DEG = Math.PI / 180;
const ENV_URL = 'https://assets.babylonjs.com/environments/environmentSpecular.env';

export const TIERS = [
  { name: 'High', dprCap: 2, msaa: 4, bloom: true, fxaa: false, shadows: 2048 },
  { name: 'Medium', dprCap: 1.5, msaa: 2, bloom: true, fxaa: false, shadows: 1024 },
  { name: 'Low', dprCap: 1, msaa: 0, bloom: false, fxaa: true, shadows: 1024 },
  { name: 'Minimal', dprCap: 0.7, msaa: 0, bloom: false, fxaa: false, shadows: 0 },
];

// DOM button index (0 left, 1 middle, 2 right) to the names scripts see.
const MOUSE_NAMES = ['MouseButton1', 'MouseButton3', 'MouseButton2'];

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = (n) => Math.min(1, Math.max(0, n));

// Sky: gradient by view direction plus a sun disc and glow, drawn on an inverted dome.
B.Effect.ShadersStore.wickSkyVertexShader = `
  precision highp float;
  attribute vec3 position;
  uniform mat4 worldViewProjection;
  varying vec3 vDir;
  void main() { vDir = position; gl_Position = worldViewProjection * vec4(position, 1.0); }`;
B.Effect.ShadersStore.wickSkyFragmentShader = `
  precision highp float;
  varying vec3 vDir;
  uniform vec3 zenith; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir; uniform vec3 sunColor;
  void main() {
    vec3 d = normalize(vDir);
    vec3 c = d.y > 0.0 ? mix(horizon, zenith, pow(d.y, 0.5)) : mix(horizon, ground, min(1.0, -d.y * 4.0));
    float s = max(dot(d, normalize(sunDir)), 0.0);
    c += sunColor * (pow(s, 1800.0) * 8.0 + pow(s, 20.0) * 0.28);
    gl_FragColor = vec4(c, 1.0);
  }`;

export class WickWorld {
  constructor(canvas, dm) {
    this.canvas = canvas;
    this.dm = dm;
    this.tier = 0;
    this.playing = false;
    this.tool = 'select';
    this.selected = null;
    this.meshes = new Map(); // instance id -> mesh
    this.lights = new Map(); // instance id -> PointLight
    this.materials = new Map();
    this.keys = new Set();
    this.shadowGen = null;
    this.pipeline = null;
    this._drag = null;

    // Callbacks set by the Studio and the runtime.
    this.hooks = {}; // created(inst, mesh) changed(inst, prop, mesh) willDispose(inst)
    this.onPick = null; // (inst | null)
    this.onContextRequest = null; // (inst | null, clientX, clientY)
    this.onTransformCommit = null; // (inst)
    this.onFrame = null; // (frameMs)
    this.onMouseButton = null; // ('MouseButton1' | 'MouseButton2' | 'MouseButton3', isDown)
    this.onContextLost = null;

    this.engine = new B.Engine(canvas, true, { stencil: true, powerPreference: 'high-performance' }, false);
    this.scene = new B.Scene(this.engine);
    this.scene.skipPointerMovePicking = true;
    this.scene.clearColor = new B.Color4(0.04, 0.05, 0.08, 1);
    const info = this.engine.getGlInfo?.() ?? {};
    this.gpuName = info.renderer || 'unknown GPU';
    this.softwareRenderer = /swiftshader|llvmpipe|software|basic render/i.test(this.gpuName);

    this._initLights();
    this._initSky();
    this._initCamera();
    this._initSelection();
    this._initEnvironment();
    this._bindDataModel();
    this._bindPointer();
    this._applyQuality();

    this.engine.onContextLostObservable.add(() => this.onContextLost?.());
    this.scene.onAfterRenderObservable.add(() => this.onFrame?.(this.engine.getDeltaTime()));
    this.scene.onBeforeRenderObservable.add(() => this._flyCamera());
    new ResizeObserver(() => this.engine.resize()).observe(canvas.parentElement);
    this.engine.runRenderLoop(() => this.scene.render());
  }

  // ---------------------------------------------------------------- lights, sky, environment

  _initLights() {
    this.sun = new B.DirectionalLight('wick-sun', new B.Vector3(-0.4, -1, 0.35), this.scene);
    this.sun.autoCalcShadowZBounds = true;
    this.hemi = new B.HemisphericLight('wick-ambient', new B.Vector3(0, 1, 0), this.scene);
  }

  _initSky() {
    this.skyMat = new B.ShaderMaterial('wick-sky', this.scene, { vertex: 'wickSky', fragment: 'wickSky' }, {
      attributes: ['position'],
      uniforms: ['worldViewProjection', 'zenith', 'horizon', 'ground', 'sunDir', 'sunColor'],
    });
    this.skyMat.backFaceCulling = false;
    this.skyMat.disableDepthWrite = true;
    this.sky = B.MeshBuilder.CreateSphere('wick-sky', { diameter: 1000, segments: 16 }, this.scene);
    this.sky.material = this.skyMat;
    this.sky.infiniteDistance = true;
    this.sky.isPickable = false;
    this.sky.applyFog = false;
    this.sky.alwaysSelectAsActiveMesh = true;
    this.applyLighting();
  }

  _initEnvironment() {
    try {
      this.scene.environmentTexture = B.CubeTexture.CreateFromPrefilteredData(ENV_URL, this.scene);
    } catch { /* reflections are optional */ }
  }

  /** Derives sun, ambient light and sky colours from Lighting.ClockTime. */
  applyLighting() {
    const L = this.dm.lighting.props;
    const th = ((L.ClockTime - 6) / 12) * Math.PI; // 0 at 06:00, PI at 18:00
    const h = Math.sin(th);
    const day = clamp01(h);
    const toSun = new B.Vector3(-Math.cos(th), Math.sin(th), -0.35).normalize();
    this.sunHeight = h;

    this.sun.direction = toSun.scale(-1);
    this.sun.intensity = L.Brightness * 2.2 * Math.min(1, day * 2.5);
    this.sun.diffuse = B.Color3.FromArray(mix([1, 0.55, 0.3], [1, 0.96, 0.88], clamp01(h * 3)));
    this.hemi.intensity = 0.22 + 0.5 * day;
    this.hemi.diffuse = B.Color3.FromArray(mix([0.16, 0.2, 0.42], [0.78, 0.86, 1], day));
    this.hemi.groundColor = B.Color3.FromArray(mix([0.05, 0.05, 0.08], [0.34, 0.3, 0.26], day));
    if (this.scene.environmentTexture) this.scene.environmentIntensity = 0.15 + 0.7 * day;

    const dusk = clamp01(1 - Math.abs(h) * 4);
    let zenith = mix([0.01, 0.02, 0.06], [0.16, 0.38, 0.8], clamp01(h * 2.5 + 0.1));
    let horizon = mix([0.04, 0.07, 0.16], [0.66, 0.8, 0.96], clamp01(h * 2.5 + 0.1));
    horizon = mix(horizon, [0.96, 0.58, 0.38], dusk * 0.75);
    zenith = mix(zenith, [0.2, 0.28, 0.5], dusk * 0.4);
    this.skyMat.setColor3('zenith', B.Color3.FromArray(zenith));
    this.skyMat.setColor3('horizon', B.Color3.FromArray(horizon));
    this.skyMat.setColor3('ground', B.Color3.FromArray(mix(horizon, [0.02, 0.02, 0.03], 0.7)));
    this.skyMat.setVector3('sunDir', toSun);
    this.skyMat.setColor3('sunColor', B.Color3.FromArray(mix([1, 0.5, 0.25], [1, 0.95, 0.8], clamp01(h * 3))).scale(h > -0.05 ? 1 : 0));
    if (this._shadowsWanted !== undefined && this._shadowsWanted !== this._wantShadows()) this._applyQuality();
  }

  // ---------------------------------------------------------------- quality tiers

  setTier(tier) {
    const next = Math.min(TIERS.length - 1, Math.max(0, tier));
    if (next === this.tier) return; // the constructor already applied the starting tier
    this.tier = next;
    this._applyQuality();
  }

  _wantShadows() {
    return TIERS[this.tier].shadows > 0 && this.dm.lighting.props.ShadowsEnabled && this.sunHeight > 0.05;
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
    this._buildShadows(t.shadows);
  }

  _createPipeline() {
    const p = new B.DefaultRenderingPipeline('wick-fx', true, this.scene, [this.camera]);
    p.bloomThreshold = 0.85;
    p.bloomWeight = 0.35;
    p.bloomKernel = 48;
    p.bloomScale = 0.5;
    p.imageProcessingEnabled = true;
    p.imageProcessing.toneMappingEnabled = true;
    p.imageProcessing.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_ACES;
    p.imageProcessing.contrast = 1.1;
    this.pipeline = p;
  }

  _buildShadows(size) {
    this.shadowGen?.dispose();
    this.shadowGen = null;
    this._shadowsWanted = this._wantShadows();
    if (!this._shadowsWanted) return;
    const g = new B.ShadowGenerator(size, this.sun);
    g.usePercentageCloserFiltering = true;
    g.filteringQuality = B.ShadowGenerator.QUALITY_MEDIUM;
    g.bias = 0.0006;
    g.normalBias = 0.02;
    g.darkness = 0.25;
    this.shadowGen = g;
    for (const [id, mesh] of this.meshes) if (this.dm.find(id)?.props.CastShadow) g.addShadowCaster(mesh);
  }

  // ---------------------------------------------------------------- editor camera

  _initCamera() {
    const cam = new B.UniversalCamera('wick-cam', new B.Vector3(20, 14, -26), this.scene);
    cam.minZ = 0.1;
    cam.maxZ = 1500;
    cam.fov = 1.0;
    cam.inputs.clear();
    cam.setTarget(new B.Vector3(0, 3, 0));
    this.camera = cam;
  }

  get isLooking() { return this._drag?.mode === 'look'; }

  setKey(code, down) { if (down) this.keys.add(code); else this.keys.delete(code); }

  _flyCamera() {
    if (this._drag?.mode !== 'look') return;
    const k = this.keys;
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
    return { position: [p.x, p.y, p.z], look: [f.x, f.y, f.z] };
  }

  focus(inst) {
    const mesh = inst && this.meshes.get(inst.id);
    if (!mesh) return;
    const size = Math.max(...inst.props.Size);
    const f = this.camera.getDirection(B.Axis.Z);
    this.camera.position = mesh.position.subtract(f.scale(Math.max(6, size * 2.2)));
  }

  /** A point in front of the camera, on the ground when the camera looks down at it. */
  insertPoint() {
    const { position: p, look: f } = this.cameraInfo();
    const t = f[1] < -0.05 ? Math.min(40, -p[1] / f[1]) : 14;
    const x = Math.round((p[0] + f[0] * t) * 2) / 2;
    const z = Math.round((p[2] + f[2] * t) * 2) / 2;
    return [x, Math.max(1, Math.round((p[1] + f[1] * t) * 2) / 2 + 2), z];
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
        this.onPick?.(this._pick(e));
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
          if (inst) this.onPick?.(inst);
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
      const f = this.camera.getDirection(B.Axis.Z);
      this.camera.position.addInPlace(f.scale(-dy * 0.012 * (1 + Math.abs(this.camera.position.y) * 0.08)));
    }, { passive: false });
  }

  // ---------------------------------------------------------------- selection and gizmos

  _initSelection() {
    this.highlight = new B.HighlightLayer('wick-select', this.scene, { blurHorizontalSize: 0.7, blurVerticalSize: 0.7 });
    const gm = new B.GizmoManager(this.scene);
    gm.usePointerToAttachGizmos = false;
    gm.positionGizmoEnabled = gm.rotationGizmoEnabled = gm.scaleGizmoEnabled = true; // create them once to hook their events
    const g = gm.gizmos;
    g.positionGizmo.updateGizmoRotationToMatchAttachedMesh = false;
    g.rotationGizmo.updateGizmoRotationToMatchAttachedMesh = false;
    g.positionGizmo.onDragStartObservable.add(() => { this._beforeScale = null; });
    g.scaleGizmo.onDragStartObservable.add(() => {
      const m = gm.attachedMesh;
      this._beforeScale = m ? m.scaling.clone() : null;
    });
    for (const gizmo of [g.positionGizmo, g.rotationGizmo, g.scaleGizmo]) {
      gizmo.onDragEndObservable.add(() => this._commitTransform());
    }
    this.gizmos = gm;
    this._applyTool();
  }

  setTool(tool) {
    this.tool = tool;
    this._applyTool();
  }

  _applyTool() {
    const gm = this.gizmos;
    const show = !this.playing && this.selected && this.meshes.has(this.selected.id);
    gm.positionGizmoEnabled = !!show && this.tool === 'move';
    gm.rotationGizmoEnabled = !!show && this.tool === 'rotate';
    gm.scaleGizmoEnabled = !!show && this.tool === 'scale';
    gm.attachToMesh(show && this.tool !== 'select' ? this.meshes.get(this.selected.id) : null);
  }

  setSelected(inst) {
    this.highlight.removeAllMeshes();
    this.selected = inst && inst.className === 'Part' ? inst : null;
    const mesh = this.selected && this.meshes.get(this.selected.id);
    if (mesh && !this.playing) this.highlight.addMesh(mesh, B.Color3.FromHexString('#ffb02e'));
    this._applyTool();
  }

  setPlaying(flag) {
    this.playing = flag;
    this.setSelected(this.selected);
  }

  /** Writes the gizmo-edited mesh transform back into the data model. */
  _commitTransform() {
    const inst = this.selected;
    const mesh = inst && this.meshes.get(inst.id);
    if (!mesh) return;
    const e = mesh.rotationQuaternion.toEulerAngles();
    const dm = this.dm;
    dm.set(inst, 'Position', [mesh.position.x, mesh.position.y, mesh.position.z]);
    dm.set(inst, 'Rotation', [e.x / DEG, e.y / DEG, e.z / DEG]);
    let size = [mesh.scaling.x, mesh.scaling.y, mesh.scaling.z];
    if (inst.props.Shape === 'Ball' && this._beforeScale) {
      // A ball keeps one diameter: use whichever axis the user actually dragged.
      const b = this._beforeScale;
      const diffs = [Math.abs(size[0] - b.x), Math.abs(size[1] - b.y), Math.abs(size[2] - b.z)];
      const s = size[diffs.indexOf(Math.max(...diffs))];
      size = [s, s, s];
    }
    dm.set(inst, 'Size', size);
    this.onTransformCommit?.(inst);
  }

  // ---------------------------------------------------------------- data model mirroring

  _bindDataModel() {
    const dm = this.dm;
    dm.on('added', (inst) => this._syncNode(inst));
    dm.on('removed', (inst) => this._dropNode(inst));
    dm.on('reparented', (inst) => { for (const d of dm.descendants(inst, true)) this._syncNode(d); });
    dm.on('changed', (inst, prop) => this._onChanged(inst, prop));
    dm.on('reset', () => this.rebuildAll());
  }

  rebuildAll() {
    for (const id of [...this.meshes.keys()]) this._disposeMesh(id);
    for (const id of [...this.lights.keys()]) this._disposeLight(id);
    for (const inst of this.dm.descendants(this.dm.root)) this._syncNode(inst);
    this.applyLighting();
    this._applyQuality();
    this.setSelected(this.selected && this.dm.find(this.selected.id));
  }

  _syncNode(inst) {
    if (inst.className === 'Part') {
      if (this.dm.isInWorkspace(inst)) {
        if (!this.meshes.has(inst.id)) this._createMesh(inst);
      } else {
        this._disposeMesh(inst.id);
      }
      // Re-evaluate lights attached to this part (their mesh may have just appeared or vanished).
      for (const c of inst.children) if (c.className === 'PointLight') this._syncNode(c);
    } else if (inst.className === 'PointLight') {
      const mesh = inst.parent?.className === 'Part' ? this.meshes.get(inst.parent.id) : null;
      if (mesh) this._createLight(inst, mesh);
      else this._disposeLight(inst.id);
    }
  }

  _dropNode(inst) {
    if (inst.className === 'Part') this._disposeMesh(inst.id);
    else if (inst.className === 'PointLight') this._disposeLight(inst.id);
  }

  _createMesh(inst) {
    const name = `wick-part-${inst.id}`;
    let m;
    if (inst.props.Shape === 'Ball') m = B.MeshBuilder.CreateSphere(name, { diameter: 1, segments: 24 }, this.scene);
    else if (inst.props.Shape === 'Cylinder') m = B.MeshBuilder.CreateCylinder(name, { height: 1, diameter: 1, tessellation: 32 }, this.scene);
    else m = B.MeshBuilder.CreateBox(name, { size: 1 }, this.scene);
    m.metadata = { wickId: inst.id };
    m.rotationQuaternion = B.Quaternion.Identity();
    m.receiveShadows = true;
    this.meshes.set(inst.id, m);
    this._applyTransform(inst, m);
    m.material = this._materialFor(inst);
    this._applyShadowFlag(inst, m);
    this.hooks.created?.(inst, m);
    for (const c of inst.children) if (c.className === 'PointLight') this._syncNode(c);
  }

  _disposeMesh(id) {
    const m = this.meshes.get(id);
    if (!m) return;
    const inst = this.dm.find(id);
    if (inst) this.hooks.willDispose?.(inst);
    else this.hooks.willDispose?.({ id, className: 'Part', props: {} });
    this.shadowGen?.removeShadowCaster(m);
    this.highlight.removeMesh(m);
    if (this.gizmos.attachedMesh === m) this.gizmos.attachToMesh(null);
    for (const [lid, light] of this.lights) if (light.parent === m) this._disposeLight(lid);
    m.dispose();
    this.meshes.delete(id);
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

  _materialFor(inst) {
    const p = inst.props;
    const key = `${p.Material}|${p.Color.map((n) => n.toFixed(3)).join(',')}|${p.Transparency.toFixed(2)}`;
    let mat = this.materials.get(key);
    if (mat) return mat;
    mat = new B.PBRMaterial(`wick-mat-${this.materials.size}`, this.scene);
    const c = B.Color3.FromArray(p.Color);
    mat.albedoColor = c;
    mat.maxSimultaneousLights = 6;
    mat.environmentIntensity = 0.9;
    let alpha = 1 - p.Transparency;
    switch (p.Material) {
      case 'Metal': mat.metallic = 1; mat.roughness = 0.28; break;
      case 'Glass': mat.metallic = 0; mat.roughness = 0.05; alpha *= 0.4; break;
      case 'Neon': mat.albedoColor = c.scale(0.2); mat.emissiveColor = c; mat.emissiveIntensity = 2.6; mat.metallic = 0; mat.roughness = 0.5; break;
      case 'Wood': mat.metallic = 0; mat.roughness = 0.85; break;
      default: mat.metallic = 0; mat.roughness = 0.45;
    }
    mat.alpha = alpha;
    if (alpha < 1) mat.transparencyMode = B.PBRMaterial.PBRMATERIAL_ALPHABLEND;
    this.materials.set(key, mat);
    return mat;
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
    if (inst.className !== 'Part') return;
    let mesh = this.meshes.get(inst.id);
    if (!mesh) return;
    if (prop === 'Shape') {
      // The mesh geometry depends on Shape, so rebuild it and re-hang any lights.
      const wasSelected = this.selected === inst;
      this._disposeMesh(inst.id);
      this._createMesh(inst);
      if (wasSelected) this.setSelected(inst);
      return;
    }
    if (prop === 'Position' || prop === 'Rotation' || prop === 'Size') this._applyTransform(inst, mesh);
    else if (prop === 'Color' || prop === 'Material' || prop === 'Transparency') mesh.material = this._materialFor(inst);
    else if (prop === 'CastShadow') this._applyShadowFlag(inst, mesh);
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

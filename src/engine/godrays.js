// Wick Engine god rays: light shafts that fan out from the sun across the sky and past whatever blocks it (High and
// Medium graphics). A reduced-size depth pass tells sky pixels from solid ones, and a post-process marches from every
// pixel toward the sun collecting the bright sky it passes over. Clouds darken those pixels and objects hide them, so
// they cast the shafts. The rays fade out with the sun at night, when it is behind the camera or far off screen, and
// are strongest when the sun is low.

const B = globalThis.BABYLON;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

B.Effect.ShadersStore.wickGodRaysFragmentShader = `
  precision highp float;
  varying vec2 vUV;
  uniform sampler2D textureSampler;
  uniform sampler2D depthSampler;
  uniform vec2 sunUv; uniform vec3 sunColor;
  uniform float strength; uniform float samples; uniform float density; uniform float decay; uniform float threshold;

  // Bright sky only: the depth map is white where nothing solid was drawn.
  vec3 shaft(vec2 uv) {
    float sky = step(0.995, texture2D(depthSampler, uv).r);
    vec3 c = texture2D(textureSampler, uv).rgb;
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    return c * sky * smoothstep(threshold, threshold + 0.25, lum);
  }

  void main() {
    vec3 base = texture2D(textureSampler, vUV).rgb;
    if (strength <= 0.001) { gl_FragColor = vec4(base, 1.0); return; }
    vec2 delta = (sunUv - vUV) * density / samples;
    float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    vec2 uv = vUV + delta * jitter;
    float light = 1.0;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 64; i++) {
      if (float(i) >= samples) break;
      uv += delta;
      acc += shaft(uv) * light;
      light *= decay;
    }
    vec3 tint = mix(vec3(1.0), sunColor, 0.6);
    gl_FragColor = vec4(base + acc / samples * strength * 0.9 * tint, 1.0);
  }`;

export class WickGodRays {
  constructor(world) {
    this.world = world;
    this.config = null; // { samples, depthScale } of the current tier, or null for off
    this.post = null;
    this.depth = null;
    this.strength = 0;
    this.sunUv = new B.Vector2(0.5, 0.5);
    this._resizeObs = null;
  }

  /** Applies a graphics tier's { samples, depthScale }. Anything else (or a device that cannot render to float textures) turns the rays off. */
  setTier(config) {
    const caps = this.world.engine.getCaps();
    this.config = config && (caps.textureHalfFloatRender || caps.textureFloatRender) ? config : null;
    if (!this.config) { this._dispose(); return; }
    if (!this.post) this._build();
    else this._sizeDepth();
  }

  _build() {
    const { scene, engine, camera } = this.world;
    try {
      this.depth = scene.enableDepthRenderer(camera, false);
    } catch {
      this.config = null;
      return;
    }
    const map = this.depth.getDepthMap();
    map.renderListPredicate = (mesh) => !!mesh.metadata?.wickId; // Parts only: the sky dome and the grass are not solid
    this._sizeDepth();
    this._resizeObs = engine.onResizeObservable.add(() => this._sizeDepth());
    this.post = new B.PostProcess('wick-godrays', 'wickGodRays',
      ['sunUv', 'sunColor', 'strength', 'samples', 'density', 'decay', 'threshold'], ['depthSampler'],
      1.0, camera, B.Texture.BILINEAR_SAMPLINGMODE, engine);
    this.post.onApply = (effect) => {
      effect.setTexture('depthSampler', map);
      effect.setVector2('sunUv', this.sunUv);
      effect.setColor3('sunColor', this.world.sky.sun.diffuse);
      effect.setFloat('strength', this.strength);
      effect.setFloat('samples', this.config?.samples ?? 24);
      effect.setFloat('density', 0.92);
      effect.setFloat('decay', 0.965);
      effect.setFloat('threshold', 0.6);
    };
  }

  _sizeDepth() {
    if (!this.depth || !this.config) return;
    const { engine } = this.world;
    const k = this.config.depthScale;
    this.depth.getDepthMap().resize({ width: Math.max(2, Math.round(engine.getRenderWidth() * k)), height: Math.max(2, Math.round(engine.getRenderHeight() * k)) });
  }

  /** Once per frame: where the sun is on screen and how strong the rays should be. */
  update() {
    if (!this.post || !this.config) return;
    const { sky, camera, engine, scene } = this.world;
    const w = engine.getRenderWidth(), h = engine.getRenderHeight();
    const facing = B.Vector3.Dot(camera.getDirection(B.Axis.Z), sky.sunDir);
    const p = B.Vector3.Project(camera.position.add(sky.sunDir.scale(1000)), B.Matrix.IdentityReadOnly, scene.getTransformMatrix(), camera.viewport.toGlobal(w, h));
    this.sunUv.set(p.x / w, 1 - p.y / h);
    const e = sky.sunHeight;
    const offscreen = Math.max(Math.abs(this.sunUv.x - 0.5), Math.abs(this.sunUv.y - 0.5)) - 0.5;
    this.strength = smooth(0, 0.12, e) // gone once the sun is below the horizon
      * (0.45 + 0.55 * (1 - clamp01(e / 0.7))) // strongest when the sun is low
      * smooth(-0.1, 0.25, facing) // not when the sun is behind the camera
      * (1 - smooth(0, 0.5, offscreen)); // fades as the sun leaves the screen
    this.depth.getDepthMap().refreshRate = this.strength > 0.01 ? 1 : 0; // no depth pass while there is nothing to draw
  }

  _dispose() {
    const { scene, engine, camera } = this.world;
    if (this._resizeObs) { engine.onResizeObservable.remove(this._resizeObs); this._resizeObs = null; }
    if (this.post) { this.post.dispose(camera); this.post = null; }
    if (this.depth) { scene.disableDepthRenderer(camera); this.depth = null; }
    this.strength = 0;
  }
}

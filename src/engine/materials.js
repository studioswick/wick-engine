// Wick Engine materials: turns a Part's Material, Color and Transparency into a Babylon PBR material.
// Metal and Glass get their own material per Part when reflections are on, because each one reads the
// reflection probe that is currently assigned to it (see reflections.js). Everything else is shared.

import { surfaceTexture, TEXTURE_TILE } from './library.js';

const B = globalThis.BABYLON;

const TEXTURED = new Set(['Wood', 'Grass']);
const TEXTURE_SIZE = 512;

export class WickMaterials {
  constructor(scene) {
    this.scene = scene;
    this.reflections = null; // set by the world: supplies the reflection texture for a Part
    this.look = { reflect: false, bump: false, aniso: 1 };
    this.shared = new Map();
    this.perPart = new Map(); // instance id -> material
    this.textures = new Map(); // 'Wood' | 'Grass' -> { color, normal }
  }

  /** Applies a quality tier's look. Returns true when materials must be re-assigned to their meshes. */
  setLook(look) {
    const same = ['reflect', 'bump', 'aniso'].every((k) => this.look[k] === look[k]);
    if (same) return false;
    this.look = { ...look };
    for (const m of this.shared.values()) m.dispose();
    for (const m of this.perPart.values()) m.dispose();
    this.shared.clear();
    this.perPart.clear();
    for (const t of this.textures.values()) for (const tex of [t.color, t.normal]) tex.anisotropicFilteringLevel = look.aniso;
    return true;
  }

  release(id) {
    this.perPart.get(id)?.dispose();
    this.perPart.delete(id);
  }

  /** Points a reflective Part's material at the reflection texture it is currently assigned. */
  refreshReflection(id) {
    const mat = this.perPart.get(id);
    if (mat) mat.reflectionTexture = this.reflections.textureFor(id);
  }

  forPart(inst) {
    const p = inst.props;
    const own = this.look.reflect && (p.Material === 'Metal' || p.Material === 'Glass');
    if (own) {
      let mat = this.perPart.get(inst.id);
      if (!mat) {
        mat = this._build(p, `wick-mat-${inst.id}`);
        mat.reflectionTexture = this.reflections.textureFor(inst.id);
        this.perPart.set(inst.id, mat);
      }
      return mat;
    }
    const key = `${p.Material}|${p.Color.map((n) => n.toFixed(3)).join(',')}|${p.Transparency.toFixed(2)}`;
    let mat = this.shared.get(key);
    if (!mat) {
      mat = this._build(p, `wick-mat-${this.shared.size}`);
      if (this.look.reflect) mat.reflectionTexture = this.reflections.sky?.cubeTexture ?? null;
      this.shared.set(key, mat);
    }
    return mat;
  }

  _surface(name) {
    let t = this.textures.get(name);
    if (!t) {
      const { color, normal } = surfaceTexture(name, TEXTURE_SIZE);
      const make = (data) => {
        const tex = B.RawTexture.CreateRGBATexture(new Uint8Array(data.buffer), TEXTURE_SIZE, TEXTURE_SIZE, this.scene, true, false, B.Texture.TRILINEAR_SAMPLINGMODE);
        tex.wrapU = tex.wrapV = B.Texture.WRAP_ADDRESSMODE;
        tex.anisotropicFilteringLevel = this.look.aniso;
        return tex;
      };
      t = { color: make(color), normal: make(normal) };
      this.textures.set(name, t);
    }
    return t;
  }

  _build(p, name) {
    const reflect = this.look.reflect;
    const mat = new B.PBRMaterial(name, this.scene);
    mat.useGLTFLightFalloff = true; // inverse-square falloff that still honours PointLight.Range
    mat.maxSimultaneousLights = 6;
    const c = B.Color3.FromArray(p.Color);
    mat.albedoColor = c;
    mat.metallic = 0;
    mat.roughness = 0.45;
    let alpha = 1 - p.Transparency;
    switch (p.Material) {
      case 'Metal':
        // Without reflections a true metal would render black, so low tiers use a glossy dielectric instead.
        mat.metallic = reflect ? 1 : 0;
        mat.roughness = reflect ? 0.16 : 0.2;
        break;
      case 'Glass':
        mat.roughness = 0.02;
        mat.indexOfRefraction = 1.52;
        mat.backFaceCulling = false;
        mat.separateCullingPass = true; // back faces first, so a thick block reads as a solid of glass
        mat.useRadianceOverAlpha = true; // reflections stay vivid while the body is nearly clear
        mat.useSpecularOverAlpha = true;
        alpha *= reflect ? 0.16 : 0.3;
        break;
      case 'Neon':
        mat.albedoColor = c.scale(0.2);
        mat.emissiveColor = c;
        mat.emissiveIntensity = 2.6;
        mat.roughness = 0.5;
        break;
      case 'Wood':
      case 'Grass': {
        const tex = this._surface(p.Material);
        mat.albedoTexture = tex.color; // Color tints the natural texture; white shows it as is
        if (this.look.bump) mat.bumpTexture = tex.normal;
        mat.roughness = p.Material === 'Wood' ? 0.6 : 0.92;
        break;
      }
      default:
    }
    mat.environmentIntensity = p.Material === 'Metal' || p.Material === 'Glass' ? 1 : 0.7;
    mat.alpha = alpha;
    if (alpha < 1) mat.transparencyMode = B.PBRMaterial.PBRMATERIAL_ALPHABLEND;
    return mat;
  }

  /**
   * Textured parts get UVs projected from the part's real size, so one texture repeat always covers the same
   * world distance on every face, however the part is scaled. Other materials ignore UVs.
   */
  prepareMesh(inst, mesh) {
    const tile = TEXTURE_TILE[inst.props.Material];
    if (!tile) return;
    const geo = (mesh.metadata.geo ||= {
      pos: mesh.getVerticesData(B.VertexBuffer.PositionKind),
      nrm: mesh.getVerticesData(B.VertexBuffer.NormalKind),
    });
    const s = inst.props.Shape === 'Ball' ? [inst.props.Size[0], inst.props.Size[0], inst.props.Size[0]] : inst.props.Size;
    const count = geo.pos.length / 3;
    const uv = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = geo.pos[i * 3] * s[0], y = geo.pos[i * 3 + 1] * s[1], z = geo.pos[i * 3 + 2] * s[2];
      const ax = Math.abs(geo.nrm[i * 3]), ay = Math.abs(geo.nrm[i * 3 + 1]), az = Math.abs(geo.nrm[i * 3 + 2]);
      let u, v;
      if (ay >= ax && ay >= az) { u = x; v = z; } else if (ax >= az) { u = z; v = y; } else { u = x; v = y; }
      uv[i * 2] = u / tile;
      uv[i * 2 + 1] = v / tile;
    }
    mesh.setVerticesData(B.VertexBuffer.UVKind, uv, false);
  }
}

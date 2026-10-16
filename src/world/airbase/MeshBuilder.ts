import * as T from "three";

export type RGB = [number, number, number];
export type Vec3 = [number, number, number];

/** Linear-space colour from a sRGB hex string or number (vertex colours skip the sRGB decode). */
export function rgb(hex: string | number): RGB {
  const c = new T.Color(hex);
  return [c.r, c.g, c.b];
}
export const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
export const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Small deterministic PRNG so every base builds identically. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const m4 = new T.Matrix4();
const n3 = new T.Matrix3();
const v3 = new T.Vector3();

/**
 * Accumulates static geometry with vertex colours so a whole base collapses
 * into a handful of draw calls. Everything is written in the base's local
 * frame (x = lat, z = −s, y = absolute height).
 */
export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];

  get vertexCount() {
    return this.pos.length / 3;
  }

  vert(p: Vec3, n: Vec3, c: RGB, u = 0, v = 0) {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  /** Flat quad, corners counter-clockwise seen from the front. */
  quad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, c0: RGB, c1 = c0, c2 = c0, c3 = c0, uvs?: number[]) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const n: Vec3 = [nx, ny, nz];
    const u = uvs ?? [0, 0, 1, 0, 1, 1, 0, 1];
    const a = this.vert(p0, n, c0, u[0], u[1]);
    const b = this.vert(p1, n, c1, u[2], u[3]);
    const c = this.vert(p2, n, c2, u[4], u[5]);
    const d = this.vert(p3, n, c3, u[6], u[7]);
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** Quad whose winding is flipped as needed so its normal points toward (nx, ny, nz). */
  quadFacing(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, n: Vec3, c: RGB, uvs?: number[]) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const dot = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
    if (dot >= 0) this.quad(p0, p1, p2, p3, c, c, c, c, uvs);
    else this.quad(p0, p3, p2, p1, c, c, c, c, uvs ? [uvs[0], uvs[1], uvs[6], uvs[7], uvs[4], uvs[5], uvs[2], uvs[3]] : undefined);
  }

  /**
   * Appends any three.js geometry through a matrix. `color` may depend on the
   * transformed position and normal (vertical grime gradients, roof tint).
   */
  add(
    geo: T.BufferGeometry,
    matrix: T.Matrix4 | null,
    color: RGB | ((p: Vec3, n: Vec3, i: number) => RGB),
  ) {
    const g = geo;
    const p = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
    const base = this.vertexCount;
    if (matrix) n3.getNormalMatrix(matrix);
    for (let i = 0; i < p.count; i++) {
      v3.fromBufferAttribute(p, i);
      if (matrix) v3.applyMatrix4(matrix);
      const pp: Vec3 = [v3.x, v3.y, v3.z];
      v3.fromBufferAttribute(nrm, i);
      if (matrix) v3.applyMatrix3(n3).normalize();
      const nn: Vec3 = [v3.x, v3.y, v3.z];
      const c = typeof color === "function" ? color(pp, nn, i) : color;
      this.vert(pp, nn, c, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    geo.dispose();
  }

  /** Axis-aligned (optionally yawed) box standing on y0; grimier toward the ground. */
  box(
    cx: number, y0: number, cz: number,
    sx: number, sy: number, sz: number,
    wall: RGB, roof: RGB = wall, rotY = 0, dark = 0.62,
  ) {
    m4.makeRotationY(rotY).setPosition(cx, y0 + sy / 2, cz);
    this.add(new T.BoxGeometry(sx, sy, sz), m4.clone(), (p, n) => {
      if (n[1] > 0.5) return roof;
      if (n[1] < -0.5) return scale(wall, 0.4);
      const t = Math.min(1, Math.max(0, (p[1] - y0) / Math.max(sy, 0.01)));
      return scale(wall, dark + (1 - dark) * (0.4 + 0.6 * t));
    });
  }

  /** Vertical (frustum) cylinder standing on y0. */
  cylinder(
    cx: number, y0: number, cz: number,
    r: number, h: number, segs: number,
    wall: RGB, top: RGB = wall, rTop = r, dark = 0.7, open = false,
  ) {
    m4.makeTranslation(cx, y0 + h / 2, cz);
    this.add(new T.CylinderGeometry(rTop, r, h, segs, 1, open), m4.clone(), (p, n) => {
      if (n[1] > 0.7) return top;
      if (n[1] < -0.7) return scale(wall, 0.4);
      const t = Math.min(1, Math.max(0, (p[1] - y0) / Math.max(h, 0.01)));
      return scale(wall, dark + (1 - dark) * t);
    });
  }

  /** Faceted geodesic dome: per-panel tint jitter reads as radome panels. */
  geodesic(cx: number, cy: number, cz: number, r: number, detail: number, color: RGB, jitter: number, seed = 1, squash = 1) {
    const geo = new T.IcosahedronGeometry(r, detail).toNonIndexed();
    geo.computeVertexNormals();
    const rand = rng(seed);
    const tint: number[] = [];
    for (let i = 0; i < geo.attributes.position.count / 3; i++) tint.push(1 - jitter * rand());
    m4.makeScale(1, squash, 1).setPosition(cx, cy, cz);
    this.add(geo, m4.clone(), (_p, _n, i) => scale(color, tint[(i / 3) | 0]));
  }

  /**
   * Barrel-arched hall: ridge runs along x, the arch spans z. The +x gable
   * (the doors side when `face` is +1, else -x) is returned as its corner so
   * the caller can lay door panels in front of it.
   */
  arch(
    cx: number, y0: number, cz: number,
    depth: number, span: number, wallH: number, rise: number,
    wall: RGB, roof: RGB, segs = 12, ends = true, dark = 0.7, rotY = 0,
  ) {
    const first = this.vertexCount;
    const prof: [number, number][] = [[-span / 2, 0], [-span / 2, wallH]];
    for (let j = 1; j < segs; j++) {
      const t = (j / segs) * 2 - 1;
      prof.push([(t * span) / 2, wallH + rise * Math.sqrt(Math.max(0, 1 - t * t))]);
    }
    prof.push([span / 2, wallH], [span / 2, 0]);
    const x0 = cx - depth / 2, x1 = cx + depth / 2;
    const segN = (i: number): Vec3 => {
      const dz = prof[i + 1][0] - prof[i][0], dy = prof[i + 1][1] - prof[i][1];
      const l = Math.hypot(dz, dy);
      // Outward normal for a profile walked left-to-right over the top.
      return [0, dz / l, -dy / l];
    };
    const n = prof.length - 1;
    const pn = (i: number): Vec3 => {
      const smooth = i >= 1 && i <= n - 1 && i > 1 && i < n - 1;
      if (!smooth) return i === 0 ? segN(0) : i === n ? segN(n - 1) : segN(i);
      const a = segN(i - 1), b = segN(i);
      const m: Vec3 = [0, a[1] + b[1], a[2] + b[2]];
      const l = Math.hypot(m[1], m[2]) || 1;
      return [0, m[1] / l, m[2] / l];
    };
    for (let i = 0; i < n; i++) {
      const [za, ya] = prof[i], [zb, yb] = prof[i + 1];
      const onArch = i >= 1 && i <= n - 2;
      const ca = onArch ? roof : scale(wall, dark + (1 - dark) * (ya / Math.max(wallH, 1)));
      const cb = onArch ? roof : scale(wall, dark + (1 - dark) * (yb / Math.max(wallH, 1)));
      const nA = onArch ? pn(i) : segN(i), nB = onArch ? pn(i + 1) : segN(i);
      const a0 = this.vert([x0, y0 + ya, cz + za], nA, ca);
      const a1 = this.vert([x1, y0 + ya, cz + za], nA, ca);
      const b0 = this.vert([x0, y0 + yb, cz + zb], nB, cb);
      const b1 = this.vert([x1, y0 + yb, cz + zb], nB, cb);
      // Outward-facing: (a0,b0,b1,a1) for a profile walked in +z.
      this.tri(a0, b0, b1);
      this.tri(a0, b1, a1);
    }
    if (ends)
      for (const [x, nx] of [[x0, -1], [x1, 1]] as const) {
        const ids = prof.map(([z, y]) => this.vert([x, y0 + y, cz + z], [nx, 0, 0], scale(wall, 0.85 + 0.15 * (y / (wallH + rise)))));
        for (let i = 1; i < ids.length - 1; i++) nx > 0 ? this.tri(ids[0], ids[i], ids[i + 1]) : this.tri(ids[0], ids[i + 1], ids[i]);
      }
    if (rotY) this.yaw(first, cx, cz, rotY);
  }

  /** Rotates vertices from `first` onward about the vertical axis through (cx, cz). */
  yaw(first: number, cx: number, cz: number, angle: number) {
    const c = Math.cos(angle), s = Math.sin(angle);
    for (let i = first; i < this.vertexCount; i++) {
      const x = this.pos[i * 3] - cx, z = this.pos[i * 3 + 2] - cz;
      this.pos[i * 3] = cx + x * c + z * s;
      this.pos[i * 3 + 2] = cz - x * s + z * c;
      const nx = this.nor[i * 3], nz = this.nor[i * 3 + 2];
      this.nor[i * 3] = nx * c + nz * s;
      this.nor[i * 3 + 2] = -nx * s + nz * c;
    }
  }

  /** Flat convex polygon on the ground plane (x, z pairs), facing up. UVs are metres / uvScale. */
  flat(points: [number, number][], y: number, color: RGB, uvScale = 0, uvRot = 0) {
    const ids = points.map(([x, z]) => {
      const u = uvScale ? (x * Math.cos(uvRot) + z * Math.sin(uvRot)) / uvScale : 0;
      const v = uvScale ? (-x * Math.sin(uvRot) + z * Math.cos(uvRot)) / uvScale : 0;
      return this.vert([x, y, z], [0, 1, 0], color, u, v);
    });
    for (let i = 1; i < points.length - 1; i++) {
      const [ax, az] = points[0], [bx, bz] = points[i], [cx, cz] = points[i + 1];
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      if (ny >= 0) this.tri(ids[0], ids[i], ids[i + 1]);
      else this.tri(ids[0], ids[i + 1], ids[i]);
    }
  }

  /** Axis-aligned flat rectangle on the ground. */
  rect(x0: number, z0: number, x1: number, z1: number, y: number, color: RGB, uvScale = 0) {
    this.flat([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], y, color, uvScale);
  }

  /** Flat stripe of given width between two ground points. */
  stripe(ax: number, az: number, bx: number, bz: number, width: number, y: number, color: RGB) {
    const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
    const nx = (-dz / l) * (width / 2), nz = (dx / l) * (width / 2);
    this.flat([[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]], y, color);
  }

  build() {
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new T.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new T.Float32BufferAttribute(this.col, 3));
    g.setAttribute("uv", new T.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.pos.length / 3 > 65535 ? new T.Uint32BufferAttribute(this.idx, 1) : new T.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

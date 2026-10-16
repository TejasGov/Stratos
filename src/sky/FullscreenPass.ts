import * as T from "three";

const geometry = new T.BufferGeometry();
geometry.setAttribute(
  "position",
  new T.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
);
geometry.setAttribute("uv", new T.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));

export const FULLSCREEN_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** One oversized triangle; every pass shares the geometry and orthographic camera. */
export class FullscreenPass {
  private static camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly mesh: T.Mesh;
  constructor(public material: T.ShaderMaterial) {
    this.mesh = new T.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
  }
  render(
    renderer: T.WebGLRenderer,
    target: T.WebGLRenderTarget | null,
    layer = 0,
  ) {
    renderer.setRenderTarget(target, layer);
    renderer.render(this.mesh, FullscreenPass.camera);
  }
  dispose() {
    this.material.dispose();
  }
}

/** Shader material defaults used by every sky pass: GLSL3, no depth, no tone mapping. */
export function passMaterial(
  parameters: T.ShaderMaterialParameters & {
    fragmentShader: string;
  },
) {
  return new T.ShaderMaterial({
    glslVersion: T.GLSL3,
    vertexShader: FULLSCREEN_VERTEX,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    ...parameters,
  });
}

export function hdrTarget(
  width: number,
  height: number,
  options: T.RenderTargetOptions = {},
) {
  return new T.WebGLRenderTarget(width, height, {
    type: T.HalfFloatType,
    format: T.RGBAFormat,
    minFilter: T.LinearFilter,
    magFilter: T.LinearFilter,
    wrapS: T.ClampToEdgeWrapping,
    wrapT: T.ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
    ...options,
  });
}

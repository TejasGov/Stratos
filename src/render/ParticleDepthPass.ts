import * as T from "three";

/** Optional high-quality depth prepass for ordinary perspective WebGL soft particles. */
export class ParticleDepthPass {
  private target = new T.WebGLRenderTarget(1, 1, { depthBuffer: true });
  private material = new T.MeshDepthMaterial();
  private size = new T.Vector2();
  constructor() {
    this.target.depthTexture = new T.DepthTexture(1, 1, T.UnsignedIntType);
    this.target.texture.generateMipmaps = false;
  }
  render(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera) {
    renderer.getDrawingBufferSize(this.size);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y)
      this.target.setSize(this.size.x, this.size.y);
    const hidden: T.Object3D[] = [];
    scene.traverse((object) => {
      if (!(object instanceof T.Mesh) || !object.visible) return;
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      if (
        materials.some(
          (material) => material.transparent || !material.depthWrite,
        )
      ) {
        hidden.push(object);
        object.visible = false;
      }
    });
    const previous = renderer.getRenderTarget();
    const override = scene.overrideMaterial;
    const shadowUpdate = renderer.shadowMap.autoUpdate;
    try {
      renderer.shadowMap.autoUpdate = false;
      scene.overrideMaterial = this.material;
      renderer.setRenderTarget(this.target);
      renderer.clear();
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(previous);
      scene.overrideMaterial = override;
      renderer.shadowMap.autoUpdate = shadowUpdate;
      hidden.forEach((object) => {
        object.visible = true;
      });
    }
    return {
      texture: this.target.depthTexture!,
      width: this.size.x,
      height: this.size.y,
    };
  }
  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}

import * as T from "three";
import { hash } from "../world/terrain";
import { WorldQuality } from "./OutdoorEnvironment";

/** Lit procedural cloud impostors: bounded cost, no network texture dependency. */
export class CloudLayers {
  readonly mesh: T.InstancedMesh;
  private matrix = new T.Object3D();
  private cell = "";
  private quality: WorldQuality = "medium";
  constructor() {
    const material = new T.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: T.DoubleSide,
      uniforms: { time: { value: 0 } },
      vertexShader: `varying vec2 vUv; varying float vDistance;
        void main(){vUv=uv;vec4 center=modelViewMatrix*instanceMatrix*vec4(0.,0.,0.,1.);
        vec2 size=vec2(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz));
        center.xy+=position.xy*size;vDistance=length(center.xyz);gl_Position=projectionMatrix*center;}`,
      fragmentShader: `uniform float time;varying vec2 vUv;varying float vDistance;
        float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
          return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+1.),f.x),f.y);}
        void main(){vec2 p=(vUv-.5)*2.;float d=length(p*vec2(1.,1.12));
          float n=noise(vUv*6.+vec2(time*.002,0.))*.65+noise(vUv*15.)*.35;
          float alpha=smoothstep(1.05,.45,d+(n-.5)*.32)*.7;
          alpha*=smoothstep(80.,420.,vDistance)*(1.-smoothstep(11000.,17000.,vDistance));
          if(alpha<.012)discard;
          vec3 color=mix(vec3(.40,.48,.54),vec3(.94,.92,.86),smoothstep(.05,.9,vUv.y)*.8+n*.2);
          gl_FragColor=vec4(color,alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new T.InstancedMesh(new T.PlaneGeometry(1, 1), material, 256);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.count = 128;
  }
  setQuality(quality: WorldQuality) {
    this.quality = quality;
    this.cell = "";
  }
  update(position: T.Vector3, origin: T.Vector3, time: number) {
    const cx = Math.floor(position.x / 4000),
      cz = Math.floor(position.z / 4000);
    const cell = `${cx},${cz}`;
    if (cell !== this.cell) {
      this.cell = cell;
      this.mesh.count =
        this.quality === "low" ? 64 : this.quality === "high" ? 256 : 128;
      for (let i = 0; i < this.mesh.count; i++) {
        const gx = cx + (i % 8) - 4,
          gz = cz + (Math.floor(i / 8) % 8) - 4;
        const layer = Math.floor(i / 64);
        const seed = gx * 113 + layer * 997;
        this.matrix.position.set(
          gx * 4000 + hash(seed, gz) * 3400,
          2600 + layer * 490 + hash(seed + 3, gz) * 390,
          gz * 4000 + hash(seed + 7, gz) * 3400,
        );
        this.matrix.scale.set(
          1000 + hash(seed + 1, gz) * 1800,
          420 + hash(seed + 2, gz) * 500,
          1,
        );
        this.matrix.updateMatrix();
        this.mesh.setMatrixAt(i, this.matrix.matrix);
      }
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    this.mesh.position.copy(origin).multiplyScalar(-1);
    (this.mesh.material as T.ShaderMaterial).uniforms.time.value = time;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as T.Material).dispose();
    this.mesh.dispose();
  }
}

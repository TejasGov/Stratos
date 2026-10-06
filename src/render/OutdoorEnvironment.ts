import * as T from "three";
import { Sky } from "three/addons/objects/Sky.js";

export type WorldQuality = "low" | "medium" | "high";
export const SUN_DIRECTION = new T.Vector3(-0.55, 0.68, 0.48).normalize();

/** One shared outdoor lighting reference for the sky, IBL and ocean. */
export function createOutdoorSky(): Sky {
  const sky = new Sky();
  sky.scale.setScalar(40000);
  const u = sky.material.uniforms;
  u.turbidity.value = 3.8;
  u.rayleigh.value = 1.65;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.82;
  u.sunPosition.value.copy(SUN_DIRECTION).multiplyScalar(10000);
  sky.material.depthWrite = false;
  return sky;
}

export function createOutdoorEnvironment(
  renderer: T.WebGLRenderer,
): T.WebGLRenderTarget {
  const sky = createOutdoorSky();
  const scene = new T.Scene();
  scene.add(sky);
  const generator = new T.PMREMGenerator(renderer);
  const target = generator.fromScene(scene, 0.08, 1, 100000, { size: 128 });
  generator.dispose();
  sky.geometry.dispose();
  sky.material.dispose();
  return target;
}

export function createOcean(): T.Mesh<T.PlaneGeometry, T.ShaderMaterial> {
  return new T.Mesh(
    new T.PlaneGeometry(150000, 150000),
    new T.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        offset: { value: new T.Vector2() },
        sunDirection: { value: SUN_DIRECTION },
        detail: { value: 1 },
      },
      vertexShader: `varying vec3 vWorld; varying float vDepth;
      void main(){vec4 w=modelMatrix*vec4(position,1.);vWorld=w.xyz;
      vec4 v=viewMatrix*w;vDepth=-v.z;gl_Position=projectionMatrix*v;}`,
      fragmentShader: `uniform float time,detail; uniform vec2 offset; uniform vec3 sunDirection;
      varying vec3 vWorld; varying float vDepth;
      void main(){vec2 p=vWorld.xz+offset; float t=time;
        float waveFade=1.-smoothstep(1800.,8500.,vDepth);
        vec3 n=normalize(vec3(waveFade*(.045*cos(dot(p,vec2(.018,.012))+t*.7)
          +detail*.025*cos(dot(p,vec2(.065,-.031))-t*1.2)),1.,
          waveFade*.04*cos(dot(p,vec2(-.015,.028))-t*.8)));
        vec3 v=normalize(cameraPosition-vWorld);float fresnel=.035+.965*pow(1.-max(dot(n,v),0.),5.);
        vec3 r=reflect(-v,n);vec3 sky=mix(vec3(.55,.68,.73),vec3(.13,.35,.55),sqrt(max(r.y,0.)));
        vec3 water=mix(vec3(.018,.14,.18),sky,fresnel);
        float glint=pow(max(dot(n,normalize(v+sunDirection)),0.),mix(35.,180.,waveFade))*.65;
        water+=vec3(1.,.83,.59)*glint;
        float fog=1.-exp(-max(vDepth,0.)*.000075);
        gl_FragColor=vec4(mix(water,vec3(.57,.70,.75),fog),1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    }),
  );
}

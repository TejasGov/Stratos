import * as T from "three";
import { WorldQuality } from "./OutdoorEnvironment";

const root = `${import.meta.env.BASE_URL}assets/polyhaven/`;
const sources = [
  "aerial_grass_rock",
  "aerial_rocks_02",
  "aerial_sand",
] as const;
const declarations = `
varying vec3 vTerrainPoint,vTerrainNormal;
uniform sampler2D grassColor,grassNormal,grassArm,rockColor,rockNormal,rockArm,sandColor,sandNormal,sandArm;
uniform float terrainDetail;
float terrainHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float terrainNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(terrainHash(i),terrainHash(i+vec2(1.,0.)),f.x),
    mix(terrainHash(i+vec2(0.,1.)),terrainHash(i+vec2(1.,1.)),f.x),f.y);}
vec3 terrainGround(sampler2D image,vec2 a,vec2 b,float blend){
  return mix(texture2D(image,a).rgb,texture2D(image,b).rgb,blend);
}
vec3 terrainGroundNormal(sampler2D image,vec2 a,vec2 b,float blend){
  vec3 first=texture2D(image,a).xyz*2.-1.;
  vec3 second=texture2D(image,b).xyz*2.-1.;
  // Transpose of the UV rotation puts the rotated sample back into the ground tangent frame.
  second.xy=vec2(.8*second.x-.6*second.y,.6*second.x+.8*second.y);
  return normalize(mix(first,second,blend));
}
vec3 terrainTri(sampler2D image,vec3 p,vec3 n,vec3 weights){
  vec3 signs=sign(n+vec3(.00001));
  return texture2D(image,vec2(-p.z*signs.x,p.y)).rgb*weights.x+
    texture2D(image,vec2(p.x,-p.z*signs.y)).rgb*weights.y+
    texture2D(image,vec2(p.x*signs.z,p.y)).rgb*weights.z;
}
vec3 terrainRockNormal(vec3 p,vec3 n,vec3 weights){
  vec3 signs=sign(n+vec3(.00001));
  vec3 a=texture2D(rockNormal,vec2(-p.z*signs.x,p.y)).xyz*2.-1.;
  vec3 b=texture2D(rockNormal,vec2(p.x,-p.z*signs.y)).xyz*2.-1.;
  vec3 c=texture2D(rockNormal,vec2(p.x*signs.z,p.y)).xyz*2.-1.;
  a=vec3(a.z*n.x,a.y+n.y,-a.x*signs.x+n.z);
  b=vec3(b.x+n.x,b.z*n.y,-b.y*signs.y+n.z);
  c=vec3(c.x*signs.z+n.x,c.y+n.y,c.z*n.z);
  return normalize(a*weights.x+b*weights.y+c*weights.z);
}
`;

/** Nine local CC0 1K maps; horizontal ground and triplanar cliff projection. */
export class TerrainMaterials {
  readonly material = new T.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });
  readonly ready: Promise<void>;
  private textures: T.Texture[] = [];
  private disposed = false;
  private uniforms: Record<string, { value: T.Texture | T.Vector3 | number }>;
  private anisotropy = 1;
  loadError: string | null = null;
  constructor(origin: T.Vector3) {
    const placeholder = (rgb: number[]) => {
      const texture = new T.DataTexture(new Uint8Array([...rgb, 255]), 1, 1);
      texture.needsUpdate = true;
      this.textures.push(texture);
      return texture;
    };
    const color = placeholder([96, 112, 74]),
      normal = placeholder([128, 128, 255]),
      arm = placeholder([255, 230, 0]);
    this.uniforms = {
      terrainOrigin: { value: origin },
      terrainDetail: { value: 0.6 },
    };
    for (const prefix of ["grass", "rock", "sand"]) {
      this.uniforms[`${prefix}Color`] = { value: color };
      this.uniforms[`${prefix}Normal`] = { value: normal };
      this.uniforms[`${prefix}Arm`] = { value: arm };
    }
    this.material.customProgramCacheKey = () => "stratos-polyhaven-terrain-v2";
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader =
        "uniform vec3 terrainOrigin; varying vec3 vTerrainPoint,vTerrainNormal;\n" +
        shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vTerrainPoint=(modelMatrix*vec4(position,1.)).xyz+terrainOrigin;
        vTerrainNormal=normalize(mat3(modelMatrix)*normal);`,
      );
      shader.fragmentShader = declarations + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec3 terrainN=normalize(vTerrainNormal);
        vec3 terrainWeights=pow(abs(terrainN),vec3(4.));terrainWeights/=dot(terrainWeights,vec3(1.));
        float cliff=smoothstep(.18,.58,1.-abs(terrainN.y));
        float alpine=smoothstep(900.,1550.,vTerrainPoint.y);
        float rockBlend=max(cliff,alpine*.65);
        float sandBlend=(1.-smoothstep(8.,52.,vTerrainPoint.y))*(1.-cliff);
        vec2 groundUv=vec2(vTerrainPoint.x,-vTerrainPoint.z)/15.;
        vec2 alternateUv=mat2(.8,-.6,.6,.8)*groundUv*1.137+vec2(.37,.71);
        float sampleBlend=.25+.5*terrainNoise(vTerrainPoint.xz/170.+vec2(31.,-17.));
        float macro=terrainNoise(vTerrainPoint.xz/950.)*.65+terrainNoise(vTerrainPoint.xz/280.+23.)*.35;
        float distant= smoothstep(500.,2800.,length(vViewPosition));
        vec3 ground=terrainGround(grassColor,groundUv,alternateUv,sampleBlend);
        // Broad biome tint restores green groundcover while retaining photographed local detail.
        ground*=mix(vec3(.63,.92,.52),vec3(.84,1.02,.66),macro);
        ground=mix(ground,vec3(.085,.135,.06)*(0.8+macro*.4),distant*.42);
        vec3 stone=terrainTri(rockColor,vTerrainPoint/50.,terrainN,terrainWeights);
        vec3 beach=terrainGround(sandColor,groundUv,alternateUv,sampleBlend);
        vec3 groundArm=terrainGround(grassArm,groundUv,alternateUv,sampleBlend);
        vec3 stoneArm=terrainTri(rockArm,vTerrainPoint/50.,terrainN,terrainWeights);
        vec3 beachArm=terrainGround(sandArm,groundUv,alternateUv,sampleBlend);
        vec3 terrainArm=mix(mix(groundArm,stoneArm,rockBlend),beachArm,sandBlend);
        diffuseColor.rgb=mix(mix(ground,stone,rockBlend),beach,sandBlend);
        #ifdef USE_COLOR
          diffuseColor.rgb*=mix(vec3(1.),clamp(vColor.rgb*3.,vec3(.7),vec3(1.3)),.12);
        #endif
      `,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        roughnessFactor=clamp(terrainArm.g,.35,1.);`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        if(terrainDetail>.01 && length(vViewPosition)<1800.){
          vec3 groundN=terrainGroundNormal(grassNormal,groundUv,alternateUv,sampleBlend);
          vec3 beachN=terrainGroundNormal(sandNormal,groundUv,alternateUv,sampleBlend);
          vec3 detailN=mix(groundN,beachN,sandBlend);
          vec3 horizontalN=normalize(terrainN+vec3(detailN.x,0.,-detailN.y));
          vec3 mappedN=mix(horizontalN,terrainRockNormal(vTerrainPoint/50.,terrainN,terrainWeights),rockBlend);
          float detailFade=1.-smoothstep(300.,1800.,length(vViewPosition));
          normal=normalize(mat3(viewMatrix)*normalize(mix(terrainN,mappedN,terrainDetail*detailFade)));
        }`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <aomap_fragment>",
        `#include <aomap_fragment>
        reflectedLight.indirectDiffuse*=mix(1.,terrainArm.r,.65);`,
      );
    };
    this.ready = this.load();
  }
  private async load() {
    const loader = new T.TextureLoader();
    const prefixes = ["grass", "rock", "sand"];
    const suffixes = [
      ["diff", "Color"],
      ["nor_gl", "Normal"],
      ["arm", "Arm"],
    ];
    try {
      await Promise.all(
        sources.flatMap((asset, i) =>
          suffixes.map(async ([suffix, kind]) => {
            const texture = await loader.loadAsync(
              `${root}${asset}_${suffix}_1k.jpg`,
            );
            if (this.disposed) {
              texture.dispose();
              return;
            }
            texture.colorSpace =
              kind === "Color" ? T.SRGBColorSpace : T.NoColorSpace;
            texture.wrapS = texture.wrapT = T.RepeatWrapping;
            texture.anisotropy = this.anisotropy;
            texture.needsUpdate = true;
            this.textures.push(texture);
            this.uniforms[`${prefixes[i]}${kind}`].value = texture;
          }),
        ),
      );
    } catch (error) {
      this.loadError = String(error);
    }
  }
  configure(renderer: T.WebGLRenderer) {
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.textures.forEach((texture) => {
      texture.anisotropy = this.anisotropy;
      texture.needsUpdate = true;
    });
  }
  setQuality(quality: WorldQuality) {
    this.uniforms.terrainDetail.value =
      quality === "low" ? 0 : quality === "high" ? 0.85 : 0.6;
  }
  dispose() {
    this.disposed = true;
    this.textures.forEach((texture) => texture.dispose());
    this.textures.length = 0;
    this.material.dispose();
  }
}

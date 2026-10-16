import * as T from "three";
import {
  AERIAL_RANGE_KM,
  Atmosphere,
  sunlightTransmittance,
} from "./Atmosphere";
import { Clouds, type CloudQuality } from "./Clouds";
import { Lightning } from "./Lightning";
import { FullscreenPass, hdrTarget, passMaterial } from "./FullscreenPass";
import { COMPOSITE } from "./shaders/composite";
import { ATMOSPHERE_GLSL } from "./shaders/atmosphere";
import {
  ADAPT,
  BLOOM_DOWN,
  BLOOM_UP,
  FINAL,
  RAY_BLUR,
  RAY_MASK,
} from "./shaders/post";
import { TimeOfDay } from "./TimeOfDay";

/** Objects on this layer (particles, tracers, gates) render after the sky composite. */
export const TRANSPARENT_LAYER = 1;
export const SUN_ILLUMINANCE = 3;

const SUN_VISIBILITY = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D tClouds;
uniform sampler2D tPrevious;
uniform vec2 uSun;
uniform vec2 uRadius;
uniform float uInFront;
uniform float uDelta;
layout(location = 0) out vec4 outColor;
void main() {
  float sum = 0.0;
  for (int y = -2; y <= 2; y++)
  for (int x = -2; x <= 2; x++) {
    vec2 uv = uSun + vec2(float(x), float(y)) * uRadius;
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    float sky = step(0.99999, texture(tDepth, clamp(uv, 0.0, 1.0)).x);
    sum += inside * sky * texture(tClouds, clamp(uv, 0.0, 1.0)).a;
  }
  float target = sum / 25.0 * uInFront;
  float previous = texture(tPrevious, vec2(0.5)).r;
  outColor = vec4(mix(previous, target, 1.0 - exp(-uDelta * 12.0)), 0.0, 0.0, 1.0);
}`;

const ENVIRONMENT_DOME = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D tTransmittance, tSkyView;
uniform vec3 uSunDir;
uniform float uCameraR;
uniform float uSunIlluminance;
in vec3 vDirection;
layout(location = 0) out vec4 outColor;
void main() {
  vec3 rd = normalize(vDirection);
  vec3 sky = texture(tSkyView, skyViewUv(rd, uSunDir, uCameraR)).rgb * uSunIlluminance;
  if (rd.y < -0.02) {
    // Ocean below: dim diffuse irradiance plus the atmosphere in between.
    vec3 sun = transmittanceLut(tTransmittance, Rg, max(uSunDir.y, 0.0)) * uSunIlluminance;
    vec3 ground = vec3(0.03, 0.06, 0.08) / PI * (sun * max(uSunDir.y, 0.0) + texture(tSkyView, vec2(0.5, 1.0)).rgb * uSunIlluminance * PI);
    sky += ground * 0.6;
  }
  outColor = vec4(sky, 1.0);
}`;

export type SkyQuality = CloudQuality;
export type WeatherName = "clear" | "fair" | "towering" | "storm";
/** Cloud coverage, storm-core strength and density for each sky preset. */
export const WEATHER: Record<WeatherName, { coverage: number; storm: number; density: number }> = {
  clear: { coverage: 0.2, storm: 0, density: 0.9 },
  fair: { coverage: 0.52, storm: 0.12, density: 1 },
  towering: { coverage: 0.7, storm: 0.5, density: 1.1 },
  storm: { coverage: 0.9, storm: 1, density: 1.25 },
};

export interface FrameEffects {
  speedBlur: number;
  shock: number;
  shockCenter: T.Vector2;
  flash: number;
}

/**
 * Owns the HDR frame: opaque scene → atmosphere, ocean and cloud composite →
 * transparent effects → bloom, crepuscular rays, lens flare, eye adaptation and AgX.
 */
export class SkyEngine {
  readonly atmosphere = new Atmosphere();
  readonly clouds: Clouds;
  readonly lightning: Lightning;
  readonly time = new TimeOfDay();
  readonly sunColor = new T.Color();
  readonly effects: FrameEffects = {
    speedBlur: 0,
    shock: 0,
    shockCenter: new T.Vector2(0.5, 0.5),
    flash: 0,
  };
  exposureBias = 0;
  private sceneTarget: T.WebGLRenderTarget;
  private compositeTarget: T.WebGLRenderTarget;
  private depth: T.DepthTexture;
  private composite: FullscreenPass;
  private bloomDown: FullscreenPass;
  private bloomUp: FullscreenPass;
  private bloomMips: T.WebGLRenderTarget[] = [];
  private bloomUps: T.WebGLRenderTarget[] = [];
  private rayMask = hdrTarget(1, 1);
  private rayBlur = hdrTarget(1, 1);
  private rayMaskPass: FullscreenPass;
  private rayBlurPass: FullscreenPass;
  private exposure = [hdrTarget(1, 1), hdrTarget(1, 1)];
  private exposureIndex = 0;
  private adaptPass: FullscreenPass;
  private visibility = [hdrTarget(1, 1), hdrTarget(1, 1)];
  private visibilityIndex = 0;
  private visibilityPass: FullscreenPass;
  private finalPass: FullscreenPass;
  private quality: SkyQuality = "medium";
  private width = 1;
  private height = 1;
  private firstFrame = true;
  private rotation = new T.Matrix4();
  private rayMatrix = new T.Matrix4();
  private viewRotation = new T.Matrix4();
  private sunScreen = new T.Vector3();
  private envScene = new T.Scene();
  private envTarget = new T.WebGLCubeRenderTarget(64, {
    type: T.HalfFloatType,
    generateMipmaps: false,
  });
  private envCamera = new T.CubeCamera(0.1, 10, this.envTarget);
  private envDome: T.Mesh;
  private pmrem?: T.PMREMGenerator;
  private pmremTarget?: T.WebGLRenderTarget;
  private envTimer = 0;
  private envSun = new T.Vector3();
  private envAltitude = -1e9;
  private elapsed = 0;
  private altitude = 1;
  private origin = new T.Vector3();
  private resolution = new T.Vector2();
  constructor(
    private renderer: T.WebGLRenderer,
    private sunLight: T.DirectionalLight,
  ) {
    this.depth = new T.DepthTexture(1, 1, T.UnsignedIntType);
    this.sceneTarget = new T.WebGLRenderTarget(1, 1, {
      type: T.HalfFloatType,
      depthBuffer: true,
      samples: 4,
      generateMipmaps: false,
    });
    this.sceneTarget.depthTexture = this.depth;
    this.compositeTarget = hdrTarget(1, 1, { depthBuffer: true });
    this.clouds = new Clouds(this.atmosphere, this.depth);
    this.lightning = new Lightning(this.clouds, TRANSPARENT_LAYER);
    const lut = this.atmosphere.uniforms;
    this.composite = new FullscreenPass(
      passMaterial({
        fragmentShader: COMPOSITE,
        depthTest: true,
        depthWrite: true,
        depthFunc: T.AlwaysDepth,
        uniforms: {
          ...lut,
          tScene: { value: this.sceneTarget.texture },
          tDepth: { value: this.depth },
          tClouds: { value: null },
          tCloudDepth: { value: null },
          tCloudShadow: { value: this.clouds.shadow.texture },
          uCloudResolution: { value: new T.Vector2(1, 1) },
          uShadowCenter: { value: this.clouds.shadowCenter },
          uShadowExtent: { value: this.clouds.shadowExtent },
          uRayMatrix: { value: this.rayMatrix },
          uProjectionInverse: { value: new T.Matrix4() },
          uProjection: { value: new T.Matrix4() },
          uViewRotation: { value: this.viewRotation },
          uCameraGlobal: { value: new T.Vector3() },
          uSunDir: { value: this.atmosphere.sunDirection },
          uMoonDir: { value: this.time.moon },
          uSunIlluminance: { value: SUN_ILLUMINANCE },
          uSunDisk: { value: 1.6 },
          uStars: { value: 0 },
          uTime: { value: 0 },
          uAerialRange: { value: AERIAL_RANGE_KM },
          uOceanDetail: { value: 1 },
          uPixelAngle: { value: 0.001 },
          uFlash: { value: new T.Vector4() },
        },
      }),
    );
    this.bloomDown = new FullscreenPass(
      passMaterial({
        fragmentShader: BLOOM_DOWN,
        uniforms: {
          tInput: { value: null },
          uTexel: { value: new T.Vector2() },
          uFirst: { value: 0 },
        },
      }),
    );
    this.bloomUp = new FullscreenPass(
      passMaterial({
        fragmentShader: BLOOM_UP,
        uniforms: {
          tInput: { value: null },
          tBase: { value: null },
          uTexel: { value: new T.Vector2() },
          uRadius: { value: 1 },
        },
      }),
    );
    this.rayMaskPass = new FullscreenPass(
      passMaterial({
        fragmentShader: RAY_MASK,
        uniforms: {
          tClouds: { value: null },
          tDepth: { value: this.depth },
          uRayMatrix: { value: this.rayMatrix },
          uHorizon: { value: 0 },
          uSun: { value: new T.Vector2() },
          uAspect: { value: 1 },
        },
      }),
    );
    this.rayBlurPass = new FullscreenPass(
      passMaterial({
        fragmentShader: RAY_BLUR,
        uniforms: {
          tInput: { value: this.rayMask.texture },
          uSun: { value: new T.Vector2() },
          uDensity: { value: 0.85 },
        },
      }),
    );
    this.adaptPass = new FullscreenPass(
      passMaterial({
        fragmentShader: ADAPT,
        uniforms: {
          tInput: { value: null },
          tPrevious: { value: null },
          uDelta: { value: 0 },
          uReset: { value: 1 },
        },
      }),
    );
    this.visibilityPass = new FullscreenPass(
      passMaterial({
        fragmentShader: SUN_VISIBILITY,
        uniforms: {
          tDepth: { value: this.depth },
          tClouds: { value: null },
          tPrevious: { value: null },
          uSun: { value: new T.Vector2() },
          uRadius: { value: new T.Vector2() },
          uInFront: { value: 0 },
          uDelta: { value: 0 },
        },
      }),
    );
    this.finalPass = new FullscreenPass(
      passMaterial({
        fragmentShader: FINAL,
        uniforms: {
          tScene: { value: this.compositeTarget.texture },
          tBloom: { value: null },
          tRays: { value: this.rayBlur.texture },
          tExposure: { value: null },
          tDepth: { value: this.depth },
          tCloudsLow: { value: null },
          uResolution: { value: new T.Vector2() },
          uSun: { value: new T.Vector2() },
          tSunVisible: { value: null },
          uSunColor: { value: this.sunColor },
          uBloom: { value: 0.06 },
          uRays: { value: 0.55 },
          uFlare: { value: 1 },
          uExposureBias: { value: 0 },
          uMinExposure: { value: 0.15 },
          uMaxExposure: { value: 6 },
          uTime: { value: 0 },
          uSpeedBlur: { value: 0 },
          uFlash: { value: 0 },
          uShock: { value: 0 },
          uShockCenter: { value: this.effects.shockCenter },
          uVignette: { value: 0.32 },
          // 1: ACES filmic (0: AgX, kept for comparison).
          uTonemapper: { value: 1 },
        },
      }),
    );
    this.envDome = new T.Mesh(
      new T.SphereGeometry(5, 32, 16),
      new T.ShaderMaterial({
        glslVersion: T.GLSL3,
        side: T.BackSide,
        depthWrite: false,
        toneMapped: false,
        uniforms: {
          tTransmittance: lut.tTransmittance,
          tSkyView: lut.tSkyView,
          uSunDir: { value: this.atmosphere.sunDirection },
          uCameraR: { value: 6360.1 },
          uSunIlluminance: { value: SUN_ILLUMINANCE },
        },
        vertexShader: `out vec3 vDirection; void main(){ vDirection = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: ENVIRONMENT_DOME,
      }),
    );
    this.envScene.add(this.envDome);
  }
  weather: WeatherName = "fair";
  setWeather(name: WeatherName) {
    this.weather = name;
    Object.assign(this.clouds.weatherState, WEATHER[name]);
    this.clouds.invalidate();
  }
  setQuality(quality: SkyQuality) {
    this.quality = quality;
    this.clouds.setQuality(quality);
    this.composite.material.uniforms.uOceanDetail.value =
      quality === "low" ? 0 : 1;
    const samples = quality === "high" ? 4 : quality === "medium" ? 2 : 0;
    if (this.sceneTarget.samples !== samples) {
      this.sceneTarget.dispose();
      this.sceneTarget.samples = samples;
    }
    this.width = this.height = 1;
  }
  get depthTexture() {
    return this.depth;
  }
  private resize() {
    const size = this.renderer.getDrawingBufferSize(new T.Vector2());
    const w = Math.max(1, Math.floor(size.x)),
      h = Math.max(1, Math.floor(size.y));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneTarget.setSize(w, h);
    this.compositeTarget.setSize(w, h);
    this.clouds.setSize(w, h);
    for (const t of [...this.bloomMips, ...this.bloomUps]) t.dispose();
    this.bloomMips = [];
    this.bloomUps = [];
    let mw = w,
      mh = h;
    for (let i = 0; i < 7; i++) {
      mw = Math.max(1, Math.floor(mw / 2));
      mh = Math.max(1, Math.floor(mh / 2));
      this.bloomMips.push(hdrTarget(mw, mh));
      this.bloomUps.push(hdrTarget(mw, mh));
    }
    this.rayMask.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.rayBlur.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.firstFrame = true;
  }
  /** Rebuilds the image-based lighting from the current sky when it has changed enough. */
  private updateEnvironment(scene: T.Scene, altitude: number, dt: number) {
    this.envTimer -= dt;
    const sunMoved = this.envSun.angleTo(this.atmosphere.sunDirection) > 0.01;
    const climbed = Math.abs(altitude - this.envAltitude) > 400;
    if (!(this.envTimer <= 0 && (sunMoved || climbed)) && this.pmremTarget)
      return;
    this.envTimer = 0.5;
    this.envSun.copy(this.atmosphere.sunDirection);
    this.envAltitude = altitude;
    (this.envDome.material as T.ShaderMaterial).uniforms.uCameraR.value =
      6360 + Math.max(0.002, altitude / 1000);
    this.envCamera.update(this.renderer, this.envScene);
    this.pmrem ??= new T.PMREMGenerator(this.renderer);
    const target = this.pmrem.fromCubemap(
      this.envTarget.texture,
      this.pmremTarget ?? null,
    );
    this.pmremTarget = target;
    scene.environment = target.texture;
  }
  update(dt: number) {
    this.elapsed += dt;
    this.clouds.step(dt);
  }
  /** Sun (or moon) light for the opaque scene, coloured by the atmosphere above the camera. */
  private updateLighting(altitude: number) {
    const sun = this.time.sun;
    sunlightTransmittance(altitude, sun, this.sunColor);
    const night = this.time.night;
    if (sun.y > -0.03) {
      this.sunLight.color.copy(this.sunColor);
      this.sunLight.intensity = SUN_ILLUMINANCE;
    } else {
      // Moonlight: faint, cool and from the moon's direction.
      this.sunLight.color.setRGB(0.55, 0.65, 0.9);
      this.sunLight.intensity =
        SUN_ILLUMINANCE * 0.012 * Math.max(0, this.time.moon.y) * night;
    }
  }
  /** Direction the shadow-casting light shines from (sun by day, moon by night). */
  get lightDirection() {
    return this.time.sun.y > -0.03 ? this.time.sun : this.time.moon;
  }
  render(
    scene: T.Scene,
    camera: T.PerspectiveCamera,
    cameraGlobal: T.Vector3,
    dt: number,
  ) {
    const renderer = this.renderer;
    this.resize();
    const altitude = Math.max(1, cameraGlobal.y);
    this.altitude = altitude;
    this.time.update(dt);
    this.updateLighting(altitude);
    this.atmosphere.update(renderer, camera, altitude, this.time.sun);
    this.updateEnvironment(scene, altitude, dt);

    // 1. Opaque scene into the multisampled HDR target.
    const layers = camera.layers.mask;
    camera.layers.set(0);
    renderer.shadowMap.needsUpdate = true;
    renderer.setRenderTarget(this.sceneTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    // 2. Lightning sets this frame's in-cloud flash, then the clouds
    //    (reduced resolution, temporally resolved).
    this.origin.copy(cameraGlobal).sub(camera.position);
    this.lightning.update(dt, cameraGlobal, this.origin, camera, this.resolution.set(this.width, this.height));
    this.clouds.render(renderer, camera, cameraGlobal, SUN_ILLUMINANCE);
    this.lightning.bindClouds();
    const [cloudColor, cloudDepth] = this.clouds.textures;

    // 3. Atmosphere + ocean + cloud composite, carrying depth forward.
    this.rotation.extractRotation(camera.matrixWorld);
    this.rayMatrix.copy(this.rotation).multiply(camera.projectionMatrixInverse);
    this.viewRotation.copy(this.rotation).invert();
    const u = this.composite.material.uniforms;
    u.tClouds.value = cloudColor;
    u.tCloudDepth.value = cloudDepth;
    u.uCloudResolution.value.copy(this.clouds.resolution);
    u.uProjectionInverse.value.copy(camera.projectionMatrixInverse);
    u.uProjection.value.copy(camera.projectionMatrix);
    u.uCameraGlobal.value.copy(cameraGlobal);
    u.uTime.value = this.elapsed;
    const flash = this.lightning.flash;
    u.uFlash.value.set(flash.x - cameraGlobal.x, 1100 - cameraGlobal.y, flash.z - cameraGlobal.z, this.lightning.light.intensity);
    const highStars = T.MathUtils.smoothstep(altitude, 25000, 40000);
    // Stars only once the sun is well below the horizon (nautical twilight onward).
    const starNight = T.MathUtils.smoothstep(-this.time.sun.y, 0.07, 0.22);
    u.uStars.value = Math.max(starNight, highStars * 0.04);
    u.uPixelAngle.value =
      (2 * Math.tan(T.MathUtils.degToRad(camera.fov) / 2)) / this.height;
    this.composite.render(renderer, this.compositeTarget);

    // 4. Transparent effects, depth-tested against the composited depth.
    camera.layers.set(TRANSPARENT_LAYER);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    const background = scene.background;
    scene.background = null;
    renderer.setRenderTarget(this.compositeTarget);
    renderer.render(scene, camera);
    scene.background = background;
    renderer.autoClear = autoClear;
    camera.layers.mask = layers;

    this.post(camera, dt);
    this.firstFrame = false;
  }
  private post(camera: T.PerspectiveCamera, dt: number) {
    const renderer = this.renderer;
    // Bloom: downsample chain then tent upsample accumulation.
    let input: T.Texture = this.compositeTarget.texture;
    let iw = this.width,
      ih = this.height;
    const down = this.bloomDown.material.uniforms;
    for (let i = 0; i < this.bloomMips.length; i++) {
      down.tInput.value = input;
      down.uTexel.value.set(1 / iw, 1 / ih);
      down.uFirst.value = i === 0 ? 1 : 0;
      this.bloomDown.render(renderer, this.bloomMips[i]);
      input = this.bloomMips[i].texture;
      iw = this.bloomMips[i].width;
      ih = this.bloomMips[i].height;
    }
    const up = this.bloomUp.material.uniforms;
    let upInput: T.Texture = this.bloomMips[this.bloomMips.length - 1].texture;
    for (let i = this.bloomMips.length - 2; i >= 0; i--) {
      const source = this.bloomMips[i + 1];
      up.tInput.value = upInput;
      up.tBase.value = this.bloomMips[i].texture;
      up.uTexel.value.set(1 / source.width, 1 / source.height);
      up.uRadius.value = 1;
      this.bloomUp.render(renderer, this.bloomUps[i]);
      upInput = this.bloomUps[i].texture;
    }

    // Eye adaptation from a mid-level mip.
    const adapt = this.adaptPass.material.uniforms;
    const read = this.exposure[this.exposureIndex],
      write = this.exposure[1 - this.exposureIndex];
    adapt.tInput.value = this.bloomMips[4].texture;
    adapt.tPrevious.value = read.texture;
    adapt.uDelta.value = dt;
    adapt.uReset.value = this.firstFrame ? 1 : 0;
    this.adaptPass.render(renderer, write);
    this.exposureIndex = 1 - this.exposureIndex;

    // Sun position in screen space.
    const sun = this.lightDirection === this.time.sun ? this.time.sun : null;
    this.sunScreen
      .copy(camera.position)
      .addScaledVector(this.time.sun, 1e5)
      .project(camera);
    const inFront =
      sun !== null &&
      this.sunScreen.z < 1 &&
      new T.Vector3(0, 0, -1)
        .applyQuaternion(camera.quaternion)
        .dot(this.time.sun) > 0;
    const sunUv = new T.Vector2(
      this.sunScreen.x * 0.5 + 0.5,
      this.sunScreen.y * 0.5 + 0.5,
    );
    const onScreen =
      inFront && sunUv.x > -0.3 && sunUv.x < 1.3 && sunUv.y > -0.3 && sunUv.y < 1.3;

    const vis = this.visibilityPass.material.uniforms;
    const vread = this.visibility[this.visibilityIndex],
      vwrite = this.visibility[1 - this.visibilityIndex];
    vis.tClouds.value = this.clouds.textures[0];
    vis.tPrevious.value = vread.texture;
    vis.uSun.value.copy(sunUv);
    vis.uRadius.value.set(0.004, 0.004 * (this.width / this.height));
    vis.uInFront.value = inFront ? 1 : 0;
    vis.uDelta.value = this.firstFrame ? 1 : dt;
    this.visibilityPass.render(renderer, vwrite);
    this.visibilityIndex = 1 - this.visibilityIndex;

    const rays = this.rayMaskPass.material.uniforms;
    rays.tClouds.value = this.clouds.textures[0];
    rays.uHorizon.value = -Math.sin(Math.acos(6360 / (6360 + this.altitude / 1000)));
    rays.uSun.value.copy(sunUv);
    rays.uAspect.value = this.width / this.height;
    if (onScreen) {
      this.rayMaskPass.render(renderer, this.rayMask);
      this.rayBlurPass.material.uniforms.uSun.value.copy(sunUv);
      this.rayBlurPass.render(renderer, this.rayBlur);
    } else {
      renderer.setRenderTarget(this.rayBlur);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
    }

    const f = this.finalPass.material.uniforms;
    f.tBloom.value = this.bloomUps[0].texture;
    f.tExposure.value = write.texture;
    f.tSunVisible.value = vwrite.texture;
    f.uResolution.value.set(this.width, this.height);
    f.uSun.value.copy(sunUv);
    f.uTime.value = this.elapsed;
    f.uExposureBias.value = this.exposureBias;
    f.uSpeedBlur.value = this.effects.speedBlur;
    f.uShock.value = this.effects.shock;
    f.uFlash.value = this.effects.flash;
    const night = this.time.night;
    f.uMinExposure.value = 0.25;
    // Open the eye up through twilight, well before full night.
    f.uMaxExposure.value = T.MathUtils.lerp(5, 40, T.MathUtils.smoothstep(-this.time.sun.y, -0.06, 0.08));
    f.uRays.value = onScreen ? 0.3 * SUN_ILLUMINANCE * (1 - night) : 0;
    this.finalPass.render(renderer, null);
  }
  dispose() {
    this.atmosphere.dispose();
    this.clouds.dispose();
    for (const t of [
      this.sceneTarget,
      this.compositeTarget,
      this.rayMask,
      this.rayBlur,
      ...this.exposure,
      ...this.visibility,
      ...this.bloomMips,
      ...this.bloomUps,
    ])
      t.dispose();
    this.depth.dispose();
    for (const pass of [
      this.composite,
      this.bloomDown,
      this.bloomUp,
      this.rayMaskPass,
      this.rayBlurPass,
      this.adaptPass,
      this.visibilityPass,
      this.finalPass,
    ])
      pass.dispose();
    this.envTarget.dispose();
    this.pmremTarget?.dispose();
    this.pmrem?.dispose();
  }
}

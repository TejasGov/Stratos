import * as T from "three";
import { FullscreenPass, hdrTarget, passMaterial } from "./FullscreenPass";
import { DETAIL_NOISE, SHAPE_NOISE, WEATHER_NOISE } from "./shaders/noise";
import { CLOUD_MARCH, CLOUD_RESOLVE, CLOUD_SHADOW } from "./shaders/clouds";
import type { Atmosphere } from "./Atmosphere";

export type CloudQuality = "low" | "medium" | "high";
const SETTINGS = {
  low: { scale: 0.25, steps: 56 },
  medium: { scale: 1 / 3, steps: 80 },
  high: { scale: 0.5, steps: 110 },
} as const;

export interface WeatherState {
  coverage: number;
  storm: number;
  density: number;
}

function volumeTarget(size: number) {
  const target = new T.WebGL3DRenderTarget(size, size, size, {
    format: T.RGBAFormat,
    type: T.UnsignedByteType,
    depthBuffer: false,
    generateMipmaps: false,
  });
  const texture = target.texture;
  texture.wrapS = texture.wrapT = texture.wrapR = T.RepeatWrapping;
  texture.minFilter = texture.magFilter = T.LinearFilter;
  return target;
}

/**
 * Raymarched volumetric clouds with temporal accumulation. The march runs at a
 * reduced resolution with per-frame jitter; history is reprojected with each
 * pixel's mean cloud depth so the deck stays stable at fighter speeds.
 */
export class Clouds {
  readonly shape = volumeTarget(128);
  readonly detail = volumeTarget(32);
  readonly weather = new T.WebGLRenderTarget(512, 512, {
    format: T.RGBAFormat,
    type: T.UnsignedByteType,
    depthBuffer: false,
    generateMipmaps: false,
    wrapS: T.RepeatWrapping,
    wrapT: T.RepeatWrapping,
    minFilter: T.LinearFilter,
    magFilter: T.LinearFilter,
  });
  readonly shadow = hdrTarget(256, 256);
  private march = hdrTarget(1, 1, { count: 2, minFilter: T.NearestFilter, magFilter: T.NearestFilter });
  private history = [
    hdrTarget(1, 1, { count: 2 }),
    hdrTarget(1, 1, { count: 2 }),
  ];
  private current = 0;
  private marchPass: FullscreenPass;
  private resolvePass: FullscreenPass;
  private shadowPass: FullscreenPass;
  private generated = false;
  private frame = 0;
  private reset = true;
  private quality: CloudQuality = "medium";
  private width = 1;
  private height = 1;
  private previousViewProjection = new T.Matrix4();
  private previousCamera = new T.Vector3();
  private rotation = new T.Matrix4();
  private rayMatrix = new T.Matrix4();
  private viewRotation = new T.Matrix4();
  readonly shadowCenter = new T.Vector2();
  readonly shadowExtent = 26000;
  readonly weatherState: WeatherState = { coverage: 0.52, storm: 0.35, density: 1 };
  readonly windOffset = new T.Vector2();
  readonly shapeOffset = new T.Vector3();
  readonly lightning = { intensity: 0, position: new T.Vector3() };
  private density: Record<string, T.IUniform>;
  constructor(atmosphere: Atmosphere, private depth: T.DepthTexture) {
    const cameraWorld = new T.Vector3();
    this.density = {
      tWeather: { value: this.weather.texture },
      tShape: { value: this.shape.texture },
      tDetail: { value: this.detail.texture },
      uCoverage: { value: 0.5 },
      uStorm: { value: 0.3 },
      uDensity: { value: 1 },
      uWeatherOffset: { value: this.windOffset },
      uShapeOffset: { value: this.shapeOffset },
      uCameraWorld: { value: cameraWorld },
      uSunDir: { value: atmosphere.sunDirection },
    };
    const lut = atmosphere.uniforms;
    this.marchPass = new FullscreenPass(
      passMaterial({
        fragmentShader: CLOUD_MARCH,
        uniforms: {
          ...this.density,
          tTransmittance: lut.tTransmittance,
          tSkyView: lut.tSkyView,
          tDepth: { value: depth },
          uRayMatrix: { value: this.rayMatrix },
          uProjectionInverse: { value: new T.Matrix4() },
          uResolution: { value: new T.Vector2(1, 1) },
          uClip: { value: new T.Vector2(1, 1) },
          uSunIlluminance: { value: 1 },
          uSunScale: { value: 1 },
          uFrame: { value: 0 },
          uMaxSteps: { value: 80 },
          uMaxDistance: { value: 160000 },
          uLightning: { value: 0 },
          uLightningPos: { value: this.lightning.position },
        },
      }),
    );
    this.resolvePass = new FullscreenPass(
      passMaterial({
        fragmentShader: CLOUD_RESOLVE,
        uniforms: {
          tCurrent: { value: this.march.textures[0] },
          tCurrentDepth: { value: this.march.textures[1] },
          tHistory: { value: null },
          tHistoryDepth: { value: null },
          uRayMatrix: { value: this.rayMatrix },
          uPreviousViewProjection: { value: this.previousViewProjection },
          uCameraDelta: { value: new T.Vector3() },
          uResolution: { value: new T.Vector2(1, 1) },
          uReset: { value: 1 },
        },
      }),
    );
    this.shadowPass = new FullscreenPass(
      passMaterial({
        fragmentShader: CLOUD_SHADOW,
        uniforms: {
          ...this.density,
          uShadowCenter: { value: this.shadowCenter },
          uShadowExtent: { value: this.shadowExtent },
        },
      }),
    );
  }
  /** The resolved cloud layer: RGB scattered light, A transmittance; [1].x = mean depth. */
  get textures() {
    return this.history[this.current].textures;
  }
  get resolution() {
    return new T.Vector2(this.width, this.height);
  }
  setQuality(quality: CloudQuality) {
    this.quality = quality;
    this.reset = true;
  }
  invalidate() {
    this.reset = true;
  }
  setSize(width: number, height: number) {
    const scale = SETTINGS[this.quality].scale;
    const w = Math.max(32, Math.round(width * scale)),
      h = Math.max(32, Math.round(height * scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.march.setSize(w, h);
    for (const target of this.history) target.setSize(w, h);
    this.reset = true;
  }
  private generate(renderer: T.WebGLRenderer) {
    const shape = new FullscreenPass(
      passMaterial({ fragmentShader: SHAPE_NOISE, uniforms: { uLayer: { value: 0 } } }),
    );
    for (let layer = 0; layer < 128; layer++) {
      shape.material.uniforms.uLayer.value = layer;
      shape.render(renderer, this.shape, layer);
    }
    const detail = new FullscreenPass(
      passMaterial({ fragmentShader: DETAIL_NOISE, uniforms: { uLayer: { value: 0 } } }),
    );
    for (let layer = 0; layer < 32; layer++) {
      detail.material.uniforms.uLayer.value = layer;
      detail.render(renderer, this.detail, layer);
    }
    const weather = new FullscreenPass(passMaterial({ fragmentShader: WEATHER_NOISE }));
    weather.render(renderer, this.weather);
    shape.dispose();
    detail.dispose();
    weather.dispose();
    this.generated = true;
  }
  /** Advances wind and weather uniforms; call once per frame before render(). */
  step(dt: number) {
    // 14 m/s prevailing wind; shapes evolve slightly faster than the coverage map.
    this.windOffset.x += 14 * dt;
    this.windOffset.y += 4 * dt;
    this.shapeOffset.x += 16 * dt;
    this.shapeOffset.y += 0.4 * dt;
    this.shapeOffset.z += 5 * dt;
    this.density.uCoverage.value = this.weatherState.coverage;
    this.density.uStorm.value = this.weatherState.storm;
    this.density.uDensity.value = this.weatherState.density;
  }
  render(
    renderer: T.WebGLRenderer,
    camera: T.PerspectiveCamera,
    cameraGlobal: T.Vector3,
    sunIlluminance: number,
  ) {
    const previousTarget = renderer.getRenderTarget();
    if (!this.generated) this.generate(renderer);
    this.frame = (this.frame + 1) % 4096;
    (this.density.uCameraWorld.value as T.Vector3).copy(cameraGlobal);
    // Shadow map follows the camera, snapped to its texels to avoid crawling.
    const texel = this.shadowExtent / 256;
    this.shadowCenter.set(
      Math.round(cameraGlobal.x / texel) * texel,
      Math.round(cameraGlobal.z / texel) * texel,
    );
    this.shadowPass.render(renderer, this.shadow);

    this.rotation.extractRotation(camera.matrixWorld);
    this.rayMatrix.copy(this.rotation).multiply(camera.projectionMatrixInverse);
    const march = this.marchPass.material.uniforms;
    march.uProjectionInverse.value.copy(camera.projectionMatrixInverse);
    march.uResolution.value.set(this.width, this.height);
    march.uClip.value.set(camera.near, camera.far);
    march.uSunIlluminance.value = sunIlluminance;
    march.uFrame.value = this.frame;
    march.uMaxSteps.value = SETTINGS[this.quality].steps;
    march.uLightning.value = this.lightning.intensity;
    this.marchPass.render(renderer, this.march);

    const read = this.history[this.current],
      write = this.history[1 - this.current];
    const resolve = this.resolvePass.material.uniforms;
    resolve.tHistory.value = read.textures[0];
    resolve.tHistoryDepth.value = read.textures[1];
    resolve.uResolution.value.set(this.width, this.height);
    resolve.uCameraDelta.value.copy(cameraGlobal).sub(this.previousCamera);
    resolve.uReset.value = this.reset ? 1 : 0;
    this.resolvePass.render(renderer, write);
    this.current = 1 - this.current;
    this.reset = false;

    // Store this frame's rotation-only view-projection for next frame's reprojection.
    this.viewRotation.copy(this.rotation).invert();
    this.previousViewProjection
      .copy(camera.projectionMatrix)
      .multiply(this.viewRotation);
    this.previousCamera.copy(cameraGlobal);
    renderer.setRenderTarget(previousTarget);
  }
  dispose() {
    for (const target of [
      this.shape,
      this.detail,
      this.weather,
      this.shadow,
      this.march,
      ...this.history,
    ])
      target.dispose();
    this.marchPass.dispose();
    this.resolvePass.dispose();
    this.shadowPass.dispose();
  }
}

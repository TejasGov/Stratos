import "./style.css";
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { animate, createTimeline, engine } from "animejs";
import { World } from "./world/World";
import { heightAt, renderedHeightAt, SEED } from "./world/terrain";
import { Flight, neutral, overRunway, runwayAt } from "./flight";
import { BLACKRIDGE, HAVEN } from "./world/bases";
import { toWorld } from "./world/baseLayout";
import { Mission, landmarks, routes, type RouteId } from "./missions";
import { FlightAudio } from "./audio";
import { Comms, type Line } from "./comms";
import { createUI, el } from "./ui";
import { Hud } from "./ui/Hud";
import { FrameTelemetry } from "./render/FrameTelemetry";
import { DynamicResolution } from "./render/DynamicResolution";
import {
  FlightInput,
  type CombatAction,
  defaultBindings,
} from "./input/FlightInput";
import { Effects, type EffectsQuality } from "./effects/Effects";
import type { CollisionWorld } from "./physics/CollisionWorld";
import {
  SkyEngine,
  SUN_ILLUMINANCE,
  TRANSPARENT_LAYER,
  WEATHER,
  type WeatherName,
} from "./sky/SkyEngine";
import { Supersonic } from "./effects/Supersonic";
import {
  FLEET,
  airframe,
  airframePoint,
  airframeRatings,
  airframeScale,
  type Airframe,
} from "./aircraft";
import { CombatSystem, type CombatMission } from "./combat/CombatSystem";
import { CombatView } from "./combat/CombatView";
import { HOME_UMBRELLA, SAM_RULES, radarDetectionRange } from "./combat/AirDefense";

type State = "menu" | "flight" | "paused" | "crashed";
interface Save {
  version: 1;
  seed: number;
  discovered: string[];
  best: Partial<Record<RouteId, number>>;
  quality: string;
  invert: boolean;
  sensitivity: number;
  audio: boolean;
  bindings?: Partial<Record<CombatAction, string>>;
  shake?: boolean;
  hudScale?: number;
  controlMode?: "assisted" | "advanced";
  hours?: number;
  weather?: WeatherName;
  ascentBest?: number;
  aircraft?: string;
  dynamicResolution?: boolean;
  comms?: boolean;
}
/** Altitudes Haven Control calls out on the way up (metres). */
const RADIO_MILESTONES = [
  [11000, "tropopause"],
  [20000, "stratosphere"],
  [30000, "edge"],
] as const;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
createUI();
/** A point at Haven in runway-frame (lat, s), `h` metres above the field. */
const havenPoint = (lat: number, s: number, h: number) => {
  const p = toWorld(HAVEN, lat, s);
  return new T.Vector3(p.x, HAVEN.runway.elevation + h, p.z);
};
/**
 * Sortie opening: close shots of Haven's people, cut together, ending behind
 * the saluting ground crew as the camera finds the jet (look: null) on the runway.
 */
const INTRO_SHOTS = [
  // Low dolly past the PT drill in front of the barracks, joggers beyond.
  { seconds: 3.2, from: havenPoint(-156, -134, 1.6), to: havenPoint(-155, -160, 2.1), look: havenPoint(-167, -147, 1) },
  // Across the apron: a crew talking between the parked jets.
  { seconds: 3, from: havenPoint(178, -110, 1.8), to: havenPoint(181, -82, 2.4), look: havenPoint(190, -95, 1.3) },
  // Behind the ground crew at the threshold, panning to the jet.
  { seconds: 3, from: havenPoint(64, -664, 1.9), to: havenPoint(52, -684, 2.3), look: null },
];
const INTRO_SECONDS = INTRO_SHOTS.reduce((t, shot) => t + shot.seconds, 0);
const INTRO_CREW = havenPoint(42, -706, 1.6);

class Game {
  renderer: T.WebGLRenderer;
  scene = new T.Scene();
  camera = new T.PerspectiveCamera(56, innerWidth / innerHeight, 1, 60000);
  flight = new Flight();
  mission = new Mission();
  audio = new FlightAudio();
  comms = new Comms(this.audio);
  world: World;
  effects: Effects;
  combat = new CombatSystem();
  combatView: CombatView;
  physics?: CollisionWorld;
  private physicsReady: Promise<void>;
  sky: SkyEngine;
  supersonic: Supersonic;
  private cameraGlobal = new T.Vector3();
  private planeGlobal = new T.Vector3();
  private sunTint = new T.Color();
  private ambientTint = new T.Color();
  private shock = 0;
  plane = new T.Group();
  state: State = "menu";
  loaded = false;
  keys = new Set<string>();
  inputActions = new FlightInput();
  cameraMode = 0;
  cameraBlend = { value: 0 };
  settings = {
    quality: "medium",
    invert: false,
    sensitivity: 1,
    shake: !reducedMotion,
    hudScale: 1,
    controlMode: "assisted" as "assisted" | "advanced",
    hours: 17.6,
    weather: "fair" as WeatherName,
    aircraft: "sf35",
    dynamicResolution: true,
    comms: true,
  };
  private resolution = new DynamicResolution();
  /** Ascent challenge: climb from the sea to 30 km against the clock. */
  ascent = { active: false, done: false, time: 0, best: undefined as number | undefined };
  private showcaseTime = 0;
  private last = 0;
  private accumulator = 0;
  private time = 0;
  private hudTime = 0;
  private mapTime = 0;
  private saveTime = 0;
  private fps = 60;
  private telemetry = new FrameTelemetry();
  private lastThreatCue = 0;
  /** Warning-receiver cues: search pings, launch warble cadence. */
  private rwrAudio = { search: 0, ping: 0, launch: 0 };
  /** What Haven Control has already called this flight. */
  /** Title theme, streamed: fades in on the title screen, out when a sortie starts. */
  private theme = Object.assign(new Audio("/assets/music/stratos-theme.mp3"), {
    loop: true,
    preload: "none",
    volume: 0,
  });
  /** War: last phase, wingmen and wave call announced on the radio. */
  private warRadio = { phase: 0, wingmen: 2, waveCalled: false };
  private radio = { milestone: 0, kills: 0, damaged: false, threat: false, spiked: false, terrainCue: 0 };
  private lastLock = false;
  /** Radio call held until wheels-up: the brief only makes sense once airborne. */
  private liftoffCall: Line | null = null;
  private hitUntil = 0;
  private shakeAmount = 0;
  private missileEmitters = new Set<string>();
  private damageEmitters = new Set<string>();
  private queryPoint = new T.Vector3();
  private nozzleWorld = new T.Vector3();
  private flareForward = new T.Vector3();
  private flareUp = new T.Vector3();
  private targetFollow = false;
  private mouseGun = false;
  private mouseSteering = false;
  private mouseAim = new T.Vector2();
  private steeringDirection = new T.Vector3();
  private leadPoint = new T.Vector3();
  private hudBomb = new T.Vector3();
  private cameraReady = false;
  private toastAnimation?: ReturnType<typeof createTimeline>;
  private ringGroup = new T.Group();
  private rings: T.Mesh[] = [];
  private local = new T.Vector3();
  private rotation = new T.Quaternion();
  private forward = new T.Vector3();
  private offset = new T.Vector3();
  private look = new T.Vector3();
  private projected = new T.Vector3();
  private mapTerrain = document.createElement("canvas");
  hud: Hud;
  private warningText = "";
  private hudLead = new T.Vector3();
  private hudTarget = new T.Vector3();
  private hudGate = new T.Vector3();
  private drawingSize = new T.Vector2();
  private mapCell = "";
  constructor() {
    this.renderer = new T.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.type = T.PCFShadowMap;
    el("scene").appendChild(this.renderer.domElement);
    this.hud = new Hud(el("hud"));
    this.world = new World(this.scene);
    this.world.configure(this.renderer);
    this.sky = new SkyEngine(this.renderer, this.world.sun);
    this.scene.environmentIntensity = 1;
    this.effects = new Effects(this.scene);
    this.effects.group.traverse((o) => o.layers.set(TRANSPARENT_LAYER));
    this.effects.groundHeight = (x, z) => Math.max(0, renderedHeightAt(x, z));
    this.combatView = new CombatView(this.scene);
    this.combatView.group.traverse((o) => {
      if (o instanceof T.LineSegments) o.layers.set(TRANSPARENT_LAYER);
    });
    this.combatView.loadDefenseModels(this.gltf).catch(() => {});
    // Strike damage shows on the world's buildings; combat never imports world code.
    this.combat.onTargetDestroyed = (id) => {
      this.world.airbase.destroy(id);
      this.world.crowds.strike(id);
      if (this.combat.active === "war") this.comms.say("warBombHit", 0.6);
    };
    this.world.crowds.load(this.gltf).catch(() => {});
    this.physicsReady = import("./physics/CollisionWorld")
      .then(({ CollisionWorld }) => CollisionWorld.create(heightAt))
      .then((physics) => {
        this.physics = physics;
      });
    this.physicsReady.catch(() => {}); // loadAircraft reports initialization failures after both loads settle.
    this.scene.add(this.plane);
    this.scene.add(this.ringGroup);
    this.supersonic = new Supersonic(this.scene, this.plane);
    // Lightning: bolts and their flash light are part of the scene from the start
    // so materials compile once with the point light present.
    const lightning = this.sky.lightning;
    lightning.groundHeight = (x, z) => heightAt(x, z);
    lightning.onStrike = (distance, power) => this.audio.thunder(distance, power);
    this.scene.add(lightning.group, lightning.light);
    this.supersonic.onBoom = (position) => {
      // Sonic boom: shockwave ripple centred on the jet, a jolt and the boom itself.
      this.shock = 1;
      this.projected.copy(position).sub(this.world.origin).project(this.camera);
      this.sky.effects.shockCenter.set(
        this.projected.x * 0.5 + 0.5,
        this.projected.y * 0.5 + 0.5,
      );
      if (this.settings.shake) this.shakeAmount = Math.max(this.shakeAmount, 1.6);
      this.audio.boom();
      this.hud.announce("MACH 1", "THROUGH THE SOUND BARRIER", this.time);
      if (this.state === "flight") this.comms.say("machOne", 1.4);
    };
    this.comms.onSubtitle = (text, speaker) => this.subtitle(text, speaker);
    this.flight.onTouchdown = (sink) => {
      this.hud.announce("TOUCHDOWN", `SINK ${sink.toFixed(1)} M/S · Z BRAKES`, this.time);
      if (this.state === "flight") this.comms.say("welcomeHome", 0.8);
    };
    this.loadSave();
    this.setState("menu");
    this.bindUI();
    this.sky.time.hours = this.settings.hours;
    this.sky.setWeather(this.settings.weather);
    this.syncConditions();
    this.mapTerrain.width = this.mapTerrain.height = 108;
    engine.useDefaultMainLoop = false;
    this.renderer.setAnimationLoop((t) => this.frame(t));
    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.setState("paused");
      this.fatal(
        "The graphics connection was interrupted. Reload to restore your flight; discovered landmarks and settings are saved.",
      );
    });
    this.loadAircraft();
  }
  private gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private models = new Map<string, Promise<T.Object3D>>();
  private airframe = FLEET[0];
  private planeModel?: T.Object3D;
  private hangarToken = 0;
  /** Loads (once) and normalises a fleet model into the aircraft frame. */
  private loadModel(a: Airframe, onProgress?: (fraction: number) => void) {
    let model = this.models.get(a.id);
    if (!model) {
      model = this.gltf
        .loadAsync(a.file, (e) => onProgress?.(e.total ? e.loaded / e.total : 0.5))
        .then((gltf) => {
          const root = gltf.scene;
          root.rotation.y = -Math.PI / 2;
          root.scale.setScalar(airframeScale(a));
          // The lowest point of the model sits on the runway when parked.
          root.updateMatrixWorld(true);
          root.userData.gear = Math.max(1, -new T.Box3().setFromObject(root).min.y);
          root.traverse((o) => {
            if (o instanceof T.Mesh) {
              o.frustumCulled = false;
              o.castShadow = true;
              const mats = Array.isArray(o.material) ? o.material : [o.material];
              for (const mat of mats)
                if (mat instanceof T.MeshStandardMaterial) {
                  mat.envMapIntensity = 0.85;
                  mat.roughness = Math.max(0.6, mat.roughness);
                }
            }
          });
          return root as T.Object3D;
        });
      model.catch(() => this.models.delete(a.id));
      this.models.set(a.id, model);
    }
    return model;
  }
  /** Puts an airframe on the player: model, flight performance and engine effects. */
  private applyAirframe(a: Airframe, model: T.Object3D) {
    if (this.planeModel) this.plane.remove(this.planeModel);
    this.planeModel = model;
    this.plane.add(model);
    this.airframe = a;
    this.flight.configure(a);
    this.flight.gearHeight = model.userData.gear ?? 2;
    this.combat.rcs = a.rcs;
    const scale = airframeScale(a);
    this.supersonic.setAirframe(
      a.nozzles.map((n) => airframePoint(a, n)),
      a.nozzleRadius * scale,
      airframePoint(a, a.tip),
      a.length,
      a.engines,
    );
    this.combatView.setAircraftTemplate(model);
  }
  private syncHangar() {
    const a = this.airframe;
    const index = FLEET.indexOf(a);
    el("hangar-index").textContent = `${index + 1} / ${FLEET.length}`;
    el("hangar-name").textContent = a.name;
    el("hangar-gen").textContent = a.generation;
    el("hangar-inspired").textContent = `Inspired by the ${a.inspiredBy} · ${a.role} · Mach ${a.maxMach}`;
    const ratings = airframeRatings(a);
    el("hangar-stats").innerHTML = (["speed", "agility", "climb"] as const)
      .map(
        (k) =>
          `<span>${k.toUpperCase()}</span><span class="bar">${Array.from(
            { length: 10 },
            (_, i) => `<i${i < ratings[k] ? ' class="on"' : ""}></i>`,
          ).join("")}</span>`,
      )
      .join("");
  }
  /** Hangar: steps through the fleet, loading each model on first view. */
  private async selectAircraft(step: number) {
    const index = (FLEET.indexOf(this.airframe) + step + FLEET.length) % FLEET.length;
    const a = FLEET[index];
    this.airframe = a;
    this.settings.aircraft = a.id;
    this.save();
    this.syncHangar();
    const token = ++this.hangarToken;
    el("hangar").classList.add("loading");
    try {
      const model = await this.loadModel(a);
      if (token !== this.hangarToken) return;
      await this.renderer.compileAsync(model, this.camera, this.scene);
      if (token !== this.hangarToken) return;
      this.applyAirframe(a, model);
      this.loadAdversaries();
    } catch {
      if (token === this.hangarToken)
        this.toast("That aircraft could not be loaded. Check the connection and try again.", "HANGAR");
    } finally {
      if (token === this.hangarToken) el("hangar").classList.remove("loading");
    }
  }
  /** Hostile fighters come from the rest of the fleet (never the player's own type). */
  private adversaryToken = 0;
  private async loadAdversaries() {
    const ids = ["su57", "j20", "su30", "f22"].filter((id) => id !== this.airframe.id).slice(0, 3);
    const token = ++this.adversaryToken;
    try {
      const models = await Promise.all(ids.map((id) => this.loadModel(airframe(id))));
      if (token !== this.adversaryToken) return;
      this.combatView.setEnemyTemplates(models);
      this.world.airbase.setParkedAircraft(models);
    } catch {
      // Enemies fall back to the player's model.
    }
  }
  private async loadAircraft() {
    try {
      const chosen = airframe(this.settings.aircraft);
      this.airframe = chosen;
      this.syncHangar();
      const token = this.hangarToken;
      const model = await this.loadModel(chosen, (fraction) => {
        el("load-progress").style.width = `${Math.min(95, fraction * 95)}%`;
      });
      // The hangar may already have moved on (and applied its own choice).
      if (token === this.hangarToken) this.applyAirframe(chosen, model);
      await this.physicsReady;
      await this.world.materialsReady;
      if (this.world.materialError)
        throw new Error(
          `Terrain textures failed to load: ${this.world.materialError}`,
        );
      await this.renderer.compileAsync(this.scene, this.camera);
      this.loaded = true;
      el<HTMLButtonElement>("start").disabled = false;
      document.querySelectorAll<HTMLButtonElement>(".mode").forEach((button) => {
        button.disabled = false;
      });
      el("start-label").textContent = "TAKE OFF";
      el("load-progress").style.width = "100%";
      el("loading-note").textContent = "Aircraft ready. The sky is yours.";
      createTimeline({
        defaults: { duration: reducedMotion ? 1 : 900, ease: "outExpo" },
      })
        .add(".title-block > *", {
          opacity: [0, 1],
          translateY: [18, 0],
          delay: (_, i) => (i ?? 0) * 80,
        })
        .add(".mode-list, .conditions", { opacity: [0, 1], translateY: [12, 0] }, 300);
      if (this.settings.weather === "storm" && this.state === "menu") this.approachStorm();
      this.loadAdversaries();
    } catch (error) {
      this.fatal(
        `The aircraft could not be loaded. Check the connection and try again. ${error instanceof Error ? error.message : ""}`,
      );
    }
  }
  private setState(state: State) {
    this.state = state;
    document.body.dataset.state = state;
    this.comms.hold(state === "paused");
    el("pause").hidden = state !== "paused";
    el("crash").hidden = state !== "crashed";
    el("hud").setAttribute("aria-hidden", String(state === "menu"));
    this.keys.clear();
    this.inputActions.clear();
    this.mouseGun = false;
    this.mouseSteering = false;
    this.accumulator = 0;
    el("top-status").textContent =
      state === "menu"
        ? "HAVEN ARCHIPELAGO"
        : state === "flight"
          ? "FLIGHT IN PROGRESS"
          : state === "paused"
            ? "FLIGHT PAUSED"
            : "FLIGHT ENDED";
  }
  private bindUI() {
    el("target-follow").onclick = () => this.toggleTargetFollow();
    el<HTMLSelectElement>("control-mode").onchange = (event) => {
      this.settings.controlMode = (event.target as HTMLSelectElement).value as
        "assisted" | "advanced";
      this.flight.controlMode = this.settings.controlMode;
      this.targetFollow = false;
      this.mouseSteering = false;
      this.syncSettings();
      this.save();
    };
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointermove", (event) => {
      if (
        this.state !== "flight" ||
        this.settings.controlMode !== "assisted" ||
        this.targetFollow
      )
        return;
      const bounds = canvas.getBoundingClientRect();
      this.mouseAim.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        1 - ((event.clientY - bounds.top) / bounds.height) * 2,
      );
      this.mouseSteering = true;
      this.targetFollow = false;
    });
    canvas.addEventListener("pointerdown", (event) => {
      if (this.state !== "flight") return;
      event.preventDefault();
      if (event.button === 0) {
        this.mouseGun = true;
        this.inputActions.queue("gun");
      } else if (event.button === 2) this.inputActions.queue("missile");
    });
    window.addEventListener("pointerup", () => {
      this.mouseGun = false;
    });
    canvas.addEventListener("pointerleave", () => {
      this.mouseSteering = false;
      this.mouseGun = false;
    });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    document
      .querySelectorAll<HTMLButtonElement>("[data-combat]")
      .forEach((button) => {
        button.onclick = () =>
          this.start(undefined, button.dataset.combat as CombatMission);
      });
    document
      .querySelectorAll<HTMLButtonElement>("[data-challenge]")
      .forEach((button) => {
        button.onclick = () => this.startAscent();
      });
    this.bindPhoto();
    el("hangar-prev").onclick = () => this.selectAircraft(-1);
    el("hangar-next").onclick = () => this.selectAircraft(1);
    document.querySelectorAll<HTMLButtonElement>("#time-chips button").forEach((button) => {
      button.onclick = () => {
        this.settings.hours = Number(button.dataset.time);
        this.sky.time.hours = this.settings.hours;
        this.syncConditions();
        this.save();
      };
    });
    document.querySelectorAll<HTMLButtonElement>("#weather-chips button").forEach((button) => {
      button.onclick = () => {
        this.settings.weather = button.dataset.weather as WeatherName;
        this.sky.setWeather(this.settings.weather);
        if (this.settings.weather === "storm" && this.state === "menu") this.approachStorm();
        this.syncConditions();
        this.save();
      };
    });
    for (const action of Object.keys(defaultBindings) as CombatAction[]) {
      el<HTMLSelectElement>(`bind-${action}`).onchange = (event) => {
        const code = (event.target as HTMLSelectElement).value;
        const duplicate = (Object.keys(defaultBindings) as CombatAction[]).find(
          (other) =>
            other !== action && this.inputActions.bindings[other] === code,
        );
        if (duplicate)
          this.inputActions.bindings[duplicate] =
            this.inputActions.bindings[action];
        this.inputActions.bindings[action] = code;
        this.syncSettings();
        this.save();
      };
    }
    el<HTMLInputElement>("shake-setting").onchange = (event) => {
      this.settings.shake = (event.target as HTMLInputElement).checked;
      this.save();
    };
    el<HTMLInputElement>("hud-scale").oninput = (event) => {
      this.settings.hudScale = Number((event.target as HTMLInputElement).value);
      this.syncSettings();
      this.save();
    };
    el("start").onclick = () => this.start();
    const titleGesture = () => this.state === "menu" && this.playTheme();
    window.addEventListener("pointerdown", titleGesture);
    window.addEventListener("keydown", titleGesture);
    el("resume").onclick = () => this.resume();
    el("restart").onclick = () => this.restart();
    el("retry").onclick = () => this.restart();
    el("pause-button").onclick = () => this.pause();
    el("return-menu").onclick = () => this.menu();
    el("crash-menu").onclick = () => this.menu();
    document.querySelector(".brand")!.addEventListener("click", (e) => {
      e.preventDefault();
      if (this.state === "flight") this.pause();
    });
    document.querySelectorAll<HTMLButtonElement>("[data-route]").forEach(
      (button) =>
        (button.onclick = () => {
          if (this.loaded) this.start(button.dataset.route as RouteId);
        }),
    );
    el("controls-button").onclick = () =>
      el<HTMLDialogElement>("controls").showModal();
    el("settings-button").onclick = () => {
      if (this.state === "flight") this.pause();
      el<HTMLDialogElement>("settings").showModal();
    };
    el("sound").onclick = () => {
      this.audio.enabled = !this.audio.enabled;
      this.syncSettings();
      this.save();
    };
    el<HTMLSelectElement>("quality").onchange = (e) => {
      this.settings.quality = (e.target as HTMLSelectElement).value;
      this.applyQuality();
      this.save();
    };
    el<HTMLSelectElement>("invert").onchange = (e) => {
      this.settings.invert = (e.target as HTMLSelectElement).value === "invert";
      this.save();
    };
    el<HTMLInputElement>("sensitivity").oninput = (e) => {
      this.settings.sensitivity = Number((e.target as HTMLInputElement).value);
      this.save();
    };
    el<HTMLInputElement>("audio-setting").onchange = (e) => {
      this.audio.enabled = (e.target as HTMLInputElement).checked;
      this.syncSettings();
      this.save();
    };
    el<HTMLInputElement>("comms-setting").onchange = (e) => {
      this.settings.comms = (e.target as HTMLInputElement).checked;
      this.syncSettings();
      this.save();
    };
    el<HTMLInputElement>("dynres-setting").onchange = (e) => {
      this.settings.dynamicResolution = (e.target as HTMLInputElement).checked;
      this.resolution.reset();
      this.applyQuality();
      this.save();
    };
    el<HTMLInputElement>("debug-setting").onchange = (e) => {
      el("debug").hidden = !(e.target as HTMLInputElement).checked;
    };
    window.addEventListener("resize", () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.applyQuality();
    });
    window.addEventListener("keydown", (e) => {
      if (document.querySelector("dialog[open]")) return;
      if (e.code === "KeyP" && !e.repeat && this.loaded) {
        if (this.photo) this.exitPhoto();
        else if (this.state === "flight" || this.state === "menu" || this.state === "paused")
          this.enterPhoto();
        return;
      }
      if (e.code === "Escape") {
        if (this.photo) {
          this.exitPhoto();
          return;
        }
        if (this.state === "flight") this.pause();
        else if (this.state === "paused") this.resume();
        return;
      }
      if (this.state === "crashed" && e.code === "KeyR" && !e.repeat) {
        this.restart();
        return;
      }
      if (this.state !== "flight") return;
      if (
        e.code === "KeyG" &&
        !e.repeat &&
        !Object.values(this.inputActions.bindings).includes(e.code)
      ) {
        e.preventDefault();
        this.toggleTargetFollow();
        return;
      }
      if (Object.values(this.inputActions.bindings).includes(e.code))
        e.preventDefault();
      if (e.code === "KeyB" && !e.repeat) {
        if (this.combat.active) {
          this.combat.stop();
          this.targetFollow = false;
          this.combatView.clear();
          this.toast("Combat patrol ended. Continue exploring.", "FREE FLIGHT");
        } else {
          this.mission.stop();
          this.buildRings();
          this.combat.start("intercept", this.flight, { patrol: true });
          this.resetRadio();
          this.comms.say("intercept", 0.6);
          this.targetFollow = this.settings.controlMode === "assisted";
          this.toast(
            "Acquire the incoming flight, then hold lock and fire.",
            "INTERCEPT PATROL",
          );
        }
        this.updateObjective();
        return;
      }
      const used = [
        "KeyW",
        "KeyS",
        "KeyA",
        "KeyD",
        "KeyQ",
        "KeyE",
        "ShiftLeft",
        "ShiftRight",
        "ControlLeft",
        "ControlRight",
        "Space",
        "KeyC",
        "KeyR",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "KeyZ",
        "KeyI",
      ];
      if (used.includes(e.code)) e.preventDefault();
      if (!e.repeat && e.code === "KeyI") this.inputActions.tap("engines");
      if (e.code === "KeyC" && !e.repeat) {
        this.cameraMode = 1 - this.cameraMode;
        animate(this.cameraBlend, {
          value: this.cameraMode,
          duration: reducedMotion ? 1 : 700,
          ease: "inOutCubic",
        });
        this.toast(this.cameraMode ? "Forward camera" : "Chase camera", "VIEW");
      }
      if (e.code === "KeyR" && !e.repeat) {
        this.restart();
        return;
      }
      this.keys.add(e.code);
      if (!e.repeat)
        for (const action of Object.keys(defaultBindings) as CombatAction[])
          if (this.inputActions.bindings[action] === e.code)
            this.inputActions.queue(action);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      if (this.state === "flight") this.pause();
      this.keys.clear();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.state === "flight") this.pause();
      this.last = 0;
    });
    window.addEventListener("beforeunload", () => this.save());
    this.syncSettings();
    this.applyQuality();
  }
  private start(route?: RouteId, combatMission?: CombatMission) {
    if (!this.loaded) return;
    this.ascent.active = false;
    this.hud.reset();
    this.supersonic.clear();
    this.mission.stop();
    this.combat.stop();
    this.combatView.clear();
    this.world.airbase.reset();
    this.world.crowds.reset();
    this.effects.clear();
    this.telemetry.reset();
    this.missileEmitters.clear();
    this.damageEmitters.clear();
    this.lastLock = false;
    this.shakeAmount = 0;
    this.comms.clear();
    // Every sortie starts parked on Haven's runway, engines at idle.
    if (route) this.mission.start(route);
    this.flight.resetOnRunway(HAVEN.runway);
    this.groundCamera = 1;
    this.pathCamera = 0;
    this.intro = INTRO_SECONDS;
    this.liftedOffAt = -1;
    if (combatMission) this.combat.start(combatMission, this.flight);
    this.cameraReady = false;
    this.setState("flight");
    this.targetFollow =
      !!combatMission && this.settings.controlMode === "assisted";
    this.audio
      .start()
      .then(() => this.comms.preload())
      .catch(() => {
        this.audio.enabled = false;
        this.syncSettings();
      });
    this.resetRadio();
    this.liftoffCall = combatMission ?? (route ? "routeStart" : "takeoff");
    this.comms.say("cleared", INTRO_SECONDS - 1);
    this.buildRings();
    this.updateObjective();
    this.toast(
      combatMission
        ? `Target follow is ${this.targetFollow ? "ON" : "OFF"}. Left click / ${this.inputActions.bindings.gun.slice(3)} cannon · right click / ${this.inputActions.bindings.missile.slice(3)} missile. G toggles follow; WASD takes manual control.`
        : route
          ? `${routes[route].description} The clock starts at wheels-up.`
          : "Throttle up with Shift, rotate with W at the ROTATE cue. Space lights the afterburner.",
      combatMission
        ? `${combatMission.toUpperCase()} SORTIE`
        : route
          ? "CHALLENGE STARTED"
          : "FREE FLIGHT",
    );
  }
  private restart() {
    if (this.ascent.active) {
      this.startAscent();
      return;
    }
    const route = this.mission.active;
    const combatMission = this.combat.active;
    this.start(route ?? undefined, combatMission ?? undefined);
  }
  /** Ascent: from brake release on Haven's runway to the edge of space. */
  private startAscent() {
    if (!this.loaded) return;
    this.start();
    Object.assign(this.ascent, { active: true, done: false, time: 0 });
    this.resetRadio();
    this.comms.clear();
    this.comms.say("ascent", 1.2);
    this.updateObjective();
    this.toast(
      "Afterburner (Space) and climb. Thin air at altitude means more speed and softer controls.",
      "ASCENT · REACH 30 000 M",
    );
  }
  /** Title-screen showcase: a lazy S-curve between cumulus tops, sun off the front-left. */
  private showcase(dt: number) {
    this.showcaseTime += dt;
    const t = this.showcaseTime;
    const speed = 205;
    const sun = this.sky.time.sun;
    const sunHeading = Math.atan2(-sun.x, -sun.z);
    // By day the sun sits behind the camera's right shoulder and rakes across
    // the jet and the cumulus; in twilight the camera turns into the afterglow.
    const angle = T.MathUtils.lerp(-1.13, 1.1, T.MathUtils.smoothstep(sun.y, -0.02, 0.1));
    const yaw = sunHeading + angle + Math.sin(t * 0.045) * 0.3;
    const turnRate = Math.cos(t * 0.045) * 0.3 * 0.045;
    const f = this.flight;
    if (!this.showcaseStarted) {
      f.position.set(-2000, 2450, 3000);
      this.showcaseStarted = true;
    }
    const dx = -Math.sin(yaw),
      dz = -Math.cos(yaw);
    f.position.x += dx * speed * dt;
    f.position.z += dz * speed * dt;
    // Under a storm the showcase drops beneath the cloud base, among the rain shafts.
    const cruise = this.sky.weather === "storm" ? 800 : 2450;
    const clearance = Math.max(0, heightAt(f.position.x, f.position.z)) + 320;
    this.showcaseAltitude = T.MathUtils.damp(
      this.showcaseAltitude || cruise,
      Math.max(cruise, clearance),
      0.6,
      dt,
    );
    f.position.y = this.showcaseAltitude + Math.sin(t * 0.11) * (cruise < 1000 ? 60 : 160);
    f.previous.copy(f.position);
    // Coordinated bank for the current turn rate (positive yaw rate turns left).
    const bank = Math.atan((speed * turnRate) / 9.81) * 2.5;
    this.showcaseEuler.set(Math.sin(t * 0.11) * 0.03, yaw, bank, "YXZ");
    f.quaternion.setFromEuler(this.showcaseEuler);
    f.previousQuaternion.copy(f.quaternion);
    f.velocity.set(dx * speed, 0, dz * speed);
    f.speed = speed;
    f.yaw = yaw;
    f.roll = bank;
    f.pitch = this.showcaseEuler.x;
  }
  private showcaseStarted = false;
  /**
   * Title screen in a storm: move the showcase to just short of the nearest
   * cumulonimbus core so the jet flies in beneath it, and let it discharge soon.
   */
  private approachStorm() {
    const f = this.flight;
    const clouds = this.sky.clouds;
    const heading = Math.atan2(f.velocity.x, f.velocity.z);
    const dx = Math.sin(heading),
      dz = Math.cos(heading);
    // The approach must stay low over the sea or low islands: the showcase
    // flies beneath the 1.25 km cloud base.
    const lowRun = (x: number, z: number) => {
      for (let d = -4000; d <= 9000; d += 1000)
        if (heightAt(x + dx * d, z + dz * d) > 450) return false;
      return true;
    };
    let best: { x: number; z: number } | undefined;
    for (let r = 2000; r <= 70000 && !best; r += 2000)
      for (let k = 0, n = Math.ceil((2 * Math.PI * r) / 2000); k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const x = f.position.x + Math.cos(a) * r,
          z = f.position.z + Math.sin(a) * r;
        if (clouds.weatherAt(x, z).type > 0.75 && lowRun(x, z)) {
          best = { x, z };
          break;
        }
      }
    if (!best) return;
    f.position.x = best.x - dx * 3500;
    f.position.z = best.z - dz * 3500;
    f.position.y = Math.max(800, heightAt(f.position.x, f.position.z) + 320);
    f.previous.copy(f.position);
    this.showcaseStarted = true;
    this.showcaseAltitude = f.position.y;
    this.sky.clouds.invalidate();
    this.sky.lightning.soon(1.5);
    this.cameraReady = false;
  }
  private showcaseAltitude = 0;
  private groundCamera = 0;
  private pathCamera = 0;
  private intro = 0;
  /** Game time of this sortie's liftoff (-1 before it). */
  private liftedOffAt = -1;
  private coachShown = "";
  private pathEuler = new T.Euler();
  private cameraRotation = new T.Quaternion();
  private showcaseEuler = new T.Euler();
  private menuYaw = new T.Quaternion();
  private menuAxis = new T.Vector3(0, 1, 0);
  private formatTime(seconds: number) {
    const m = Math.floor(seconds / 60),
      sec = seconds - m * 60;
    return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
  }
  private syncConditions() {
    el("ascent-best").textContent = this.ascent.best ? this.formatTime(this.ascent.best) : "NEW";
    document.querySelectorAll<HTMLButtonElement>("#time-chips button").forEach((b) => {
      b.setAttribute("aria-pressed", String(Math.abs(Number(b.dataset.time) - this.settings.hours) < 0.01));
    });
    document.querySelectorAll<HTMLButtonElement>("#weather-chips button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.weather === this.settings.weather));
    });
  }
  // Photo mode: the simulation holds still while the camera orbits the jet.
  private photo = false;
  private photoReturn: "menu" | "flight" = "flight";
  private photoOrbit = { yaw: 0, pitch: 0.12, distance: 38 };
  private photoFov = 50;
  private photoSaved = { hours: 0, weather: "fair" as WeatherName };
  private captureNext = false;
  private enterPhoto() {
    if (this.photo || !this.loaded) return;
    this.photoReturn = this.state === "menu" ? "menu" : "flight";
    const rel = this.camera.position.clone().sub(this.local);
    const distance = Math.max(1, rel.length());
    this.photoOrbit.distance = T.MathUtils.clamp(distance, 10, 400);
    this.photoOrbit.yaw = Math.atan2(rel.x, rel.z);
    this.photoOrbit.pitch = Math.asin(T.MathUtils.clamp(rel.y / distance, -0.9, 0.9));
    this.photoFov = this.camera.fov;
    this.photoSaved = { hours: this.sky.time.hours, weather: this.sky.weather };
    this.photo = true;
    this.setState("paused");
    el("pause").hidden = true;
    el("photo").hidden = false;
    document.body.dataset.photo = "true";
    this.sky.clouds.converge = 2;
    // Captures are taken at full resolution.
    this.resolution.reset();
    this.applyQuality();
    this.syncPhoto();
  }
  private exitPhoto() {
    if (!this.photo) return;
    this.photo = false;
    el("photo").hidden = true;
    delete document.body.dataset.photo;
    this.sky.exposureBias = 0;
    this.sky.clouds.converge = 1;
    this.sky.lightning.clear();
    this.sky.time.hours = this.photoSaved.hours;
    if (this.sky.weather !== this.photoSaved.weather) this.sky.setWeather(this.photoSaved.weather);
    this.plane.visible = true;
    this.cameraReady = false;
    if (this.photoReturn === "menu") this.setState("menu");
    else this.setState("paused");
  }
  private syncPhoto() {
    const hours = this.sky.time.hours;
    el<HTMLInputElement>("photo-time").value = String(hours);
    el("photo-time-out").textContent = `${String(Math.floor(hours)).padStart(2, "0")}:${String(Math.floor((hours % 1) * 60)).padStart(2, "0")}`;
    el<HTMLInputElement>("photo-exposure").value = String(this.sky.exposureBias);
    el("photo-exposure-out").textContent = `${this.sky.exposureBias >= 0 ? "+" : ""}${this.sky.exposureBias.toFixed(1)} EV`;
    el<HTMLInputElement>("photo-fov").value = String(Math.round(this.photoFov));
    // Full-frame equivalent focal length for the vertical field of view.
    el("photo-fov-out").textContent = `${Math.round(12 / Math.tan(T.MathUtils.degToRad(this.photoFov) / 2))} mm`;
    document.querySelectorAll<HTMLButtonElement>("#photo-weather button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.photoWeather === this.sky.weather));
    });
    el("photo-aircraft").setAttribute("aria-pressed", String(this.plane.visible));
  }
  /** Freezes a strike in front of the camera, a few kilometres out. */
  private photoLightning() {
    const direction = this.camera.getWorldDirection(new T.Vector3());
    const side = Math.random() < 0.5 ? -1 : 1;
    const distance = 5000 + Math.random() * 4000;
    const lateral = side * (800 + Math.random() * 2200);
    const x = this.cameraGlobal.x + direction.x * distance - direction.z * lateral,
      z = this.cameraGlobal.z + direction.z * distance + direction.x * lateral;
    this.sky.lightning.clear();
    this.sky.lightning.strike(x, z, this.cameraGlobal);
  }
  private bindPhoto() {
    el("photo-button").onclick = () => this.enterPhoto();
    el("photo-exit").onclick = () => this.exitPhoto();
    el("photo-capture").onclick = () => {
      this.captureNext = true;
      const panel = el("photo");
      panel.classList.remove("flash");
      void panel.offsetWidth;
      panel.classList.add("flash");
    };
    el("photo-lightning").onclick = () => this.photoLightning();
    el("photo-aircraft").onclick = () => {
      this.plane.visible = !this.plane.visible;
      this.syncPhoto();
    };
    el<HTMLInputElement>("photo-time").oninput = (e) => {
      this.sky.time.hours = Number((e.target as HTMLInputElement).value);
      this.syncPhoto();
    };
    el<HTMLInputElement>("photo-exposure").oninput = (e) => {
      this.sky.exposureBias = Number((e.target as HTMLInputElement).value);
      this.syncPhoto();
    };
    el<HTMLInputElement>("photo-fov").oninput = (e) => {
      this.photoFov = Number((e.target as HTMLInputElement).value);
      this.syncPhoto();
    };
    document.querySelectorAll<HTMLButtonElement>("#photo-weather button").forEach((button) => {
      button.onclick = () => {
        this.sky.setWeather(button.dataset.photoWeather as WeatherName);
        this.syncPhoto();
      };
    });
    const canvas = this.renderer.domElement;
    let dragging: { x: number; y: number } | undefined;
    canvas.addEventListener("pointerdown", (e) => {
      if (!this.photo) return;
      dragging = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.photo || !dragging) return;
      const o = this.photoOrbit;
      o.yaw -= (e.clientX - dragging.x) * 0.006;
      o.pitch = T.MathUtils.clamp(o.pitch + (e.clientY - dragging.y) * 0.005, -1.4, 1.4);
      dragging = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener("pointerup", () => (dragging = undefined));
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.photo) return;
        e.preventDefault();
        const o = this.photoOrbit;
        o.distance = T.MathUtils.clamp(o.distance * Math.exp(e.deltaY * 0.0012), 8, 2500);
      },
      { passive: false },
    );
  }
  /** Which key to press right now, for players who have not read the controls. */
  private coach(): [string, string] {
    const f = this.flight;
    if (this.state !== "flight") return ["", ""];
    if (this.intro > 0) return ["ENTER", "skip the opening shot"];
    if (this.combat.active && (this.combat.status.threat || this.combat.warning.samLaunch))
      return [this.inputActions.bindings.flare.slice(3), "release flares, then turn hard"];
    if (this.radio.spiked) return ["GO LOW", "stay under 100 m in the valleys to break the radar lock"];
    if (this.combat.active === "war" && this.liftedOffAt >= 0 && !f.onGround) {
      const phase = this.combat.warPhase;
      if (phase === 1)
        return ["STAY LOW", `fly through ingress marker ${this.combat.waypoint + 1} of 3 under 450 m`];
      if (phase === 2 && this.combat.status.bombs > 0)
        return [this.inputActions.bindings.bomb.slice(3), "release a bomb when the BOMB circle sits on the target"];
    }
    if (f.onGround) {
      if (this.liftedOffAt < 0) {
        if (f.speed >= f.rotateSpeed) return ["W", "pull back to take off"];
        if (f.speed > 3) return ["SPACE", "afterburner for a shorter roll · keep holding SHIFT"];
        return ["HOLD SHIFT", "throttle up to start the takeoff roll"];
      }
      return f.speed > 1 ? ["HOLD Z", "wheel brakes"] : ["", ""];
    }
    if (this.time - this.liftedOffAt < 8) return ["W S · A D", "climb, dive and turn"];
    const home = Math.hypot(f.position.x - HAVEN.runway.x, f.position.z - HAVEN.runway.z);
    const agl = f.position.y - Math.max(0, heightAt(f.position.x, f.position.z));
    if (this.time - this.liftedOffAt > 20 && home < 3500 && agl < 250 && f.speed < 150)
      return ["IDLE", "nose a couple of degrees down; touch down gently, wings level"];
    return ["", ""];
  }
  private updateCoach() {
    const [key, text] = this.coach();
    const shown = key + text;
    if (shown === this.coachShown) return;
    this.coachShown = shown;
    el("coach-key").textContent = key;
    el("coach-text").textContent = text;
    el("coach").classList.toggle("on", !!text);
  }
  /** Browsers only start audio from a gesture, so the theme starts on the first click or key. */
  private playTheme() {
    if (this.audio.enabled && this.theme.paused) this.theme.play().catch(() => {});
  }
  private resume() {
    this.last = 0;
    this.setState("flight");
    this.audio.start().catch(() => {});
  }
  private pause() {
    this.setState("paused");
    this.save();
  }
  private menu() {
    this.save();
    this.playTheme();
    this.intro = 0;
    document.body.removeAttribute("data-intro");
    this.comms.clear();
    this.mission.stop();
    this.combat.stop();
    this.combatView.clear();
    this.effects.clear();
    this.ascent.active = false;
    this.supersonic.clear();
    this.cameraReady = false;
    this.setState("menu");
    this.buildRings();
    this.updateDiscovery();
    this.syncConditions();
  }
  private input() {
    // The jet waits on the runway while the opening shot plays.
    if (this.intro > 0) return { ...neutral };
    const controls = this.inputActions.sample(
      this.keys,
      this.settings.invert,
      this.settings.sensitivity,
      navigator.getGamepads ? Array.from(navigator.getGamepads()) : [],
    );
    if (this.settings.controlMode === "assisted") {
      const manual =
        Math.abs(controls.pitch) +
          Math.abs(controls.roll) +
          Math.abs(controls.yaw) >
        0.1;
      if (manual) {
        this.targetFollow = false;
        this.mouseSteering = false;
      } else if (
        this.targetFollow &&
        this.combat.active &&
        !this.combat.completed &&
        !this.combat.failed
      ) {
        const direction = this.combat.getAimDirection(
          this.flight,
          this.steeringDirection,
          { blocked: (a, b) => this.combatBlocked(a, b) },
        );
        if (direction) {
          controls.aimDirection = direction;
          const target = this.combat.target;
          if (target?.kind === "air" && !controls.throttle && !controls.boost) {
            const range = target.position.distanceTo(this.flight.position);
            const speed = T.MathUtils.clamp(
              target.velocity.length() +
                T.MathUtils.clamp((range - 600) * 0.035, -8, 38),
              100,
              190,
            );
            controls.throttleTarget = T.MathUtils.clamp(
              (0.00125 * speed * speed - 9) / 33,
              0.18,
              0.9,
            );
          }
        }
      } else if (this.mouseSteering && this.mouseAim.length() > 0.08) {
        // A bounded camera ray makes the aircraft steer toward the visible cursor.
        this.steeringDirection
          .set(
            this.mouseAim.x * this.settings.sensitivity,
            this.mouseAim.y *
              (this.settings.invert ? -1 : 1) *
              this.settings.sensitivity,
            0.5,
          )
          .unproject(this.camera)
          .sub(this.camera.position)
          .normalize();
        controls.aimDirection = this.steeringDirection;
      }
    }
    return controls;
  }
  private toggleTargetFollow() {
    if (!this.combat.active || this.settings.controlMode !== "assisted") return;
    this.targetFollow = !this.targetFollow;
    this.mouseSteering = false;
    this.toast(
      this.targetFollow
        ? "Following the selected target. Fire when ready; WASD returns manual control."
        : "Manual steering. A/D turns; release the keys to level out.",
      "FLIGHT ASSIST",
    );
  }
  private frame(timestamp: number) {
    const frameMs = this.last ? timestamp - this.last : 1000 / 60;
    const dt = this.last
      ? Math.min((timestamp - this.last) / 1000, 0.1)
      : 1 / 60;
    this.last = timestamp;
    this.time += dt;
    if (this.state === "flight") this.telemetry.record(frameMs, this.time);
    // Hold the frame rate in flight and on the title screen by trading resolution.
    if (
      this.settings.dynamicResolution &&
      this.loaded &&
      (this.state === "flight" || this.state === "menu") &&
      !document.hidden &&
      this.resolution.update(frameMs, dt)
    )
      this.applyQuality();
    this.fps = T.MathUtils.damp(this.fps, 1 / Math.max(dt, 0.001), 2, dt);
    const music = this.state === "menu" && this.audio.enabled && !this.photo && !document.hidden ? 0.55 : 0;
    this.theme.volume = T.MathUtils.clamp(T.MathUtils.damp(this.theme.volume, music, music ? 0.7 : 2.5, dt), 0, 1);
    if (!music && this.theme.volume < 0.01 && !this.theme.paused) this.theme.pause();
    engine.update();
    if (this.state === "flight") {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= 1 / 60 && steps++ < 6) {
        this.physics?.update(this.flight.position, this.world.origin, 1 / 60);
        this.flight.step(1 / 60, this.input());
        if (this.liftoffCall && !this.flight.onGround) {
          this.comms.say(this.liftoffCall, 1.5);
          this.liftoffCall = null;
          this.liftedOffAt = this.time;
        }
        // Wheels on (or just above) a runway: Flight judges contact with the pavement.
        if (
          !this.flight.onGround &&
          !overRunway(this.flight.position) &&
          this.physics?.sweep(
            this.flight.previous,
            this.flight.position,
            this.flight.quaternion,
          )
        )
          this.flight.crashed = true;
        this.combat.step(
          1 / 60,
          this.flight,
          {
            gun: this.inputActions.active("gun") || this.mouseGun,
            missile: this.inputActions.active("missile"),
            target: this.inputActions.active("target"),
            flare: this.inputActions.active("flare"),
            bomb: this.inputActions.active("bomb"),
          },
          {
            groundHeight: (x, z) => Math.max(0, renderedHeightAt(x, z)),
            blocked: (from, to) => this.combatBlocked(from, to),
          },
        );
        this.processCombatEvents();
        const missileIds = new Set<string>();
        for (const missile of this.combat.missiles)
          if (missile.active) {
            const id = `missile-${missile.id}`;
            missileIds.add(id);
            this.effects.updateMissile(id, missile.position, 1 / 60);
          }
        for (const id of this.missileEmitters)
          if (!missileIds.has(id)) this.effects.stopEmitter(id);
        this.missileEmitters = missileIds;
        const damageIds = new Set<string>();
        for (const enemy of this.combat.enemies)
          if (
            enemy.active &&
            enemy.health > 0 &&
            enemy.health < enemy.maxHealth * 0.55
          ) {
            const id = `enemy-${enemy.id}`;
            damageIds.add(id);
            this.effects.emitDamageSmoke(
              id,
              enemy.position,
              1 / 60,
              1 - enemy.health / enemy.maxHealth,
            );
          }
        if (this.combat.playerHealth < 55 && this.combat.active) {
          damageIds.add("player");
          this.effects.emitDamageSmoke(
            "player",
            this.flight.position,
            1 / 60,
            1 - this.combat.playerHealth / 100,
          );
        }
        for (const id of this.damageEmitters)
          if (!damageIds.has(id)) this.effects.stopEmitter(id);
        this.damageEmitters = damageIds;
        if (this.combat.playerHealth <= 0 && this.combat.active)
          this.flight.crashed = true;
        this.accumulator -= 1 / 60;
        // Route clocks start at wheels-up.
        const message = this.flight.onGround
          ? null
          : this.mission.update(1 / 60, this.flight.previous, this.flight.position);
        if (message) {
          this.toast(
            message,
            this.mission.completed ? "CHALLENGE COMPLETE" : "FLIGHT LOG",
          );
          if (this.mission.completed) this.comms.say("routeDone", 0.8);
          this.buildRings();
          this.save();
        }
        if (this.flight.crashed) {
          // A terrain impact throws dirt and burns; losing the jet to missiles is an air burst.
          this.effects.emitExplosion(
            this.flight.position,
            1.8,
            this.combat.playerHealth <= 0 ? "air" : "ground",
          );
          this.audio.cue("explosion", 0, 1.8);
          this.comms.clear();
          this.comms.say("crash", 1.6);
          el("crash-message").textContent =
            this.combat.playerHealth <= 0
              ? "Aircraft lost in combat. Restart the sortie and try a different approach."
              : this.flight.onGround || overRunway(this.flight.position)
                ? "Runway excursion or hard landing. Keep it on the centreline: under 5 m/s sink, wings level."
                : "Terrain impact. Clear skies are just one takeoff away.";
          this.setState("crashed");
          break;
        }
      }
      this.saveTime += dt;
      if (this.saveTime > 8) {
        this.saveTime = 0;
        this.save();
      }
      for (const landmark of landmarks)
        if (
          !this.mission.discovered.has(landmark.id) &&
          Math.hypot(
            this.flight.position.x - landmark.x,
            this.flight.position.z - landmark.z,
          ) < 650
        ) {
          this.mission.discovered.add(landmark.id);
          this.toast(
            `${landmark.name} · ${landmark.detail}`,
            "LANDMARK DISCOVERED",
          );
          this.comms.say("landmark", 0.6);
          this.save();
        }
    }
    if (this.state === "flight") this.radioCalls();
    if (this.state === "menu") this.showcase(dt);
    if (this.state === "flight" && this.ascent.active && !this.ascent.done) {
      // The clock starts at brake release.
      if (!this.flight.onGround || this.flight.speed > 0) this.ascent.time += dt;
      if (this.flight.position.y >= 30000) {
        this.ascent.done = true;
        const best = this.ascent.best;
        if (!best || this.ascent.time < best) this.ascent.best = this.ascent.time;
        this.toast(
          `Edge of space in ${this.formatTime(this.ascent.time)}${best && this.ascent.time >= best ? ` · best ${this.formatTime(best)}` : " · new record"}`,
          "ASCENT COMPLETE",
        );
        this.save();
      }
    }
    this.sky.update(this.state === "flight" || this.state === "menu" ? dt : 0);
    this.world.lightDirection.copy(this.sky.lightDirection);
    const oldOrigin = this.world.origin.clone();
    this.world.update(
      this.flight.position,
      this.state === "flight" || this.state === "menu" ? dt : 0,
      this.flight.velocity,
    );
    if (!oldOrigin.equals(this.world.origin)) {
      this.camera.position.add(oldOrigin.sub(this.world.origin));
    }
    const alpha = this.state === "flight" ? this.accumulator / (1 / 60) : 1;
    this.local
      .lerpVectors(this.flight.previous, this.flight.position, alpha)
      .sub(this.world.origin);
    this.rotation.slerpQuaternions(
      this.flight.previousQuaternion,
      this.flight.quaternion,
      alpha,
    );
    this.plane.position.copy(this.local);
    this.plane.quaternion.copy(this.rotation);
    this.combatView.update(this.combat, this.world.origin);
    this.updateCamera(dt);
    this.camera.updateMatrixWorld();
    this.effects.setLighting(
      this.sky.lightDirection,
      this.world.sun.color,
      this.world.sun.intensity,
    );
    this.effects.update(
      this.state === "flight" ? dt : 0,
      this.camera,
      this.world.origin,
    );
    this.updateRings();
    // Rain on the canopy beneath a storm cell's base.
    const cell = this.sky.clouds.weatherAt(this.flight.position.x, this.flight.position.z);
    const rain =
      T.MathUtils.smoothstep(cell.type, 0.5, 0.85) *
      (1 - T.MathUtils.smoothstep(this.flight.position.y, 1100, 1500)) *
      this.sky.clouds.weatherState.storm;
    this.audio.update(
      this.flight.speed,
      this.state === "menu" ? this.flight.throttle : this.engineOutput(),
      this.state === "flight",
      this.flight.boost,
      this.flight.mach,
      rain,
    );
    this.hudTime += dt;
    this.mapTime += dt;
    if (this.hudTime > 0.08) {
      this.hudTime = 0;
      this.updateHUD();
    }
    if (this.mapTime > 0.2) {
      this.mapTime = 0;
      this.drawMap();
    }
    this.updateSpectacle(dt);
    const drawing = this.renderer.getDrawingBufferSize(this.drawingSize);
    this.effects.setSoftDepth(
      this.sky.depthTexture,
      this.camera,
      drawing.x,
      drawing.y,
    );
    this.cameraGlobal.copy(this.camera.position).add(this.world.origin);
    this.world.updateTerrain(this.renderer, this.cameraGlobal);
    // Strikes and thunder only run while the world does; photo mode freezes them.
    this.sky.lightning.timeScale =
      !this.photo && (this.state === "flight" || this.state === "menu") ? 1 : 0;
    this.sky.render(this.scene, this.camera, this.cameraGlobal, dt);
    if (this.captureNext) {
      // Read the drawing buffer in the same task as the render, before it is presented.
      this.captureNext = false;
      this.renderer.domElement.toBlob((blob) => {
        if (!blob) return;
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `stratos-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      }, "image/png");
    }
    this.drawHud();
    if (!el("debug").hidden)
      el("debug").textContent =
        `${this.fps.toFixed(0)} FPS\nFRAME median ${this.telemetry.median.toFixed(1)} / p95 ${this.telemetry.p95.toFixed(1)} ms\nRENDER SCALE ${(this.settings.dynamicResolution ? this.resolution.scale : 1).toFixed(2)}\n${this.renderer.info.render.calls} draw calls\n${this.renderer.info.render.triangles.toLocaleString()} triangles\n${this.world.stats.patches} terrain patches / ${this.world.stats.chunks} scenery chunks\n${this.effects.stats.smoke} smoke / ${this.effects.stats.flame} flame\n${this.physics?.status.colliders ?? 0} Rapier colliders\n${this.renderer.info.memory.geometries} geometries / ${this.renderer.info.memory.textures} textures\nORIGIN ${this.world.origin.x}, ${this.world.origin.z}`;
  }
  /** Mean engine spool: the engine note follows the engines, not the throttle lever. */
  private engineOutput() {
    let sum = 0;
    for (const e of this.flight.engines) sum += e.output;
    return sum / this.flight.engines.length;
  }
  /** Vapour, plume, contrails and the camera-side speed effects. */
  private updateSpectacle(dt: number) {
    const flying = this.state === "flight";
    const sun = this.sky.time.sun;
    this.sunTint.copy(this.sky.sunColor).multiplyScalar(SUN_ILLUMINANCE);
    const day = T.MathUtils.smoothstep(sun.y, -0.08, 0.2);
    this.ambientTint
      .setRGB(0.32, 0.4, 0.55)
      .multiplyScalar(SUN_ILLUMINANCE * (0.012 + 0.11 * day));
    this.supersonic.setLighting(sun, this.sunTint, this.ambientTint);
    this.planeGlobal.copy(this.plane.position).add(this.world.origin);
    this.supersonic.update(
      this.state === "paused" ? 0 : dt,
      {
        position: this.planeGlobal,
        quaternion: this.plane.quaternion,
        mach: flying ? this.flight.mach : 0,
        gLoad: flying ? this.flight.gLoad : 1,
        boost: this.flight.boost && (flying || this.photo),
        throttle: this.flight.throttle,
        altitude: this.flight.position.y,
        active: this.state === "flight" || this.state === "menu" || this.photo,
        // The title showcase flies on its own; only a real sortie shows engine state.
        engines: this.state === "menu" ? undefined : this.flight.engines,
        afterburners: this.state === "menu" ? undefined : this.flight.afterburners,
      },
      this.world.origin,
    );
    // Smoke and fire trail from each failed engine's nozzle.
    if (flying)
      for (let i = 0; i < this.flight.engines.length; i++) {
        const fire = this.flight.engineFire(i);
        if (fire > 0)
          this.effects.emitEngineFire(
            this.supersonic.enginePosition(i, this.planeGlobal, this.plane.quaternion, this.nozzleWorld),
            this.flight.velocity,
            fire,
            dt,
          );
      }
    this.shock = Math.max(0, this.shock - dt / 1.3);
    const effects = this.sky.effects;
    effects.shock = this.settings.shake ? this.shock : 0;
    // Speed sensation: radial blur near the ground at high Mach, fading with altitude.
    const nearGround = 1 - T.MathUtils.smoothstep(this.flight.position.y, 2500, 14000);
    effects.speedBlur = flying
      ? T.MathUtils.smoothstep(this.flight.mach, 0.55, 1.4) * (0.25 + 0.75 * nearGround) * 0.7
      : 0;
  }
  private updateCamera(dt: number) {
    if (this.photo) {
      const o = this.photoOrbit;
      this.offset
        .set(Math.sin(o.yaw) * Math.cos(o.pitch), Math.sin(o.pitch), Math.cos(o.yaw) * Math.cos(o.pitch))
        .multiplyScalar(o.distance)
        .add(this.local);
      const origin = this.world.origin;
      const ground = Math.max(0, heightAt(this.offset.x + origin.x, this.offset.z + origin.z)) - origin.y + 4;
      this.offset.y = Math.max(this.offset.y, ground);
      this.camera.position.copy(this.offset);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.local);
      this.camera.fov = this.photoFov;
      this.updateClipPlanes();
      this.camera.updateProjectionMatrix();
      return;
    }
    if (this.state === "menu") {
      // Slow cinematic orbit in the jet's heading frame; the jet sits right of
      // centre so the title has the left of the frame.
      const t = this.showcaseTime;
      this.menuYaw.setFromAxisAngle(this.menuAxis, this.flight.yaw);
      this.offset
        .set(30 + Math.sin(t * 0.07) * 9, 4 + Math.sin(t * 0.045) * 4, 26 + Math.cos(t * 0.055) * 10)
        .applyQuaternion(this.menuYaw)
        .add(this.local);
      this.look.set(-12, 2, -10).applyQuaternion(this.menuYaw).add(this.local);
      this.camera.position.copy(this.offset);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.look);
      this.camera.fov = 44;
    } else {
      const f = this.flight;
      const blend = this.cameraBlend.value;
      // Low chase on the runway, rising smoothly after liftoff.
      this.groundCamera = T.MathUtils.damp(this.groundCamera, f.onGround ? 1 : 0, f.onGround ? 4 : 0.8, dt);
      // Post-stall the chase rides the flight path instead of whipping with the
      // nose, drifting off the wing so the cobra reads in profile.
      this.pathCamera = T.MathUtils.damp(this.pathCamera, f.cobraActive || f.postStall ? 1 : 0, 2.5, dt);
      const ground = this.groundCamera * (1 - blend),
        path = this.pathCamera * (1 - blend);
      if (path > 0.001 && f.velocity.lengthSq() > 1) {
        const v = f.velocity;
        this.pathEuler.set(Math.asin(T.MathUtils.clamp(v.y / v.length(), -1, 1)), Math.atan2(-v.x, -v.z), 0, "YXZ");
        // slerp from the path toward the nose: slerpQuaternions(rotation, this) would alias.
        this.cameraRotation.setFromEuler(this.pathEuler).slerp(this.rotation, 1 - path);
      } else this.cameraRotation.copy(this.rotation);
      this.forward.set(0, 0, -1).applyQuaternion(this.cameraRotation);
      this.offset
        .set(
          path * 11,
          T.MathUtils.lerp(T.MathUtils.lerp(7.5, 2.2, blend), 3.4, ground) - path * 2.5,
          T.MathUtils.lerp(T.MathUtils.lerp(33, -10, blend), 21, ground) + path * 5,
        )
        .applyQuaternion(this.cameraRotation)
        .add(this.local);
      const globalX = this.offset.x + this.world.origin.x,
        globalZ = this.offset.z + this.world.origin.z;
      this.offset.y = Math.max(
        this.offset.y,
        Math.max(0, heightAt(globalX, globalZ)) + T.MathUtils.lerp(12, 1.5, this.groundCamera),
      );
      if (!this.cameraReady) {
        this.camera.position.copy(this.offset);
        this.cameraReady = true;
      } else this.camera.position.lerp(this.offset, 1 - Math.exp(-7 * dt));
      this.look.copy(this.local).addScaledVector(this.forward, 120);
      this.look.y += 2 - ground;
      this.camera.up.set(-Math.sin(this.flight.roll) * 0.13, 1, 0).normalize();
      this.camera.lookAt(this.look);
      this.camera.fov = T.MathUtils.damp(
        this.camera.fov,
        58 + (this.flight.speed - 130) * 0.045 + (this.flight.boost ? 5 : 0),
        3,
        dt,
      );
      if (this.intro > 0 && this.keys.has("Enter")) this.intro = 0;
      if (this.intro > 0) {
        this.intro -= dt;
        let t = INTRO_SECONDS - this.intro,
          shot = INTRO_SHOTS[0];
        for (shot of INTRO_SHOTS) {
          if (t < shot.seconds) break;
          t -= shot.seconds;
        }
        const u = T.MathUtils.smootherstep(Math.min(t / shot.seconds, 1), 0, 1);
        this.camera.position.lerpVectors(shot.from, shot.to, u).sub(this.world.origin);
        if (shot.look) this.look.copy(shot.look).sub(this.world.origin);
        else
          this.look
            .copy(INTRO_CREW)
            .sub(this.world.origin)
            .lerp(this.local, T.MathUtils.smoothstep(u, 0.15, 0.85));
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(this.look);
        this.camera.fov = 45;
      }
      document.body.toggleAttribute("data-intro", this.intro > 0);
    }
    if (
      this.settings.shake &&
      this.state === "flight" &&
      this.shakeAmount > 0.01
    ) {
      this.camera.position.x +=
        Math.sin(this.flight.elapsed * 59) * this.shakeAmount;
      this.camera.position.y +=
        Math.sin(this.flight.elapsed * 73) * this.shakeAmount * 0.6;
      this.shakeAmount = T.MathUtils.damp(this.shakeAmount, 0, 7, dt);
    }
    this.updateClipPlanes();
    this.camera.updateProjectionMatrix();
  }
  /** Far plane reaches the curved horizon plus mountains peeking above it. */
  private updateClipPlanes() {
    const altitude = Math.max(1, this.camera.position.y);
    const horizon = Math.sqrt(2 * 6360000 * altitude) + 140000;
    this.camera.far = T.MathUtils.clamp(horizon * 1.1, 80000, 900000);
  }
  private processCombatEvents() {
    for (const event of this.combat.drainEvents()) {
      if (event.type === "explosion") {
        this.effects.emitExplosion(event.position, event.scale ?? 1, event.kind ?? "air");
        this.audio.cue("explosion");
      } else if (event.type === "samLaunch") {
        if (event.direction) this.effects.emitLaunch(event.position, event.direction);
        this.audio.rwrLaunch();
        this.rwrAudio.launch = this.time;
      } else if (event.type === "gun" || event.type === "missile") {
        if (event.player) this.audio.cue(event.type);
      } else if (event.type === "flare") {
        // Cartridges leave the rear fuselage along the jet's body axes.
        this.flareForward.set(0, 0, -1).applyQuaternion(this.flight.quaternion);
        this.flareUp.set(0, 1, 0).applyQuaternion(this.flight.quaternion);
        this.effects.emitFlares(
          event.position,
          this.flight.velocity,
          this.flareForward,
          this.flareUp,
        );
        this.audio.cue("flare");
      } else if (event.type === "hit") {
        // `player` on a hit marks the player's jet as the one struck.
        if (event.player) {
          this.shakeAmount = this.settings.shake ? 0.8 : 0;
          if (event.weapon === "missile") {
            this.flight.damageEngine();
            this.comms.say("engineFire", 0.3);
            this.shakeAmount = this.settings.shake ? 1.4 : 0;
          }
        } else if (event.entityId !== -1) this.hitUntil = this.time + 0.18;
      } else if (event.type === "complete" || event.type === "failed") {
        this.world.crowds.react(event.type === "complete" ? "success" : "failure");
        if (this.combat.active === "war") this.comms.say(event.type === "complete" ? "warComplete" : "warFailed", 0.8);
        else if (event.type === "complete") this.comms.say("clear", 0.8);
        else if (this.combat.status.result === "Transport lost") this.comms.say("escortLost", 0.8);
        this.toast(
          this.combat.status.result || this.combat.status.objective,
          event.type === "complete" ? "SORTIE COMPLETE" : "SORTIE ENDED",
        );
      }
    }
  }
  private combatBlocked(from: T.Vector3, to: T.Vector3) {
    if (this.physics?.sweep(from, to, undefined, 0.5)) return true;
    // Terrain outside the local Rapier bubble still occludes targeting and projectiles.
    const steps = Math.max(1, Math.ceil(from.distanceTo(to) / 60));
    for (let i = 1; i <= steps; i++) {
      this.queryPoint.lerpVectors(from, to, i / steps);
      if (
        this.queryPoint.y <
        Math.max(0, renderedHeightAt(this.queryPoint.x, this.queryPoint.z))
      )
        return true;
    }
    return false;
  }
  private buildRings() {
    for (const ring of this.rings) {
      this.ringGroup.remove(ring);
      ring.geometry.dispose();
      (ring.material as T.Material).dispose();
    }
    this.rings = [];
    if (!this.mission.active || this.mission.completed) return;
    const route = routes[this.mission.active];
    for (let i = this.mission.index; i < route.points.length; i++) {
      const gate = this.mission.gate(i)!;
      const ring = new T.Mesh(
        new T.TorusGeometry(125, 2.5, 6, 64),
        new T.MeshBasicMaterial({
          color: i === this.mission.index ? "#e1fda2" : "#c3e4d9",
          transparent: true,
          opacity: i === this.mission.index ? 0.9 : 0.25,
        }),
      );
      ring.userData.global = gate;
      ring.layers.set(TRANSPARENT_LAYER);
      const next = this.mission.gate(Math.min(i + 1, route.points.length - 1));
      if (next && !next.equals(gate)) ring.lookAt(next.clone().sub(gate));
      this.rings.push(ring);
      this.ringGroup.add(ring);
    }
  }
  private updateRings() {
    this.rings.forEach((ring, i) => {
      ring.position.copy(ring.userData.global).sub(this.world.origin);
      if (i === 0)
        (ring.material as T.MeshBasicMaterial).opacity =
          0.7 + Math.sin(this.time * 2) * 0.2;
    });
  }
  private updateHUD() {
    const agl =
      this.flight.position.y -
      Math.max(0, heightAt(this.flight.position.x, this.flight.position.z));
    const f = this.flight;
    // Ground proximity stays quiet on the runway and around the airfields.
    const field = f.onGround || overRunway(f.position) || this.nearRunway();
    const terrain = this.state === "flight" && !field && this.terrainAhead();
    if (terrain && this.time - this.radio.terrainCue > 1.1) {
      this.audio.terrainAlarm();
      this.radio.terrainCue = this.time;
    }
    const fire = f.engines.map((e) => e.failed);
    const side =
      fire.length === 2 ? (fire[0] && fire[1] ? " · BOTH" : fire[0] ? " · LEFT" : " · RIGHT") : "";
    this.warningText =
      this.state === "flight"
        ? fire.includes(true)
          ? `ENGINE FIRE${side}`
          : (agl < 100 && !field) || terrain
            ? "TERRAIN · PULL UP"
            : f.onGround
              ? f.speed >= f.rotateSpeed && f.throttle > 0.3
                ? "ROTATE · W"
                : ""
              : f.speed < 85 && !f.cobraActive
                ? "LOW AIRSPEED · INCREASE THRUST"
                : ""
        : "";
    this.updateCombatHUD();
    el("warning").textContent = this.warningText;
    this.updateCoach();
    this.updateObjective();
    el("coordinates").textContent =
      `${(this.flight.position.z / -1000).toFixed(1)} N / ${(this.flight.position.x / 1000).toFixed(1)} E`;
  }
  /** Feeds the conformal canvas HUD every frame while flying. */
  private drawHud() {
    if (this.state === "menu" || this.photo) {
      this.hud.canvas.style.display = "none";
      return;
    }
    this.hud.canvas.style.display = "block";
    const agl =
      this.flight.position.y -
      Math.max(0, heightAt(this.flight.position.x, this.flight.position.z));
    const gate = this.mission.completed ? null : this.mission.gate();
    const status = this.combat.status;
    const enemy = this.combat.active
      ? this.combat.enemies.find((e) => e.id === status.targetId && e.health > 0)
      : undefined;
    // Bomb pipper while bombs remain over the strike area (war phase 3 or a strike sortie).
    let ccip: T.Vector3 | undefined;
    if (
      status.bombs > 0 &&
      !this.flight.onGround &&
      (this.combat.active === "strike" || (this.combat.active === "war" && this.combat.warPhase === 2)) &&
      Math.hypot(this.flight.position.x - BLACKRIDGE.runway.x, this.flight.position.z - BLACKRIDGE.runway.z) < 6000 &&
      this.combat.bombImpact(this.flight, this.hudBomb)
    )
      ccip = this.hudBomb.sub(this.world.origin);
    const marker = this.combat.warMarker;
    let lead: T.Vector3 | undefined;
    if (enemy) {
      const aim = this.combat.getGunAimPoint(this.flight, this.leadPoint, {
        blocked: (a, b) => this.combatBlocked(a, b),
      });
      if (aim) lead = this.hudLead.copy(aim).sub(this.world.origin);
    }
    this.hud.draw({
      camera: this.camera,
      plane: this.local,
      quaternion: this.rotation,
      velocity: this.flight.velocity,
      speed: this.flight.speed,
      mach: this.flight.mach,
      g: this.flight.gLoad,
      altitude: this.flight.position.y,
      agl,
      throttle: this.flight.throttle,
      boost: this.flight.boost,
      systems: {
        engines: this.flight.engines,
        status: this.flight.engineStatus,
        airbrake: this.flight.airbrake,
        onGround: this.flight.onGround,
        aoa: this.flight.aoa,
        postStall: this.flight.postStall,
        hint: this.flight.hintTime > 0 ? this.flight.hint : "",
      },
      time: this.time,
      mode: this.combat.active
        ? `A-A  ${status.missiles} MSL  ${status.gunAmmo} GUN  ${status.flares} FLR`
        : this.ascent.active
          ? `ASCENT  ${this.formatTime(this.ascent.time)}  ${Math.round(Math.min(100, (this.flight.position.y / 30000) * 100))}%`
          : this.mission.active
          ? `NAV  GATE ${Math.min(this.mission.index + 1, routes[this.mission.active].points.length)}/${routes[this.mission.active].points.length}`
          : "NAV",
      warning: this.warningText,
      threat: !!this.combat.active && (status.threat || status.samLaunch),
      rwr: this.combat.active && !this.combat.completed && !this.combat.failed ? this.combat.warning : undefined,
      target: enemy
        ? {
            position: this.hudTarget.copy(enemy.position).sub(this.world.origin),
            name: status.targetName,
            range: status.range,
            lock: status.lock,
            canFire: status.canFire,
            health: status.targetHealth,
          }
        : undefined,
      lead,
      ccip,
      waypoint: gate
        ? {
            position: this.hudGate.copy(gate).sub(this.world.origin),
            label: "WPT",
            distance: gate.distanceTo(this.flight.position),
          }
        : marker
          ? {
              position: this.hudGate.copy(marker).sub(this.world.origin),
              label: `IP ${this.combat.waypoint + 1}`,
              distance: marker.distanceTo(this.flight.position),
            }
          : undefined,
    });
  }
  private updateObjective() {
    const objective = el("objective");
    if (this.ascent.active) {
      objective.querySelector(".eyebrow")!.textContent = this.ascent.done
        ? "ASCENT COMPLETE"
        : "ASCENT CHALLENGE";
      objective.querySelector("strong")!.textContent = this.ascent.done
        ? `Edge of space · ${this.formatTime(this.ascent.time)}`
        : "Climb to 30 000 m.";
      objective.querySelector("p")!.textContent = this.ascent.done
        ? "Look down: the whole archipelago. R to fly it again."
        : `${Math.round(this.flight.position.y).toLocaleString("en-US")} m · Mach ${this.flight.mach.toFixed(2)} · ${this.formatTime(this.ascent.time)}${this.ascent.best ? ` · best ${this.formatTime(this.ascent.best)}` : ""}`;
      return;
    }
    if (this.combat.active) {
      const status = this.combat.status;
      objective.querySelector(".eyebrow")!.textContent = this.combat.completed
        ? "SORTIE COMPLETE"
        : this.combat.failed
          ? "SORTIE FAILED"
          : `${this.combat.active.toUpperCase()} SORTIE`;
      objective.querySelector("strong")!.textContent = status.objective;
      objective.querySelector("p")!.textContent =
        (status.result ? `${status.result} · R retry · B free flight` : "") ||
        `${status.kills} targets destroyed · B leave patrol · R restart`;
    } else if (this.mission.active) {
      const route = routes[this.mission.active];
      objective.querySelector(".eyebrow")!.textContent = this.mission.completed
        ? "CHALLENGE COMPLETE"
        : route.low
          ? "LOW ALTITUDE CHALLENGE"
          : "CHECKPOINT CHALLENGE";
      objective.querySelector("strong")!.textContent = route.name;
      objective.querySelector("p")!.textContent = this.mission.completed
        ? `Finished in ${(this.mission.time + this.mission.penalty).toFixed(1)}s. Keep exploring or press R to retry.`
        : `Gate ${this.mission.index + 1} / ${route.points.length} · ${Math.max(0, route.limit - this.mission.time).toFixed(0)}s remaining${route.low ? ` · +${this.mission.penalty.toFixed(0)}s penalty` : ""}`;
    } else {
      objective.querySelector(".eyebrow")!.textContent = "FREE FLIGHT";
      objective.querySelector("strong")!.textContent = "The horizon is yours.";
      objective.querySelector("p")!.textContent =
        `${this.mission.discovered.size} / 5 landmarks discovered · ${(this.flight.distance / 1000).toFixed(1)} km flown`;
    }
  }
  private updateCombatHUD() {
    const active = !!this.combat.active && this.state !== "menu";
    el("combat-panel").hidden = !active;
    el("hit-confirm").hidden = this.time >= this.hitUntil || !active;
    if (!active) {
      this.audio.rwrTone(false);
      return;
    }
    const status = this.combat.status;
    el("combat-state").textContent = this.combat.completed
      ? "SORTIE COMPLETE"
      : this.combat.failed
        ? "SORTIE FAILED"
        : status.threat
          ? "INCOMING MISSILE"
          : status.samLaunch
            ? "SAM LAUNCH"
            : "COMBAT PATROL";
    el("combat-target").textContent =
      status.targetId === null
        ? "NO TARGET"
        : `${status.targetName} · ${Math.round(status.targetHealth * 100)}%`;
    el("combat-lock").textContent =
      status.targetId === null
        ? "Cycle target to acquire"
        : `${status.lockReason.toUpperCase()} · ${Math.round(status.lock * 100)}% · ${(status.range / 1000).toFixed(1)} KM`;
    el("combat-lock-fill").style.width = `${status.lock * 100}%`;
    el("combat-health").textContent =
      `${Math.max(0, Math.round(status.health))}%`;
    el("combat-gun").textContent = String(status.gunAmmo);
    el("combat-missiles").textContent = String(status.missiles);
    el("combat-flares").textContent = String(status.flares);
    el("combat-ally").hidden = !this.combat.ally;
    if (this.combat.ally)
      el("combat-ally-health").textContent =
        `${Math.round((this.combat.ally.health / this.combat.ally.maxHealth) * 100)}%`;
    const b = this.inputActions.bindings;
    el<HTMLButtonElement>("target-follow").disabled =
      this.settings.controlMode !== "assisted" ||
      this.combat.completed ||
      this.combat.failed;
    el("target-follow").textContent = this.targetFollow
      ? "G · TARGET FOLLOW ON"
      : "G · FOLLOW TARGET";
    el("target-follow").setAttribute("aria-pressed", String(this.targetFollow));
    el("combat-hints").textContent =
      `Left click / ${b.gun.slice(3)} gun · right click / ${b.missile.slice(3)} missile · ${b.target.slice(3)} target · ${b.flare.slice(3)} flare${this.inputActions.connected ? " · GAMEPAD" : ""}`;
    if (this.combat.active === "war" && this.state === "flight") {
      const w = this.warRadio;
      if (!w.waveCalled && this.liftedOffAt >= 0 && this.time - this.liftedOffAt > 9) {
        w.waveCalled = true;
        this.comms.say("warWave");
      }
      if (this.combat.warPhase !== w.phase) {
        w.phase = this.combat.warPhase;
        this.comms.say(w.phase === 1 ? "warIngress" : w.phase === 2 ? "warBombs" : "warCounter", 0.8);
      }
      // Viper flight joins three seconds after takeoff; count losses only once it has.
      if (this.liftedOffAt >= 0 && this.time - this.liftedOffAt > 5) {
        if (status.wingmen < w.wingmen) this.comms.say("warWingmanDown", 1);
        w.wingmen = status.wingmen;
      }
    }
    if (status.threat && !this.radio.threat && this.state === "flight")
      this.comms.say(status.samLaunch ? "samLaunch" : "missile");
    this.radio.threat = status.threat;
    // Only radar batteries "spike" you; IR launchers give no warning until they fire.
    const spiked = this.combat.airDefense.units.some((u) => u.track > 0 && u.rules.radarVehicle);
    if (spiked && !this.radio.spiked && this.state === "flight") this.comms.say("radarLock");
    this.radio.spiked = spiked;
    if (status.threat && this.state === "flight") {
      this.warningText = `INCOMING MISSILE · ${this.inputActions.bindings.flare.slice(3)} FLARES`;
      if (this.time - this.lastThreatCue > 0.75) {
        this.audio.cue("warning");
        this.lastThreatCue = this.time;
      }
    } else if (status.samLaunch && this.state === "flight")
      this.warningText = `SAM LAUNCH · ${this.inputActions.bindings.flare.slice(3)} FLARES · BREAK`;
    this.updateRwrAudio();
    if (status.canFire && !this.lastLock && this.state === "flight")
      this.audio.cue("lock");
    this.lastLock = status.canFire;
  }
  /** Search pings as emitters appear (and on their sweep), track tone, repeated launch warble. */
  private updateRwrAudio() {
    const w = this.combat.warning;
    const flying = this.state === "flight" && !!this.combat.active;
    let search = 0,
      track = false;
    for (let i = 0; flying && i < w.count; i++) {
      if (w.contacts[i].level === 1) search++;
      else if (w.contacts[i].level === 2) track = true;
    }
    if (search > this.rwrAudio.search || (search && this.time - this.rwrAudio.ping > 2.6)) {
      this.audio.rwrPing();
      this.rwrAudio.ping = this.time;
    }
    this.rwrAudio.search = search;
    this.audio.rwrTone(flying && track && !w.missile);
    if (flying && w.missile && w.missileSam && this.time - this.rwrAudio.launch > 1.6) {
      this.audio.rwrLaunch();
      this.rwrAudio.launch = this.time;
    }
  }
  private drawMap() {
    const canvas = el<HTMLCanvasElement>("map"),
      ctx = canvas.getContext("2d")!,
      size = 216,
      range = this.combat.active === "war" ? 20000 : 12000,
      centerX = Math.round(this.flight.position.x / 500) * 500,
      centerZ = Math.round(this.flight.position.z / 500) * 500,
      key = `${centerX},${centerZ},${range}`;
    if (key !== this.mapCell) {
      this.mapCell = key;
      el("map-scale").textContent = `${range / 1000} KM`;
      const context = this.mapTerrain.getContext("2d")!,
        image = context.createImageData(108, 108);
      for (let y = 0; y < 108; y++)
        for (let x = 0; x < 108; x++) {
          const h = heightAt(
              centerX + (x / 108 - 0.5) * range,
              centerZ + (y / 108 - 0.5) * range,
            ),
            i = (y * 108 + x) * 4;
          // Satellite-style palette: reef shallows to deep water, lowland to ridge.
          const depth = T.MathUtils.clamp(-h / 90, 0, 1);
          const lift = T.MathUtils.clamp(h / 1300, 0, 1);
          image.data[i] = h > 0 ? 52 + lift * 70 : 12 + (1 - depth) * 40;
          image.data[i + 1] = h > 0 ? 92 + lift * 40 : 38 + (1 - depth) * 105;
          image.data[i + 2] = h > 0 ? 52 + lift * 40 : 62 + (1 - depth) * 80;
          image.data[i + 3] = 255;
        }
      context.putImageData(image, 0, 0);
    }
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(this.mapTerrain, 0, 0, size, size);
    ctx.strokeStyle = "#c4e4cf20";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 54, 0);
      ctx.lineTo(i * 54, size);
      ctx.moveTo(0, i * 54);
      ctx.lineTo(size, i * 54);
      ctx.stroke();
    }
    const point = (x: number, z: number) => [
      ((x - centerX) / range) * size + size / 2,
      ((z - centerZ) / range) * size + size / 2,
    ];
    for (const l of landmarks) {
      const p = point(l.x, l.z);
      ctx.strokeStyle = this.mission.discovered.has(l.id)
        ? "#d5ed90"
        : "#a2c6b9";
      ctx.strokeRect(p[0] - 3, p[1] - 3, 6, 6);
    }
    if (this.combat.active) this.drawDefenseMap(ctx, point, size / range);
    if (this.combat.ally?.active) {
      const p = point(this.combat.ally.position.x, this.combat.ally.position.z);
      ctx.fillStyle = "#84e2ed";
      ctx.beginPath();
      ctx.moveTo(p[0], p[1] - 5);
      ctx.lineTo(p[0] - 4, p[1] + 3);
      ctx.lineTo(p[0] + 4, p[1] + 3);
      ctx.closePath();
      ctx.fill();
    }
    if (this.combat.active)
      for (const enemy of this.combat.enemies) {
        if (enemy.health <= 0 || enemy.role.startsWith("sam")) continue;
        const p = point(enemy.position.x, enemy.position.z);
        ctx.fillStyle =
          enemy.id === this.combat.status.targetId ? "#ffdb8b" : "#ff9b83";
        ctx.beginPath();
        ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
        ctx.fill();
      }
    const marker = this.combat.warMarker;
    if (marker) {
      const m = point(marker.x, marker.z);
      ctx.strokeStyle = "#d8f37a";
      ctx.beginPath();
      ctx.arc(m[0], m[1], 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = "#84e2ed";
    for (const w of this.combat.wingmen) {
      if (!w.active) continue;
      const q = point(w.position.x, w.position.z);
      ctx.fillRect(q[0] - 2.5, q[1] - 2.5, 5, 5);
    }
    const gate = this.mission.gate();
    if (gate && !this.mission.completed) {
      const p = point(gate.x, gate.z);
      ctx.strokeStyle = "#ecffa9";
      ctx.beginPath();
      ctx.arc(p[0], p[1], 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    const p = point(this.flight.position.x, this.flight.position.z);
    ctx.save();
    ctx.translate(p[0], p[1]);
    ctx.rotate(-this.flight.yaw);
    ctx.fillStyle = "#edffb8";
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#d5e6cf";
    ctx.font = "10px monospace";
    ctx.fillText("N", size / 2 - 3, 13);
  }
  /** SAM sites: dashed radar rings (scaled by this jet's rcs) and solid short-range rings. */
  private drawDefenseMap(
    ctx: CanvasRenderingContext2D,
    point: (x: number, z: number) => number[],
    pixelsPerMetre: number,
  ) {
    ctx.save();
    const home = point(HOME_UMBRELLA.x, HOME_UMBRELLA.z);
    ctx.strokeStyle = "#84e2ed30";
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(home[0], home[1], HOME_UMBRELLA.radius * pixelsPerMetre, 0, Math.PI * 2);
    ctx.stroke();
    for (const u of this.combat.airDefense.units) {
      const p = point(u.site.x, u.site.z);
      const radar = u.rules.type === "mrsam";
      const alive = u.state !== "destroyed";
      if (alive) {
        const reach = radar ? radarDetectionRange(this.combat.rcs) : SAM_RULES.shorad.detectRange;
        ctx.setLineDash(radar ? [5, 4] : []);
        ctx.strokeStyle = u.track > 0 ? "#ff6a5c70" : radar ? "#ff8a6a38" : "#ffc46a38";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p[0], p[1], reach * pixelsPerMetre, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = alive ? (radar ? "#ff8a6a" : "#ffc46a") : "#8a8a8a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (alive) {
        // Triangle for short-range launchers, diamond for radar batteries.
        if (radar) {
          ctx.moveTo(p[0], p[1] - 4);
          ctx.lineTo(p[0] + 4, p[1]);
          ctx.lineTo(p[0], p[1] + 4);
          ctx.lineTo(p[0] - 4, p[1]);
        } else {
          ctx.moveTo(p[0], p[1] - 4);
          ctx.lineTo(p[0] + 4, p[1] + 3);
          ctx.lineTo(p[0] - 4, p[1] + 3);
        }
        ctx.closePath();
      } else {
        ctx.moveTo(p[0] - 3, p[1] - 3);
        ctx.lineTo(p[0] + 3, p[1] + 3);
        ctx.moveTo(p[0] + 3, p[1] - 3);
        ctx.lineTo(p[0] - 3, p[1] + 3);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  private resetRadio() {
    // Milestones already below the start altitude are not news.
    const y = this.flight.position.y;
    this.radio.milestone = RADIO_MILESTONES.filter(([altitude]) => y >= altitude).length;
    this.radio.kills = 0;
    this.radio.damaged = false;
    this.radio.threat = this.radio.spiked = false;
    this.warRadio = { phase: 0, wingmen: 2, waveCalled: false };
  }
  /** Calls driven by flight state rather than discrete events. */
  private radioCalls() {
    // Storms and distance from Haven make the link rougher.
    this.comms.interference =
      0.2 + (this.sky.weather === "storm" ? 0.45 : 0) + Math.min(0.2, this.flight.position.y / 150000);
    const next = RADIO_MILESTONES[this.radio.milestone];
    if (next && this.flight.position.y >= next[0]) {
      this.radio.milestone++;
      this.comms.say(next[1]);
    }
    if (!this.combat.active || this.combat.completed || this.combat.failed) return;
    const status = this.combat.status;
    if (status.kills > this.radio.kills) {
      this.comms.say(this.radio.kills === 0 ? "firstKill" : "kill", 0.5);
      this.radio.kills = status.kills;
    }
    if (!this.radio.damaged && this.combat.playerHealth < 55 && this.combat.playerHealth > 0) {
      this.radio.damaged = true;
      this.comms.say("damaged", 0.4);
    }
  }
  /** Within a few kilometres of a runway at approach height. */
  private nearRunway() {
    const p = this.flight.position;
    const r = runwayAt(p.x, p.z, 400, 3000);
    return !!r && p.y < r.elevation + 450;
  }
  /** Ground-proximity look-ahead: will the current path meet terrain within 4 s? */
  private terrainAhead() {
    const p = this.flight.position,
      v = this.flight.velocity;
    // Half-second steps keep ridgelines from slipping between samples at speed.
    for (let t = 0.5; t <= 4; t += 0.5) {
      const x = p.x + v.x * t,
        z = p.z + v.z * t;
      if (p.y + v.y * t < Math.max(0, heightAt(x, z)) + 25) return true;
    }
    return false;
  }
  private subtitle(text: string | null, speaker = "HAVEN CONTROL") {
    const box = el("comms");
    if (text) {
      el("comms-text").textContent = text;
      el("comms-speaker").textContent = speaker;
    }
    box.classList.toggle("on", !!text);
  }
  private toast(message: string, type = "FLIGHT LOG") {
    this.toastAnimation?.pause();
    el("toast-message").textContent = message;
    el("toast-type").textContent = type;
    this.toastAnimation = createTimeline()
      .add("#toast", {
        opacity: [0, 1],
        translateY: [-12, 0],
        duration: reducedMotion ? 1 : 500,
        ease: "outExpo",
      })
      .add(
        "#toast",
        { opacity: 0, translateY: -10, duration: reducedMotion ? 1 : 500 },
        "+=3800",
      );
  }
  private syncSettings() {
    this.flight.controlMode = this.settings.controlMode;
    el<HTMLSelectElement>("control-mode").value = this.settings.controlMode;
    el("flight-turn-hint").textContent =
      this.settings.controlMode === "assisted" ? "TURN" : "BANK";
    for (const action of Object.keys(defaultBindings) as CombatAction[])
      el<HTMLSelectElement>(`bind-${action}`).value =
        this.inputActions.bindings[action];
    el<HTMLInputElement>("shake-setting").checked = this.settings.shake;
    el<HTMLInputElement>("dynres-setting").checked = this.settings.dynamicResolution;
    el<HTMLInputElement>("hud-scale").value = String(this.settings.hudScale);
    document.documentElement.style.setProperty(
      "--hud-scale",
      String(this.settings.hudScale),
    );
    this.hud.setScale(this.settings.hudScale);
    el<HTMLSelectElement>("quality").value = this.settings.quality;
    el<HTMLSelectElement>("invert").value = this.settings.invert
      ? "invert"
      : "normal";
    el<HTMLInputElement>("sensitivity").value = String(
      this.settings.sensitivity,
    );
    el<HTMLInputElement>("audio-setting").checked = this.audio.enabled;
    el<HTMLInputElement>("comms-setting").checked = this.settings.comms;
    this.comms.enabled = this.settings.comms && this.audio.enabled;
    if (!this.comms.enabled) this.comms.clear();
    el("sound").textContent = this.audio.enabled ? "♫" : "♪";
    el("sound").setAttribute("aria-pressed", String(this.audio.enabled));
  }
  private applyQuality() {
    this.world.setQuality(this.settings.quality as EffectsQuality);
    this.effects.setQuality(this.settings.quality as EffectsQuality);
    this.sky.setQuality(this.settings.quality as EffectsQuality);
    const ratio =
      this.settings.quality === "low"
        ? 1
        : this.settings.quality === "high"
          ? 2
          : 1.5;
    this.renderer.shadowMap.enabled = this.settings.quality !== "low";
    const scale = this.settings.dynamicResolution ? this.resolution.scale : 1;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, ratio) * scale);
    this.renderer.setSize(
      innerWidth * (this.settings.quality === "low" ? 0.8 : 1),
      innerHeight * (this.settings.quality === "low" ? 0.8 : 1),
      false,
    );
  }
  private updateDiscovery() {
    el("discovery-count").textContent =
      `${String(this.mission.discovered.size).padStart(2, "0")} / 05`;
  }
  private loadSave() {
    try {
      const raw = localStorage.getItem("stratos-save");
      if (!raw) return;
      const s = JSON.parse(raw) as Save;
      if (s.version !== 1 || s.seed !== SEED) return;
      this.mission.discovered = new Set(
        (Array.isArray(s.discovered) ? s.discovered : []).filter((id) =>
          landmarks.some((l) => l.id === id),
        ),
      );
      for (const id of ["skyline", "coast"] as RouteId[])
        if (Number.isFinite(s.best?.[id]) && s.best[id]! > 0)
          this.mission.best[id] = s.best[id];
      if (Number.isFinite(s.hours)) this.settings.hours = ((s.hours! % 24) + 24) % 24;
      if (s.weather && s.weather in WEATHER) this.settings.weather = s.weather;
      if (Number.isFinite(s.ascentBest) && s.ascentBest! > 0) this.ascent.best = s.ascentBest;
      if (s.aircraft && FLEET.some((a) => a.id === s.aircraft)) this.settings.aircraft = s.aircraft;
      this.settings.dynamicResolution = s.dynamicResolution !== false;
      this.settings.comms = s.comms !== false;
      this.settings.quality = ["low", "medium", "high"].includes(s.quality)
        ? s.quality
        : "medium";
      this.settings.invert = !!s.invert;
      this.settings.controlMode =
        s.controlMode === "advanced" ? "advanced" : "assisted";
      this.settings.sensitivity = T.MathUtils.clamp(
        Number(s.sensitivity) || 1,
        0.5,
        1.6,
      );
      this.audio.enabled = s.audio !== false;
      this.settings.shake = s.shake !== false && !reducedMotion;
      this.settings.hudScale = T.MathUtils.clamp(
        Number(s.hudScale) || 1,
        0.8,
        1.3,
      );
      // Z is the airbrake; older saves that bound it fall back to the defaults.
      const allowed = /^Key[FXTVGHJK]$/;
      const next = { ...defaultBindings, ...s.bindings };
      if (
        (Object.keys(defaultBindings) as CombatAction[]).every((action) =>
          allowed.test(next[action]),
        ) &&
        new Set(Object.values(next)).size === 4
      )
        this.inputActions.bindings = next;
      this.updateDiscovery();
    } catch {}
  }
  private save() {
    try {
      const data: Save = {
        version: 1,
        seed: SEED,
        discovered: [...this.mission.discovered],
        best: this.mission.best,
        ascentBest: this.ascent.best,
        ...this.settings,
        audio: this.audio.enabled,
        bindings: this.inputActions.bindings,
      };
      localStorage.setItem("stratos-save", JSON.stringify(data));
    } catch {}
    this.updateDiscovery();
  }
  private fatal(message: string) {
    this.audio.update(0, 0, false, false, 0);
    el("fatal").hidden = false;
    el("fatal-message").textContent = message;
    this.setState("paused");
  }
}
try {
  const game = new Game();
  // Development builds (or ?debug) expose the game for console exploration
  // and automated visual checks.
  if (import.meta.env.DEV || new URLSearchParams(location.search).has("debug"))
    (window as unknown as { stratos: Game }).stratos = game;
} catch (error) {
  el("fatal").hidden = false;
  el("fatal-message").textContent =
    `This experience needs a browser with WebGL 2 enabled. ${error instanceof Error ? error.message : ""}`;
}

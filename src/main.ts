import "./style.css";
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { animate, createTimeline, engine } from "animejs";
import { World } from "./world/World";
import { heightAt, renderedHeightAt, SEED } from "./world/terrain";
import { Flight, neutral } from "./flight";
import { Mission, landmarks, routes, type RouteId } from "./missions";
import { FlightAudio } from "./audio";
import { createUI, el } from "./ui";
import { FrameTelemetry } from "./render/FrameTelemetry";
import {
  FlightInput,
  type CombatAction,
  defaultBindings,
} from "./input/FlightInput";
import { Effects, type EffectsQuality } from "./effects/Effects";
import type { CollisionWorld } from "./physics/CollisionWorld";
import { ParticleDepthPass } from "./render/ParticleDepthPass";
import { CombatSystem, type CombatMission } from "./combat/CombatSystem";
import { CombatView } from "./combat/CombatView";

type State = "menu" | "flight" | "paused" | "crashed";
interface Save {
  version: 1;
  seed: number;
  discovered: string[];
  best: Partial<Record<RouteId, number>>;
  position?: { x: number; z: number };
  quality: string;
  invert: boolean;
  sensitivity: number;
  audio: boolean;
  bindings?: Partial<Record<CombatAction, string>>;
  shake?: boolean;
  hudScale?: number;
}
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
createUI();
class Game {
  renderer: T.WebGLRenderer;
  scene = new T.Scene();
  camera = new T.PerspectiveCamera(56, innerWidth / innerHeight, 1, 22000);
  flight = new Flight();
  mission = new Mission();
  audio = new FlightAudio();
  world: World;
  effects: Effects;
  combat = new CombatSystem();
  combatView: CombatView;
  physics?: CollisionWorld;
  private physicsReady: Promise<void>;
  private depthPass = new ParticleDepthPass();
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
  };
  savePosition?: { x: number; z: number };
  private last = 0;
  private accumulator = 0;
  private time = 0;
  private hudTime = 0;
  private mapTime = 0;
  private saveTime = 0;
  private fps = 60;
  private telemetry = new FrameTelemetry();
  private lastThreatCue = 0;
  private lastLock = false;
  private hitUntil = 0;
  private shakeAmount = 0;
  private missileEmitters = new Set<string>();
  private damageEmitters = new Set<string>();
  private queryPoint = new T.Vector3();
  private workerNotice = false;
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
  private mapCell = "";
  constructor() {
    this.renderer = new T.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFShadowMap;
    el("scene").appendChild(this.renderer.domElement);
    this.world = new World(this.scene);
    this.world.createEnvironment(this.renderer);
    this.scene.environmentIntensity = 0.25;
    this.effects = new Effects(this.scene);
    this.combatView = new CombatView(this.scene);
    this.physicsReady = import("./physics/CollisionWorld")
      .then(({ CollisionWorld }) => CollisionWorld.create(renderedHeightAt))
      .then((physics) => {
        this.physics = physics;
      });
    this.physicsReady.catch(() => {}); // loadAircraft reports initialization failures after both loads settle.
    this.scene.add(this.plane);
    this.scene.add(this.ringGroup);
    this.loadSave();
    this.setState("menu");
    this.bindUI();
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
  private async loadAircraft() {
    try {
      const gltf = await new GLTFLoader().loadAsync(
        "/assets/aircraft/stealth-fighter.glb",
        (e) => {
          const progress = e.total
            ? Math.min(95, (e.loaded / e.total) * 95)
            : 50;
          el("load-progress").style.width = `${progress}%`;
        },
      );
      const model = gltf.scene;
      model.rotation.y = -Math.PI / 2;
      model.scale.setScalar(16 / 1.901339);
      model.traverse((o) => {
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
      this.plane.add(model);
      this.combatView.setAircraftTemplate(model);
      await this.physicsReady;
      await this.renderer.compileAsync(this.scene, this.camera);
      this.loaded = true;
      el<HTMLButtonElement>("start").disabled = false;
      document
        .querySelectorAll<HTMLButtonElement>("[data-combat]")
        .forEach((button) => {
          button.disabled = false;
        });
      el("start-label").textContent = this.savePosition
        ? "CONTINUE EXPLORING"
        : "TAKE TO THE SKIES";
      el("load-progress").style.width = "100%";
      el("loading-note").textContent = "Aircraft ready. Your world is waiting.";
      createTimeline({
        defaults: { duration: reducedMotion ? 1 : 800, ease: "outExpo" },
      })
        .add(".hero > *", {
          opacity: [0, 1],
          translateY: [18, 0],
          delay: (_, i) => (i ?? 0) * 65,
        })
        .add(".route-cards", { opacity: [0, 1], translateY: [12, 0] }, 300);
    } catch (error) {
      this.fatal(
        `The aircraft could not be loaded. Check the connection and try again. ${error instanceof Error ? error.message : ""}`,
      );
    }
  }
  private setState(state: State) {
    this.state = state;
    document.body.dataset.state = state;
    el("pause").hidden = state !== "paused";
    el("crash").hidden = state !== "crashed";
    el("hud").setAttribute("aria-hidden", String(state === "menu"));
    this.keys.clear();
    this.inputActions.clear();
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
    document
      .querySelectorAll<HTMLButtonElement>("[data-combat]")
      .forEach((button) => {
        button.onclick = () =>
          this.start(undefined, button.dataset.combat as CombatMission);
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
      if (e.code === "Escape") {
        if (this.state === "flight") this.pause();
        else if (this.state === "paused") this.resume();
        return;
      }
      if (this.state !== "flight") return;
      if (Object.values(this.inputActions.bindings).includes(e.code))
        e.preventDefault();
      if (e.code === "KeyB" && !e.repeat) {
        if (this.combat.active) {
          this.combat.stop();
          this.combatView.clear();
          this.toast("Combat patrol ended. Continue exploring.", "FREE FLIGHT");
        } else {
          this.mission.stop();
          this.buildRings();
          this.combat.start("intercept", this.flight);
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
      ];
      if (used.includes(e.code)) e.preventDefault();
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
    this.mission.stop();
    this.combat.stop();
    this.combatView.clear();
    this.effects.clear();
    this.telemetry.reset();
    this.missileEmitters.clear();
    this.damageEmitters.clear();
    this.lastLock = false;
    this.shakeAmount = 0;
    if (route) {
      this.mission.start(route);
      const gate = this.mission.gate()!;
      this.flight.reset({ x: gate.x, z: gate.z + 700 });
      this.flight.position.y = gate.y;
      this.flight.previous.copy(this.flight.position);
    } else this.flight.reset(this.savePosition);
    if (combatMission) this.combat.start(combatMission, this.flight);
    this.cameraReady = false;
    this.setState("flight");
    this.audio.start().catch(() => {
      this.audio.enabled = false;
      this.syncSettings();
    });
    this.buildRings();
    this.updateObjective();
    this.toast(
      combatMission
        ? `${this.inputActions.bindings.target.slice(3)} target · ${this.inputActions.bindings.gun.slice(3)} cannon · ${this.inputActions.bindings.missile.slice(3)} missile · ${this.inputActions.bindings.flare.slice(3)} countermeasure. Watch your threat warning.`
        : route
          ? routes[route].description
          : "Welcome to Haven. The horizon is yours.",
      combatMission
        ? `${combatMission.toUpperCase()} SORTIE`
        : route
          ? "CHALLENGE STARTED"
          : "FREE FLIGHT",
    );
  }
  private restart() {
    const route = this.mission.active;
    const combatMission = this.combat.active;
    this.start(route ?? undefined, combatMission ?? undefined);
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
    this.mission.stop();
    this.combat.stop();
    this.combatView.clear();
    this.effects.clear();
    this.flight.reset();
    this.cameraReady = false;
    this.setState("menu");
    this.buildRings();
    el("start-label").textContent = this.savePosition
      ? "CONTINUE EXPLORING"
      : "TAKE TO THE SKIES";
    this.updateDiscovery();
  }
  private input() {
    return this.inputActions.sample(
      this.keys,
      this.settings.invert,
      this.settings.sensitivity,
      navigator.getGamepads ? Array.from(navigator.getGamepads()) : [],
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
    this.fps = T.MathUtils.damp(this.fps, 1 / Math.max(dt, 0.001), 2, dt);
    engine.update();
    if (this.state === "flight") {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= 1 / 60 && steps++ < 6) {
        this.physics?.update(this.flight.position, this.world.origin, 1 / 60);
        this.flight.step(1 / 60, this.input());
        if (
          this.physics?.sweep(
            this.flight.previous,
            this.flight.position,
            this.flight.quaternion,
          )
        )
          this.flight.crashed = true;
        this.effects.updateJet(
          this.flight.position,
          this.flight.quaternion,
          this.flight.boost,
          1 / 60,
        );
        this.combat.step(
          1 / 60,
          this.flight,
          {
            gun: this.inputActions.active("gun"),
            missile: this.inputActions.active("missile"),
            target: this.inputActions.active("target"),
            flare: this.inputActions.active("flare"),
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
        const message = this.mission.update(
          1 / 60,
          this.flight.previous,
          this.flight.position,
        );
        if (message) {
          this.toast(
            message,
            this.mission.completed ? "CHALLENGE COMPLETE" : "FLIGHT LOG",
          );
          this.buildRings();
          this.save();
        }
        if (this.flight.crashed) {
          this.effects.emitExplosion(this.flight.position, 1.8);
          this.audio.cue("explosion");
          el("crash-message").textContent =
            this.combat.playerHealth <= 0
              ? "Aircraft lost in combat. Restart the sortie and try a different approach."
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
          this.save();
        }
    }
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
    this.effects.update(
      this.state === "flight" ? dt : 0,
      this.camera,
      this.world.origin,
    );
    this.updateRings();
    this.audio.update(
      this.flight.speed,
      this.flight.throttle,
      this.state === "flight",
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
    if (this.settings.quality === "high" && this.effects.stats.rendered > 0) {
      const depth = this.depthPass.render(
        this.renderer,
        this.scene,
        this.camera,
      );
      this.effects.setSoftDepth(
        depth.texture,
        this.camera,
        depth.width,
        depth.height,
      );
    } else this.effects.setSoftDepth(null, this.camera, 1, 1);
    this.renderer.render(this.scene, this.camera);
    if (!el("debug").hidden)
      el("debug").textContent =
        `${this.fps.toFixed(0)} FPS\nFRAME median ${this.telemetry.median.toFixed(1)} / p95 ${this.telemetry.p95.toFixed(1)} ms\n${this.renderer.info.render.calls} draw calls\n${this.renderer.info.render.triangles.toLocaleString()} triangles\n${this.world.chunks.size} terrain chunks / ${this.world.stats.pending} pending\nINSTALL ${this.world.stats.uploadMilliseconds.toFixed(2)} ms / ${(this.world.stats.queuedBytes / 1024).toFixed(0)} KiB queued\n${this.effects.stats.smoke} smoke / ${this.effects.stats.flame} flame\n${this.physics?.status.colliders ?? 0} Rapier colliders\n${this.renderer.info.memory.geometries} geometries / ${this.renderer.info.memory.textures} textures\nORIGIN ${this.world.origin.x}, ${this.world.origin.z}`;
    if (this.world.stats.workerFallback && !this.workerNotice) {
      this.workerNotice = true;
      this.toast(
        "Terrain is using coarse coverage while generation recovers.",
        "WORLD STREAMING",
      );
    } else if (!this.world.stats.workerFallback) this.workerNotice = false;
  }
  private updateCamera(dt: number) {
    if (this.state === "menu") {
      this.offset
        .set(-31 + Math.sin(this.time * 0.07) * 7, 15, 39)
        .add(this.local);
      this.look.copy(this.local).add(new T.Vector3(-13, 1, -5));
      this.camera.position.copy(this.offset);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.look);
      this.camera.fov = 49;
    } else {
      this.forward.set(0, 0, -1).applyQuaternion(this.rotation);
      const blend = this.cameraBlend.value;
      this.offset
        .set(
          0,
          T.MathUtils.lerp(7.5, 2.2, blend),
          T.MathUtils.lerp(33, -10, blend),
        )
        .applyQuaternion(this.rotation)
        .add(this.local);
      const globalX = this.offset.x + this.world.origin.x,
        globalZ = this.offset.z + this.world.origin.z;
      this.offset.y = Math.max(
        this.offset.y,
        Math.max(0, heightAt(globalX, globalZ)) + 12,
      );
      if (!this.cameraReady) {
        this.camera.position.copy(this.offset);
        this.cameraReady = true;
      } else this.camera.position.lerp(this.offset, 1 - Math.exp(-7 * dt));
      this.look.copy(this.local).addScaledVector(this.forward, 120);
      this.look.y += 2;
      this.camera.up.set(-Math.sin(this.flight.roll) * 0.13, 1, 0).normalize();
      this.camera.lookAt(this.look);
      this.camera.fov = T.MathUtils.damp(
        this.camera.fov,
        58 + (this.flight.speed - 130) * 0.045 + (this.flight.boost ? 5 : 0),
        3,
        dt,
      );
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
    this.camera.updateProjectionMatrix();
  }
  private processCombatEvents() {
    for (const event of this.combat.drainEvents()) {
      if (event.type === "explosion") {
        this.effects.emitExplosion(event.position, event.scale ?? 1);
        this.audio.cue("explosion");
      } else if (event.type === "gun" || event.type === "missile") {
        if (event.player) this.audio.cue(event.type);
      } else if (event.type === "flare") {
        this.effects.emitExplosion(event.position, 0.2);
        this.audio.cue("missile");
      } else if (event.type === "hit") {
        if (event.player) this.shakeAmount = this.settings.shake ? 0.8 : 0;
        else if (event.entityId !== -1) this.hitUntil = this.time + 0.18;
      } else if (event.type === "complete" || event.type === "failed") {
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
    el("speed").textContent = Math.round(this.flight.speed * 1.94384)
      .toString()
      .padStart(3, "0");
    el("altitude").textContent = Math.round(
      this.flight.position.y,
    ).toLocaleString();
    el("heading").textContent = `${Math.round(
      ((((-this.flight.yaw * 180) / Math.PI) % 360) + 360) % 360,
    )
      .toString()
      .padStart(3, "0")}°`;
    el("throttle-value").textContent =
      `${Math.round(this.flight.throttle * 100)}%`;
    el("throttle-fill").style.width = `${this.flight.throttle * 100}%`;
    el("flight-mode").textContent = this.flight.boost
      ? "AFTERBURNER"
      : this.flight.speed < 95
        ? "LOW AIRSPEED"
        : "CRUISE";
    el("horizon-line").style.transform =
      `translateY(${this.flight.pitch * 35}px) rotate(${(-this.flight.roll * 180) / Math.PI}deg)`;
    const agl =
      this.flight.position.y -
      Math.max(0, heightAt(this.flight.position.x, this.flight.position.z));
    el("warning").textContent =
      this.state === "flight"
        ? agl < 100
          ? "TERRAIN · PULL UP"
          : this.flight.speed < 85
            ? "LOW AIRSPEED · INCREASE THRUST"
            : ""
        : "";
    this.updateCombatHUD();
    this.updateObjective();
    const gate = this.mission.gate();
    el("waypoint").style.display = "none";
    if (gate && !this.mission.completed) {
      this.projected.copy(gate).sub(this.world.origin).project(this.camera);
      if (this.projected.z < 1 && this.projected.z > -1) {
        el("waypoint").style.display = "block";
        el("waypoint").style.left =
          `${T.MathUtils.clamp((this.projected.x * 0.5 + 0.5) * innerWidth, 35, innerWidth - 100)}px`;
        el("waypoint").style.top =
          `${T.MathUtils.clamp((-0.5 * this.projected.y + 0.5) * innerHeight, 110, innerHeight - 200)}px`;
        el("waypoint").querySelector("small")!.textContent =
          `${(gate.distanceTo(this.flight.position) / 1000).toFixed(1)} KM`;
      }
    }
    el("coordinates").textContent =
      `${(this.flight.position.z / -1000).toFixed(1)} N / ${(this.flight.position.x / 1000).toFixed(1)} E`;
  }
  private updateObjective() {
    const objective = el("objective");
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
    el("target-marker").hidden = true;
    el("hit-confirm").hidden = this.time >= this.hitUntil || !active;
    if (!active) return;
    const status = this.combat.status;
    el("combat-state").textContent = this.combat.completed
      ? "SORTIE COMPLETE"
      : this.combat.failed
        ? "SORTIE FAILED"
        : status.threat
          ? "INCOMING MISSILE"
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
    el("combat-hints").textContent =
      `${b.gun.slice(3)} gun · ${b.missile.slice(3)} missile · ${b.target.slice(3)} target · ${b.flare.slice(3)} flare${this.inputActions.connected ? " · GAMEPAD" : ""}`;
    if (status.threat && this.state === "flight") {
      el("warning").textContent = "INCOMING MISSILE · EVADE / COUNTERMEASURE";
      if (this.time - this.lastThreatCue > 0.75) {
        this.audio.cue("warning");
        this.lastThreatCue = this.time;
      }
    }
    if (status.canFire && !this.lastLock && this.state === "flight")
      this.audio.cue("lock");
    this.lastLock = status.canFire;
    const target = this.combat.enemies.find(
      (enemy) => enemy.id === status.targetId && enemy.health > 0,
    );
    if (!target) return;
    this.projected
      .copy(target.position)
      .sub(this.world.origin)
      .applyMatrix4(this.camera.matrixWorldInverse);
    const behind = this.projected.z > 0;
    this.projected
      .copy(target.position)
      .sub(this.world.origin)
      .project(this.camera);
    const offscreen =
      behind ||
      Math.abs(this.projected.x) > 0.85 ||
      Math.abs(this.projected.y) > 0.75;
    if (behind) {
      this.projected.x *= -1;
      this.projected.y *= -1;
    }
    const marker = el("target-marker");
    marker.hidden = false;
    marker.dataset.locked = String(status.canFire);
    marker.dataset.offscreen = String(offscreen);
    marker.style.left = `${T.MathUtils.clamp((this.projected.x * 0.5 + 0.5) * innerWidth, 45, innerWidth - 45)}px`;
    marker.style.top = `${T.MathUtils.clamp((-this.projected.y * 0.5 + 0.5) * innerHeight, 120, innerHeight - 170)}px`;
    marker.querySelector("span")!.textContent = offscreen ? "➤" : "◇";
    if (offscreen)
      marker.querySelector<HTMLElement>("span")!.style.transform =
        `rotate(${Math.atan2(-this.projected.y, this.projected.x)}rad)`;
    else marker.querySelector<HTMLElement>("span")!.style.transform = "";
    el("target-range").textContent = `${(status.range / 1000).toFixed(1)} KM`;
  }
  private drawMap() {
    const canvas = el<HTMLCanvasElement>("map"),
      ctx = canvas.getContext("2d")!,
      size = 216,
      range = 12000,
      centerX = Math.round(this.flight.position.x / 500) * 500,
      centerZ = Math.round(this.flight.position.z / 500) * 500,
      key = `${centerX},${centerZ}`;
    if (key !== this.mapCell) {
      this.mapCell = key;
      const context = this.mapTerrain.getContext("2d")!,
        image = context.createImageData(108, 108);
      for (let y = 0; y < 108; y++)
        for (let x = 0; x < 108; x++) {
          const h = heightAt(
              centerX + (x / 108 - 0.5) * range,
              centerZ + (y / 108 - 0.5) * range,
            ),
            i = (y * 108 + x) * 4;
          image.data[i] = h > 0 ? 55 + Math.min(h / 20, 40) : 21;
          image.data[i + 1] = h > 0 ? 88 + Math.min(h / 20, 30) : 58;
          image.data[i + 2] = h > 0 ? 73 : 64;
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
        if (enemy.health <= 0) continue;
        const p = point(enemy.position.x, enemy.position.z);
        ctx.fillStyle =
          enemy.id === this.combat.status.targetId ? "#ffdb8b" : "#ff9b83";
        ctx.beginPath();
        ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
        ctx.fill();
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
    for (const action of Object.keys(defaultBindings) as CombatAction[])
      el<HTMLSelectElement>(`bind-${action}`).value =
        this.inputActions.bindings[action];
    el<HTMLInputElement>("shake-setting").checked = this.settings.shake;
    el<HTMLInputElement>("hud-scale").value = String(this.settings.hudScale);
    document.documentElement.style.setProperty(
      "--hud-scale",
      String(this.settings.hudScale),
    );
    el<HTMLSelectElement>("quality").value = this.settings.quality;
    el<HTMLSelectElement>("invert").value = this.settings.invert
      ? "invert"
      : "normal";
    el<HTMLInputElement>("sensitivity").value = String(
      this.settings.sensitivity,
    );
    el<HTMLInputElement>("audio-setting").checked = this.audio.enabled;
    el("sound").textContent = this.audio.enabled ? "♫" : "♪";
    el("sound").setAttribute("aria-pressed", String(this.audio.enabled));
  }
  private applyQuality() {
    this.world.setQuality(this.settings.quality as EffectsQuality);
    this.effects.setQuality(this.settings.quality as EffectsQuality);
    const ratio =
      this.settings.quality === "low"
        ? 1
        : this.settings.quality === "high"
          ? 2
          : 1.5;
    this.renderer.shadowMap.enabled = this.settings.quality !== "low";
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, ratio));
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
      if (
        s.position &&
        Number.isFinite(s.position.x) &&
        Number.isFinite(s.position.z) &&
        Math.abs(s.position.x) < 1e9 &&
        Math.abs(s.position.z) < 1e9
      )
        this.savePosition = s.position;
      this.settings.quality = ["low", "medium", "high"].includes(s.quality)
        ? s.quality
        : "medium";
      this.settings.invert = !!s.invert;
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
      const allowed = /^Key[FXTVGHJKZ]$/;
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
      if (this.state !== "menu" && !this.flight.crashed)
        this.savePosition = {
          x: this.flight.position.x,
          z: this.flight.position.z,
        };
      const data: Save = {
        version: 1,
        seed: SEED,
        discovered: [...this.mission.discovered],
        best: this.mission.best,
        position: this.savePosition,
        ...this.settings,
        audio: this.audio.enabled,
        bindings: this.inputActions.bindings,
      };
      localStorage.setItem("stratos-save", JSON.stringify(data));
    } catch {}
    this.updateDiscovery();
  }
  private fatal(message: string) {
    this.audio.update(0, 0, false);
    el("fatal").hidden = false;
    el("fatal-message").textContent = message;
    this.setState("paused");
  }
}
try {
  new Game();
} catch (error) {
  el("fatal").hidden = false;
  el("fatal-message").textContent =
    `This experience needs a browser with WebGL 2 enabled. ${error instanceof Error ? error.message : ""}`;
}

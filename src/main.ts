import "./style.css";
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { animate, createTimeline, engine } from "animejs";
import { World } from "./world/World";
import { heightAt, SEED } from "./world/terrain";
import { Flight, neutral } from "./flight";
import { Mission, landmarks, routes, type RouteId } from "./missions";
import { FlightAudio } from "./audio";
import { createUI, el } from "./ui";

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
  plane = new T.Group();
  exhaust: T.Mesh;
  state: State = "menu";
  loaded = false;
  keys = new Set<string>();
  cameraMode = 0;
  cameraBlend = { value: 0 };
  settings = { quality: "medium", invert: false, sensitivity: 1 };
  savePosition?: { x: number; z: number };
  private last = 0;
  private accumulator = 0;
  private time = 0;
  private hudTime = 0;
  private mapTime = 0;
  private saveTime = 0;
  private fps = 60;
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
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    el("scene").appendChild(this.renderer.domElement);
    this.world = new World(this.scene);
    const pmrem = new T.PMREMGenerator(this.renderer),
      room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04);
    this.scene.environment = environment.texture;
    this.scene.environmentIntensity = 0.7;
    room.dispose();
    pmrem.dispose();
    const flameGeometry = new T.ConeGeometry(0.85, 5, 12);
    flameGeometry.rotateX(Math.PI / 2);
    this.exhaust = new T.Mesh(
      flameGeometry,
      new T.MeshBasicMaterial({
        color: "#a5defc",
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: T.AdditiveBlending,
      }),
    );
    this.exhaust.position.set(0, 0.1, 8);
    this.plane.add(this.exhaust);
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
      await this.renderer.compileAsync(this.scene, this.camera);
      this.loaded = true;
      el<HTMLButtonElement>("start").disabled = false;
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
  private start(route?: RouteId) {
    if (!this.loaded) return;
    this.mission.stop();
    if (route) {
      this.mission.start(route);
      const gate = this.mission.gate()!;
      this.flight.reset({ x: gate.x, z: gate.z + 700 });
      this.flight.position.y = gate.y;
      this.flight.previous.copy(this.flight.position);
    } else this.flight.reset(this.savePosition);
    this.cameraReady = false;
    this.setState("flight");
    this.audio.start().catch(() => {
      this.audio.enabled = false;
      this.syncSettings();
    });
    this.buildRings();
    this.updateObjective();
    this.toast(
      route
        ? routes[route].description
        : "Welcome to Haven. The horizon is yours.",
      route ? "CHALLENGE STARTED" : "FREE FLIGHT",
    );
  }
  private restart() {
    const route = this.mission.active;
    this.start(route ?? undefined);
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
    const key = (...codes: string[]) =>
      codes.some((k) => this.keys.has(k)) ? 1 : 0;
    return {
      pitch:
        (key("KeyW", "ArrowUp") - key("KeyS", "ArrowDown")) *
        (this.settings.invert ? -1 : 1) *
        this.settings.sensitivity,
      roll:
        (key("KeyA", "ArrowLeft") - key("KeyD", "ArrowRight")) *
        this.settings.sensitivity,
      yaw: key("KeyQ") - key("KeyE"),
      throttle:
        key("ShiftLeft", "ShiftRight") - key("ControlLeft", "ControlRight"),
      boost: !!key("Space"),
    };
  }
  private frame(timestamp: number) {
    const dt = this.last
      ? Math.min((timestamp - this.last) / 1000, 0.1)
      : 1 / 60;
    this.last = timestamp;
    this.time += dt;
    this.fps = T.MathUtils.damp(this.fps, 1 / Math.max(dt, 0.001), 2, dt);
    engine.update();
    if (this.state === "flight") {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= 1 / 60 && steps++ < 6) {
        this.flight.step(1 / 60, this.input());
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
    this.world.update(this.flight.position, dt);
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
    this.exhaust.scale.setScalar(
      this.flight.boost ? 1.6 : 0.6 + this.flight.throttle * 0.4,
    );
    this.exhaust.scale.z *= 0.9 + Math.sin(this.time * 50) * 0.1;
    this.exhaust.visible = this.state !== "menu";
    this.updateCamera(dt);
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
    this.renderer.render(this.scene, this.camera);
    if (!el("debug").hidden)
      el("debug").textContent =
        `${this.fps.toFixed(0)} FPS\n${this.renderer.info.render.calls} draw calls\n${this.renderer.info.render.triangles.toLocaleString()} triangles\n${this.world.chunks.size} terrain chunks\n${this.renderer.info.memory.geometries} geometries\n${this.renderer.info.memory.textures} textures\nORIGIN ${this.world.origin.x}, ${this.world.origin.z}`;
    if (this.world.workerError) {
      this.world.workerError = false;
      this.fatal("Terrain generation stopped. Reload to restore your flight.");
    }
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
    this.camera.updateProjectionMatrix();
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
    if (this.mission.active) {
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

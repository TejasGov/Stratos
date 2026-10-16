import * as T from "three";
import { CombatSystem, type CombatEntity } from "./CombatSystem";
import {
  createDefenseTemplates,
  loadDefenseTemplates,
  type DefenseTemplates,
} from "./DefenseModels";

/** SAM vehicles' combat positions sit at their hull centre, above the model origin. */
const SAM_HULL_HEIGHT = 3;
const MAX_MISSILES = 32;

interface DefenseParts {
  turret?: T.Object3D;
  canisters?: T.Object3D;
  antenna?: T.Object3D;
  wrecked: boolean;
}

/** Render-only combat presentation; globals are converted against origin on every update. */
export class CombatView {
  readonly group = new T.Group();
  private entities = new Map<number, T.Group>();
  private template?: T.Object3D;
  private geometries: T.BufferGeometry[] = [];
  private materials: T.Material[] = [];
  private missileMesh: T.InstancedMesh;
  private tracerGeometry = new T.BufferGeometry();
  private tracerPositions = new Float32Array(96 * 6);
  private tracerColors = new Float32Array(96 * 6);
  private matrix = new T.Matrix4();
  private local = new T.Vector3();
  private scale = new T.Vector3(2.2, 2.2, 2.2);
  private quaternion = new T.Quaternion();
  private forward = new T.Vector3(0, 0, -1);
  private white = new T.Color(0.35, 0.95, 1);
  private orange = new T.Color(1, 0.32, 0.07);
  private bodyGeometry: T.BufferGeometry;
  private wingGeometry: T.BufferGeometry;
  private bodyMaterial: T.MeshStandardMaterial;
  private allyMaterial: T.MeshStandardMaterial;
  private beaconGeometry: T.BufferGeometry;
  private beaconMaterial: T.MeshBasicMaterial;
  private allyBeaconMaterial: T.MeshBasicMaterial;
  private groundGeometry: T.BufferGeometry;
  private mastGeometry: T.BufferGeometry;
  private dishGeometry: T.BufferGeometry;
  private groundMaterial: T.MeshStandardMaterial;
  private disposed = false;
  private defense?: DefenseTemplates;
  private defenseParts = new Map<number, DefenseParts>();
  private wreckMaterial: T.MeshStandardMaterial;
  private bodyYaw = new T.Quaternion();
  private turn = new T.Quaternion();
  private up = new T.Vector3(0, 1, 0);

  constructor(scene?: T.Scene) {
    this.group.name = "combat-entities";
    scene?.add(this.group);
    const ownGeometry = <G extends T.BufferGeometry>(g: G) => {
      this.geometries.push(g);
      return g;
    };
    const ownMaterial = <M extends T.Material>(m: M) => {
      this.materials.push(m);
      return m;
    };
    this.bodyGeometry = ownGeometry(new T.ConeGeometry(1.1, 13, 8));
    this.bodyGeometry.rotateX(-Math.PI / 2);
    // Thin swept silhouette, normalized to roughly the player's 16m aircraft.
    this.wingGeometry = ownGeometry(new T.BufferGeometry());
    this.wingGeometry.setAttribute(
      "position",
      new T.Float32BufferAttribute(
        [
          0, 0, -3, -6, 0, 4, 0, 0, 2, 0, 0, -3, 0, 0, 2, 6, 0, 4, 0, 0, 4,
          -2.5, 0, 6.5, 0, 0, 5.5, 0, 0, 4, 0, 0, 5.5, 2.5, 0, 6.5,
        ],
        3,
      ),
    );
    this.wingGeometry.computeVertexNormals();
    this.bodyMaterial = ownMaterial(
      new T.MeshStandardMaterial({
        color: 0x737c83,
        roughness: 0.57,
        metalness: 0.45,
        side: T.DoubleSide,
      }),
    );
    this.allyMaterial = ownMaterial(
      new T.MeshStandardMaterial({
        color: 0xd2dee1,
        roughness: 0.6,
        metalness: 0.35,
        side: T.DoubleSide,
      }),
    );
    this.beaconGeometry = ownGeometry(new T.SphereGeometry(0.32, 6, 4));
    this.beaconMaterial = ownMaterial(
      new T.MeshBasicMaterial({ color: 0xff542c }),
    );
    this.allyBeaconMaterial = ownMaterial(
      new T.MeshBasicMaterial({ color: 0x64dcf1 }),
    );
    this.groundGeometry = ownGeometry(new T.BoxGeometry(22, 12, 18));
    this.mastGeometry = ownGeometry(new T.CylinderGeometry(1.2, 1.8, 18, 8));
    this.dishGeometry = ownGeometry(
      new T.SphereGeometry(7, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    );
    this.groundMaterial = ownMaterial(
      new T.MeshStandardMaterial({
        color: 0x49544c,
        roughness: 0.88,
        metalness: 0.25,
      }),
    );
    this.wreckMaterial = ownMaterial(
      new T.MeshStandardMaterial({
        color: 0x1b1a18,
        roughness: 1,
        metalness: 0,
      }),
    );
    const missileGeometry = ownGeometry(new T.ConeGeometry(0.23, 2.3, 6));
    missileGeometry.rotateX(-Math.PI / 2);
    const missileMaterial = ownMaterial(
      new T.MeshBasicMaterial({ color: 0xffffff }),
    );
    this.missileMesh = new T.InstancedMesh(
      missileGeometry,
      missileMaterial,
      MAX_MISSILES,
    );
    this.missileMesh.count = 0;
    this.missileMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.missileMesh.frustumCulled = false;
    this.group.add(this.missileMesh);
    this.tracerGeometry.setAttribute(
      "position",
      new T.BufferAttribute(this.tracerPositions, 3).setUsage(
        T.DynamicDrawUsage,
      ),
    );
    this.tracerGeometry.setAttribute(
      "color",
      new T.BufferAttribute(this.tracerColors, 3).setUsage(T.DynamicDrawUsage),
    );
    const tracerMaterial = ownMaterial(
      new T.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    );
    const tracers = new T.LineSegments(this.tracerGeometry, tracerMaterial);
    tracers.frustumCulled = false;
    this.group.add(tracers);
  }
  /** Normalized model keeps its own scale/rotation; the entity wrapper applies flight attitude once. */
  setAircraftTemplate(model: T.Object3D) {
    this.template = model;
    for (const root of this.entities.values()) root.removeFromParent();
    this.entities.clear();
  }
  private enemyTemplates: T.Object3D[] = [];
  /** Hostile fighters cycle through these airframes (by entity id). */
  setEnemyTemplates(models: T.Object3D[]) {
    this.enemyTemplates = models;
    for (const root of this.entities.values()) root.removeFromParent();
    this.entities.clear();
  }
  /** Real launcher/radar models replace the procedural placeholders when they load. */
  setDefenseTemplates(templates: DefenseTemplates) {
    this.defense = templates;
    for (const id of this.defenseParts.keys()) {
      this.entities.get(id)?.removeFromParent();
      this.entities.delete(id);
    }
    this.defenseParts.clear();
  }
  /** Fetches public/assets/defense/*.glb when present; keeps placeholders otherwise. */
  async loadDefenseModels(loader: {
    loadAsync(url: string): Promise<{ scene: T.Object3D }>;
  }) {
    const templates = await loadDefenseTemplates(
      loader,
      this.defense ?? createDefenseTemplates(),
    );
    if (!this.disposed) this.setDefenseTemplates(templates);
  }
  private visual(entity: CombatEntity) {
    const root = new T.Group();
    root.name = `combat-${entity.id}`;
    if (entity.role === "sam-launcher" || entity.role === "sam-radar") {
      this.defense ??= createDefenseTemplates();
      const model = (
        entity.role === "sam-launcher"
          ? this.defense.launcher
          : this.defense.radar
      ).clone(true);
      root.add(model);
      this.defenseParts.set(entity.id, {
        turret: model.getObjectByName("turret"),
        canisters: model.getObjectByName("canisters"),
        antenna: model.getObjectByName("antenna"),
        wrecked: false,
      });
    } else if (entity.role === "target") {
      // Strike installations are world buildings (Airbase); combat only tracks them.
    } else if (entity.kind === "ground") {
      const base = new T.Mesh(this.groundGeometry, this.groundMaterial);
      base.position.y = -12;
      const mast = new T.Mesh(this.mastGeometry, this.groundMaterial);
      mast.position.y = 2;
      const dish = new T.Mesh(this.dishGeometry, this.groundMaterial);
      dish.position.y = 11;
      root.add(base, mast, dish);
    } else {
      const template =
        entity.kind === "air" && this.enemyTemplates.length
          ? this.enemyTemplates[entity.id % this.enemyTemplates.length]
          : this.template;
      if (template) root.add(template.clone(true));
      else {
        const material =
          entity.kind === "ally" ? this.allyMaterial : this.bodyMaterial;
        root.add(
          new T.Mesh(this.bodyGeometry, material),
          new T.Mesh(this.wingGeometry, material),
        );
      }
      if (entity.kind === "ally") root.scale.setScalar(1.35);
      const beacon = new T.Mesh(
        this.beaconGeometry,
        entity.kind === "ally" ? this.allyBeaconMaterial : this.beaconMaterial,
      );
      beacon.position.set(0, 0.7, 5.5);
      root.add(beacon);
    }
    root.traverse((o) => {
      if (o instanceof T.Mesh) o.castShadow = o.receiveShadow = true;
    });
    this.group.add(root);
    this.entities.set(entity.id, root);
    return root;
  }
  update(system: CombatSystem, origin: T.Vector3) {
    if (this.disposed) return;
    this.group.visible = system.active !== null;
    for (const root of this.entities.values()) root.visible = false;
    for (const entity of system.enemies) this.place(system, entity, origin);
    if (system.ally) this.place(system, system.ally, origin);
    let missiles = 0;
    for (const missile of system.missiles) {
      if (!missile.active || missiles >= MAX_MISSILES) continue;
      this.local.copy(missile.position).sub(origin);
      this.quaternion.setFromUnitVectors(this.forward, missile.direction);
      this.matrix.compose(
        this.local,
        this.quaternion,
        this.scale.setScalar(missile.profile.scale),
      );
      this.missileMesh.setMatrixAt(missiles, this.matrix);
      this.missileMesh.setColorAt(
        missiles,
        missile.hostile ? this.orange : this.white,
      );
      missiles++;
    }
    this.missileMesh.count = missiles;
    this.missileMesh.instanceMatrix.needsUpdate = true;
    if (this.missileMesh.instanceColor)
      this.missileMesh.instanceColor.needsUpdate = true;
    let tracers = 0;
    for (const tracer of system.tracers) {
      if (!tracer.active) continue;
      let offset = tracers * 6;
      this.local.copy(tracer.previous).sub(origin);
      this.tracerPositions.set(this.local.toArray(), offset);
      this.local.copy(tracer.position).sub(origin);
      this.tracerPositions.set(this.local.toArray(), offset + 3);
      const color = tracer.hostile ? this.orange : this.white;
      this.tracerColors.set(
        [color.r, color.g, color.b, color.r, color.g, color.b],
        offset,
      );
      tracers++;
    }
    this.tracerGeometry.setDrawRange(0, tracers * 2);
    this.tracerGeometry.attributes.position.needsUpdate =
      this.tracerGeometry.attributes.color.needsUpdate = true;
  }
  private place(
    system: CombatSystem,
    entity: CombatEntity,
    origin: T.Vector3,
  ) {
    const root = this.entities.get(entity.id) ?? this.visual(entity);
    root.position.copy(entity.position).sub(origin);
    root.quaternion.copy(entity.quaternion);
    const parts = this.defenseParts.get(entity.id);
    if (!parts) {
      root.visible = entity.active;
      return;
    }
    // Destroyed vehicles stay as charred wrecks; the battery's state drives the rest.
    root.visible = true;
    root.position.y -= SAM_HULL_HEIGHT;
    if (!entity.active) {
      if (!parts.wrecked) {
        parts.wrecked = true;
        root.traverse((o) => {
          if (o instanceof T.Mesh) o.material = this.wreckMaterial;
        });
        root.scale.set(1, 0.7, 1);
      }
      root.rotateZ(0.12);
      return;
    }
    const unit = system.airDefense.unitFor(entity.id);
    if (!unit) return;
    // Slew angles are world headings; the hull may face anywhere.
    parts.turret?.rotation.set(0, this.relativeYaw(entity, unit.turretYaw), 0);
    parts.canisters?.rotation.set(unit.elevation, 0, 0);
    parts.antenna?.rotation.set(0, this.relativeYaw(entity, unit.antenna), 0);
  }
  private relativeYaw(entity: CombatEntity, yaw: number) {
    this.bodyYaw.copy(entity.quaternion).invert();
    this.turn.setFromAxisAngle(this.up, yaw).premultiply(this.bodyYaw);
    this.local.set(0, 0, -1).applyQuaternion(this.turn);
    return Math.atan2(-this.local.x, -this.local.z);
  }
  clear() {
    for (const root of this.entities.values()) root.removeFromParent();
    this.entities.clear();
    this.defenseParts.clear();
    this.missileMesh.count = 0;
    this.tracerGeometry.setDrawRange(0, 0);
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.group.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    this.tracerGeometry.dispose();
    for (const material of this.materials) material.dispose();
    // Shared player-model geometry/material/texture resources belong to its loader.
    this.disposed = true;
  }
}

/**
 * Escena de Three.js del horizonte en primera persona. Vive fuera de React,
 * como el mapa: el componente la crea una vez y le pasa malla, Sol y vista.
 * Dibuja solo cuando algo cambia (no hay bucle de animación).
 *
 * Lo que es dato: la forma del terreno (DTM + DEM 200 m) y la dirección del
 * Sol (Mars24). Lo que es ilustrativo: los colores del suelo y del cielo y la
 * bruma; lo dice la UI.
 */
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import type { SunPosition } from "../mars/sunPosition";
import type { HorizonMesh } from "./mesh";

const DEG = Math.PI / 180;

/** Radio de las sombras proyectadas alrededor del observador (m). Más allá, sin sombras. */
export const SHADOW_RADIUS_M = 800;
/** Diámetro aparente del Sol desde Marte (°), a 1,52 UA. */
const SUN_DIAMETER_DEG = 0.35;

// Colores ilustrativos: regolito y cielo de tono marciano, no medidos.
const GROUND = new Color("#a86c4c");
const SKY_DAY_HORIZON = new Color("#d6ab82");
const SKY_DAY_ZENITH = new Color("#8f6c57");
const SKY_NIGHT = new Color("#0c0b10");
const SUN_HALO = new Color("#a9bccf"); // halo azulado alrededor del Sol, como en las fotos de los rovers

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 sunDir;
  uniform vec3 horizonColor;
  uniform vec3 zenithColor;
  uniform vec3 haloColor;
  uniform float day;        // 0 noche, 1 día
  uniform float sunVisible; // 0 tapado o bajo el horizonte
  uniform float sunCos;     // coseno del radio aparente del Sol
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float t = clamp(d.y, 0.0, 1.0);
    vec3 col = mix(horizonColor, zenithColor, pow(t, 0.6));
    float c = dot(d, sunDir);
    col = mix(col, haloColor, day * 0.55 * pow(max(c, 0.0), 24.0));
    // El disco del Sol, a su tamaño real, más un brillo para encontrarlo.
    float disc = smoothstep(sunCos - 0.000004, sunCos + 0.000004, c);
    float glow = pow(max(c, 0.0), 2000.0) * 0.8;
    col = mix(col, vec3(1.0, 0.98, 0.92), sunVisible * clamp(disc + glow, 0.0, 1.0));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export interface HorizonViewParams {
  /** Rumbo al que se mira, ° desde el norte hacia el este. */
  readonly headingDeg: number;
  /** Inclinación de la mirada, ° (positivo hacia arriba). */
  readonly pitchDeg: number;
  /** Campo de visión vertical, °. */
  readonly fovDeg: number;
}

export class HorizonScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(50, 1, 0.05, 400_000);
  private readonly sunLight = new DirectionalLight("#fff4e6", 2.6);
  private readonly skyLight = new HemisphereLight("#d8b090", "#5a3b2c", 0.55);
  private readonly sky: Mesh<SphereGeometry, ShaderMaterial>;
  private terrain: Mesh<BufferGeometry, MeshLambertMaterial> | null = null;
  private frame = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.camera.rotation.order = "YXZ";
    this.scene.fog = new FogExp2(SKY_DAY_HORIZON.getHex(), 1 / 70_000);

    // Cielo: una esfera pegada a la cámara que se dibuja antes que todo y no
    // escribe profundidad, así el terreno siempre queda delante.
    this.sky = new Mesh(
      new SphereGeometry(1000, 48, 24),
      new ShaderMaterial({
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        side: BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        uniforms: {
          sunDir: { value: new Vector3(0, 1, 0) },
          horizonColor: { value: SKY_DAY_HORIZON.clone() },
          zenithColor: { value: SKY_DAY_ZENITH.clone() },
          haloColor: { value: SUN_HALO.clone() },
          day: { value: 1 },
          sunVisible: { value: 1 },
          sunCos: { value: Math.cos((SUN_DIAMETER_DEG / 2) * DEG) },
        },
      }),
    );
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    const s = this.sunLight.shadow;
    s.mapSize.set(4096, 4096);
    s.camera.left = -SHADOW_RADIUS_M;
    s.camera.right = SHADOW_RADIUS_M;
    s.camera.top = SHADOW_RADIUS_M;
    s.camera.bottom = -SHADOW_RADIUS_M;
    s.camera.near = 1;
    s.camera.far = 20_000;
    s.bias = -0.0004;
    s.normalBias = 0.4;
    this.sunLight.castShadow = true;
    this.scene.add(this.sunLight, this.sunLight.target, this.skyLight);
  }

  setMesh(mesh: HorizonMesh) {
    this.disposeTerrain();
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(mesh.positions, 3));
    g.setIndex(new BufferAttribute(mesh.indices, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this.terrain = new Mesh(g, new MeshLambertMaterial({ color: GROUND }));
    this.terrain.castShadow = true;
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
    this.requestRender();
  }

  /** `lit`: el Sol está sobre el horizonte del relieve visto desde el observador. */
  setSun(sun: SunPosition, lit: boolean) {
    const [e, n, u] = sun.enu;
    const dir = new Vector3(e, u, -n).normalize();
    // Día: el cielo se aclara cuando el Sol pasa unos grados bajo el horizonte (crepúsculo).
    const day = Math.min(Math.max((sun.elevationDeg + 6) / 12, 0), 1);
    const u_ = this.sky.material.uniforms;
    u_.sunDir!.value.copy(dir);
    u_.day!.value = day;
    u_.sunVisible!.value = sun.elevationDeg > -SUN_DIAMETER_DEG / 2 ? 1 : 0;
    u_.horizonColor!.value.copy(SKY_NIGHT).lerp(SKY_DAY_HORIZON, day);
    u_.zenithColor!.value.copy(SKY_NIGHT).lerp(SKY_DAY_ZENITH, day);
    (this.scene.fog as FogExp2).color.copy(u_.horizonColor!.value);

    this.sunLight.position.copy(dir).multiplyScalar(10_000);
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.visible = lit && sun.elevationDeg > 0;
    this.skyLight.intensity = 0.08 + 0.5 * day;
    this.requestRender();
  }

  setView({ headingDeg, pitchDeg, fovDeg }: HorizonViewParams) {
    this.camera.rotation.y = -headingDeg * DEG;
    this.camera.rotation.x = pitchDeg * DEG;
    this.camera.fov = fovDeg;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** La imagen actual como PNG (para la Postal y la comparación con la foto). */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL("image/png");
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.disposeTerrain();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.sunLight.shadow.dispose();
    this.renderer.dispose();
  }

  private requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.sky.position.copy(this.camera.position);
      this.renderer.render(this.scene, this.camera);
    });
  }

  private disposeTerrain() {
    if (!this.terrain) return;
    this.scene.remove(this.terrain);
    this.terrain.geometry.dispose();
    this.terrain.material.dispose();
    this.terrain = null;
  }
}

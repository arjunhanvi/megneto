'use client';

/**
 * THE EXPLODED VIEW
 *
 * A machine built from three separable parts instead of one box:
 *
 *   · Outer casing  — the painted steel you normally see. Slides up and fades
 *                     back when the machine is opened.
 *   · Internal motor — drive stack, visible once the casing lifts. Spins at the
 *                     machine's live RPM.
 *   · Core sensor   — the thermal/acoustic pickup. This is the thing the X-ray
 *                     panel has been talking about all along, and when the
 *                     machine is faulted it pulses red so you can point at the
 *                     exact source.
 *
 * ============================================================================
 * EVERY FRAME OF THIS ANIMATION IS A REF MUTATION
 * ============================================================================
 * The explode progress is a number on a ref, eased with smoothstep and driven
 * off `useFrame` delta. `explodedMachineId` is read with `getState()` inside
 * the loop, so this component never subscribes to it and never re-renders
 * while the animation runs.
 *
 * That matters more here than anywhere else in the app: on a floor with
 * nineteen machines and three thousand instanced people already consuming the
 * frame budget, a React commit mid-animation is a visible hitch.
 * ============================================================================
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';

import {
  KINEMATICS,
  SITES,
  STATUS_COLOR,
  STATUS_COLOR_HEX,
  floorElevation,
  type MachineDef,
  type MachineStatus,
  type SiteId,
} from '@/lib/sites';
import { THEME } from '@/lib/theme';
import { getSite, useMegnetoStore } from '@/store/useMegnetoStore';

const tmpColor = new THREE.Color();
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Seconds for the casing to lift clear. */
const EXPLODE_SECONDS = 0.85;

export interface DiagnosticMachineProps {
  siteId: SiteId;
  def: MachineDef;
  index: number;
  /** Fades the whole assembly when its floor is not the active one. */
  onCollectMaterials?: (mats: THREE.Material[]) => void;
}

export default function DiagnosticMachine({ siteId, def, index }: DiagnosticMachineProps) {
  const groupRef = useRef<THREE.Group>(null);
  const casingRef = useRef<THREE.Mesh>(null);
  const casingEdgeRef = useRef<THREE.LineSegments>(null);
  const motorRef = useRef<THREE.Group>(null);
  const rotorRef = useRef<THREE.Mesh>(null);
  const sensorRef = useRef<THREE.Mesh>(null);
  const sensorGlowRef = useRef<THREE.Mesh>(null);
  const stripeRef = useRef<THREE.Mesh>(null);
  const beaconRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const sensorLightRef = useRef<THREE.PointLight>(null);

  const lastStatus = useRef<MachineStatus | null>(null);
  /** 0 = sealed, 1 = fully open. Eased, never React state. */
  const explode = useRef(0);
  /** Materials of the assembly, collected once for the floor fade. */
  const fadeMats = useRef<THREE.Material[]>([]);

  const [sx, sy, sz] = def.size;
  const elevation = floorElevation(SITES[siteId], def.floor);

  /**
   * Subscribed, not polled, because this gates whether a light EXISTS in the
   * scene. A point light with intensity 0 still occupies a shader slot and
   * still costs every lit fragment in the scene — the only way to stop paying
   * for it is to unmount it.
   */
  const isOpen = useMegnetoStore((s) => s.explodedMachineId === def.id);
  const explodeMachine = useMegnetoStore((s) => s.explodeMachine);
  const inspectKinematics = useMegnetoStore((s) => s.inspectKinematics);
  const actOnMachine = useMegnetoStore((s) => s.actOnMachine);

  /* ---- cached geometry ---- */
  const casingEdges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz)), [sx, sy, sz]);
  useEffect(() => () => casingEdges.dispose(), [casingEdges]);

  /* ---- collect materials once, for the per-floor fade ---- */
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const out: THREE.Material[] = [];
    group.traverse((obj) => {
      const withMat = obj as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
      if (!withMat.material) return;
      const list = Array.isArray(withMat.material) ? withMat.material : [withMat.material];
      for (const m of list) out.push(m);
    });
    fadeMats.current = out;
  }, []);

  const onClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      // A jammed machine is dispatched by the click; a healthy one opens up.
      const machine = getSite(siteId).machines.find((m) => m.def.id === def.id);
      if (machine?.jammed) {
        actOnMachine(def.id);
        return;
      }
      // Sewing machines and presses have dramatic, countable motion, so a
      // click on one goes straight to the macro lens — that is the pitch.
      // Everything else opens up instead, which is the better read for a
      // vessel or a cabinet with nothing visibly reciprocating.
      const motion = KINEMATICS[def.kind].kind;
      if (motion === 'needle' || motion === 'roller') inspectKinematics(def.id);
      else explodeMachine(def.id);
    },
    [siteId, def.id, explodeMachine, actOnMachine],
  );

  useFrame((state, dt) => {
    const site = getSite(siteId);
    const machine = site.machines.find((m) => m.def.id === def.id);
    if (!machine) return;
    const t = state.clock.elapsedTime;

    /* ---------- status colour, uploaded only on transition ---------- */
    if (lastStatus.current !== machine.status) {
      lastStatus.current = machine.status;
      tmpColor.setHex(STATUS_COLOR_HEX[machine.status]);

      const casingMat = casingRef.current?.material as THREE.MeshStandardMaterial | undefined;
      if (casingMat) {
        casingMat.emissive.copy(tmpColor);
        casingMat.emissiveIntensity = machine.status === 'nominal' ? 0.04 : 0.24;
      }
      for (const ref of [stripeRef, beaconRef, haloRef]) {
        const mat = ref.current?.material as THREE.MeshBasicMaterial | undefined;
        if (mat) mat.color.copy(tmpColor);
      }
    }

    /* ---------- the explode transition ---------- */
    const open = useMegnetoStore.getState().explodedMachineId === def.id;
    const target = open ? 1 : 0;
    const rate = dt / EXPLODE_SECONDS;
    explode.current = target > explode.current
      ? Math.min(1, explode.current + rate)
      : Math.max(0, explode.current - rate);
    const e = smoothstep(explode.current);

    const faulted = machine.status !== 'nominal' && machine.status !== 'idle';

    /* --- casing lifts clear and goes translucent --- */
    if (casingRef.current) {
      const lift = sy * 0.5 + e * (sy * 1.5 + 1.1);
      casingRef.current.position.y = lift;
      const mat = casingRef.current.material as THREE.MeshStandardMaterial;
      const op = 1 - e * 0.72;
      mat.opacity = op;
      const wantTransparent = op < 0.985;
      if (mat.transparent !== wantTransparent) {
        mat.transparent = wantTransparent;
        mat.depthWrite = !wantTransparent;
        mat.needsUpdate = true;
      }
    }
    if (casingEdgeRef.current) {
      casingEdgeRef.current.position.y = sy * 0.5 + e * (sy * 1.5 + 1.1);
      const mat = casingEdgeRef.current.material as THREE.LineBasicMaterial;
      mat.opacity = 0.4 + e * 0.5;
    }

    /* --- motor rises slightly and spins at the live RPM --- */
    if (motorRef.current) {
      motorRef.current.position.y = sy * 0.38 + e * 0.34;
      motorRef.current.visible = e > 0.015;
    }
    if (rotorRef.current && e > 0.01) {
      rotorRef.current.rotation.y += machine.jammed ? 0 : (machine.rpm / 90000) * 0.6 + machine.load * 0.04;
    }

    /* --- the core sensor: the point of the whole exercise --- */
    if (sensorRef.current && sensorGlowRef.current) {
      sensorRef.current.visible = e > 0.015;
      sensorGlowRef.current.visible = e > 0.015;

      // Pulses red when this machine is actually faulted, calm teal when not —
      // so an exploded healthy machine does not cry wolf.
      const pulse = faulted ? 0.45 + Math.abs(Math.sin(t * 5.5)) * 0.55 : 0.25 + Math.sin(t * 1.4) * 0.1;
      const glowMat = sensorGlowRef.current.material as THREE.MeshBasicMaterial;
      const coreMat = sensorRef.current.material as THREE.MeshBasicMaterial;

      tmpColor.set(faulted ? '#ff2d4f' : '#0c9183');
      coreMat.color.copy(tmpColor);
      glowMat.color.copy(tmpColor);
      glowMat.opacity = e * pulse * 0.5;

      const s = (1 + pulse * (faulted ? 0.55 : 0.18)) * e;
      sensorGlowRef.current.scale.setScalar(s * 2.4);
      sensorRef.current.scale.setScalar(Math.max(0.001, e));

      if (sensorLightRef.current) {
        sensorLightRef.current.intensity = e * pulse * (faulted ? 14 : 3);
        sensorLightRef.current.color.copy(tmpColor);
      }
    }

    /* ---------- the ordinary floor-level signalling ---------- */
    const strobe = faulted
      ? 0.35 + Math.abs(Math.sin(t * (machine.jammed ? 9 : 7))) * 0.9
      : 0.4 + Math.sin(t * 1.6) * 0.18;
    // The beacon is an unlit basic material, so it reads as a lamp without
    // needing to BE one. Nineteen machines each casting a real point light was
    // measured at ~110ms of GPU time per frame.
    if (beaconRef.current) beaconRef.current.scale.setScalar((0.9 + strobe * 0.5) * (1 - e));
    if (stripeRef.current) {
      const mat = stripeRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 1 - e;
    }

    if (haloRef.current) {
      const s = 1 + machine.load * 0.35 + e * 0.5 + Math.sin(t * 2 + index) * 0.03;
      haloRef.current.scale.set(s, s, s);
      const mat = haloRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = (open ? 0.7 : 0.38) + (faulted ? Math.abs(Math.sin(t * 7)) * 0.3 : 0);
    }

    /* ---------- per-floor fade ---------- */
    const active = useMegnetoStore.getState().activeFloor;
    const onFloor = active === 'all' || active === def.floor;
    const fade = onFloor ? 1 : 0.07;
    const mats = fadeMats.current;
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i] as THREE.Material & { opacity: number };
      // The casing and sensor own their own opacity above; everything else
      // just follows the floor.
      if (m === casingRef.current?.material || m === sensorGlowRef.current?.material) continue;
      const next = THREE.MathUtils.lerp(m.opacity, fade, 0.09);
      m.opacity = next;
      // Opaque unless actually faded — see applyFade in IndustrialEntities.
      const wantTransparent = next < 0.985;
      if (m.transparent !== wantTransparent) {
        m.transparent = wantTransparent;
        m.depthWrite = !wantTransparent;
        m.needsUpdate = true;
      }
    }
    if (groupRef.current) {
      const visible = onFloor || fade > 0.085;
      if (groupRef.current.visible !== visible) groupRef.current.visible = visible;
    }
  });

  return (
    <group
      ref={groupRef}
      position={[def.position[0], elevation + def.position[1], def.position[2]]}
      rotation={[0, def.rotation, 0]}
    >
      {/* ---------- OUTER CASING ---------- */}
      <mesh ref={casingRef} position={[0, sy / 2, 0]} onClick={onClick}>
        <boxGeometry args={[sx, sy, sz]} />
        <meshStandardMaterial
          color={THEME.machineBody}
          roughness={0.46}
          metalness={0.26}
          emissive={STATUS_COLOR.nominal}
          emissiveIntensity={0.04}
          transparent
        />
      </mesh>
      <lineSegments ref={casingEdgeRef} geometry={casingEdges} position={[0, sy / 2, 0]} raycast={() => null}>
        <lineBasicMaterial color={THEME.accent} transparent opacity={0.4} />
      </lineSegments>

      {/* Status stripe on the operator face — hidden once opened. */}
      <mesh ref={stripeRef} position={[0, sy * 0.72, sz / 2 + 0.012]} raycast={() => null}>
        <planeGeometry args={[sx * 0.86, 0.085]} />
        <meshBasicMaterial color={STATUS_COLOR.nominal} transparent toneMapped={false} />
      </mesh>

      {/* ---------- INTERNAL MOTOR ---------- */}
      <group ref={motorRef} position={[0, sy * 0.38, 0]} visible={false}>
        {/* Drive housing */}
        <mesh raycast={() => null}>
          <cylinderGeometry args={[sx * 0.2, sx * 0.2, sy * 0.5, 12]} />
          <meshStandardMaterial color="#8da6c4" metalness={0.78} roughness={0.3} transparent />
        </mesh>
        {/* Rotor — spins at the machine's live RPM */}
        <mesh ref={rotorRef} position={[0, sy * 0.33, 0]} raycast={() => null}>
          <cylinderGeometry args={[sx * 0.13, sx * 0.13, 0.22, 10]} />
          <meshStandardMaterial color="#b9c9d8" metalness={0.85} roughness={0.22} transparent />
        </mesh>
        {/* Belt guard / frame rails, so the interior reads as mechanism */}
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * sx * 0.3, 0, 0]} raycast={() => null}>
            <boxGeometry args={[0.08, sy * 0.62, sz * 0.5]} />
            <meshStandardMaterial color="#6f89a3" metalness={0.6} roughness={0.42} transparent />
          </mesh>
        ))}
      </group>

      {/* ---------- CORE SENSOR ---------- */}
      <mesh ref={sensorRef} position={[0, sy * 0.52, 0]} visible={false} raycast={() => null}>
        <octahedronGeometry args={[0.17, 0]} />
        <meshBasicMaterial color="#0c9183" toneMapped={false} />
      </mesh>
      <mesh ref={sensorGlowRef} position={[0, sy * 0.52, 0]} visible={false} raycast={() => null}>
        <sphereGeometry args={[0.17, 14, 10]} />
        <meshBasicMaterial
          color="#0c9183"
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      {isOpen && (
        <pointLight ref={sensorLightRef} position={[0, sy * 0.52, 0]} distance={5} intensity={0} color="#ff2d4f" />
      )}

      {/* ---------- FLOOR-LEVEL SIGNALLING ---------- */}
      <mesh ref={beaconRef} position={[sx / 2 - 0.16, sy + 0.42, sz / 2 - 0.16]} raycast={() => null}>
        <sphereGeometry args={[0.095, 10, 8]} />
        <meshBasicMaterial color={STATUS_COLOR.nominal} transparent toneMapped={false} />
      </mesh>
      <mesh ref={haloRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.018, 0]} raycast={() => null}>
        <ringGeometry args={[Math.max(sx, sz) * 0.62, Math.max(sx, sz) * 0.78, 36]} />
        <meshBasicMaterial color={STATUS_COLOR.nominal} transparent opacity={0.38} toneMapped={false} />
      </mesh>
    </group>
  );
}

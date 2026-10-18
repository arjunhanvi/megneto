'use client';

/**
 * THE FLOOR — machines, the instanced mob, and the environmental apparatus.
 *
 * Pure three.js geometry. Every pixel of UI that sits on top of these objects
 * lives in `FacilityOverlay.tsx` as projected DOM, so nothing here mounts a
 * React DOM root inside the canvas.
 *
 * The discipline: React decides WHAT exists, `useFrame` decides what it LOOKS
 * like. Status colours, strobes, load halos and warning auras are read straight
 * out of the mutable simulation world and written onto object3D refs by hand.
 *
 * The only state changes that reach React are "a node was clicked" and "the
 * pointer moved onto a different operator" — both human-paced, and both
 * short-circuited inside the store when the value has not actually changed.
 *
 * Two things here are interactive in a way that matters:
 *   · a JAMMED machine does not self-clear — clicking it dispatches the floor,
 *     and the machine restarts cold with a backed-up queue;
 *   · an ALERTING environmental node applies a real control change when
 *     clicked — more extraction, a re-centred humidity setpoint, load shed —
 *     and the physics then has to converge at the rate the model allows.
 */

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';

import {
  MAX_RENDERED_OPERATORS,
  SITES,
  STATUS_COLOR,
  STATUS_COLOR_HEX,
  floorElevation,
  type EnvNodeDef,
  type FloorIndex,
  type MachineDef,
  type MachineStatus,
  type SiteId,
} from '@/lib/sites';
import { THEME, THEME_HEX } from '@/lib/theme';
import { getSite, useMegnetoStore } from '@/store/useMegnetoStore';

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();

const OPERATOR_STATE_COLOR = [
  new THREE.Color('#1a8fd1'), // 0 transit
  new THREE.Color('#0c9183'), // 1 at station
  new THREE.Color('#c57600'), // 2 on break
];

/* ========================================================================== */
/* FLOOR FADE — shared by machines and apparatus                              */
/* ========================================================================== */

/**
 * Collects a subtree's materials ONCE and lerps their opacity toward whatever
 * the active floor selection implies. Mutation only: nothing here re-renders
 * when the user picks a different level, which matters because there are
 * nineteen machines and the user will click through the levels repeatedly.
 */
function useFloorFade(groupRef: React.RefObject<THREE.Group | null>, floor: FloorIndex) {
  const mats = useRef<THREE.Material[]>([]);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const out: THREE.Material[] = [];
    group.traverse((obj) => {
      const withMat = obj as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
      if (!withMat.material) return;
      const list = Array.isArray(withMat.material) ? withMat.material : [withMat.material];
      for (const m of list) {
        m.transparent = true;
        out.push(m);
      }
    });
    mats.current = out;
  }, [groupRef]);

  useFrame(() => {
    const active = useMegnetoStore.getState().activeFloor;
    const on = active === 'all' || active === floor;
    const target = on ? 1 : 0.07;
    const list = mats.current;
    if (list.length === 0) return;
    for (const m of list) m.opacity = THREE.MathUtils.lerp(m.opacity, target, 0.09);
    const group = groupRef.current;
    if (group) {
      // A fully faded machine stops drawing AND stops being clickable, so you
      // can never pick something through the floor you are standing on.
      const visible = list[0].opacity > 0.085;
      if (group.visible !== visible) group.visible = visible;
    }
  });
}

/* ========================================================================== */
/* THE MOB — instanced operators                                              */
/* ========================================================================== */

export const Operators = memo(function Operators({ siteId }: { siteId: SiteId }) {
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const headRef = useRef<THREE.InstancedMesh>(null);
  const ringRef = useRef<THREE.InstancedMesh>(null);
  const lastState = useRef<Uint8Array>(new Uint8Array(MAX_RENDERED_OPERATORS).fill(255));

  const hoverOperator = useMegnetoStore((s) => s.hoverOperator);
  const site = getSite(siteId);
  const liveCount = site.operators.length;

  useEffect(() => {
    // Park the unused tail instances far below the slab, once.
    const body = bodyRef.current;
    const head = headRef.current;
    const ring = ringRef.current;
    if (!body || !head || !ring) return;
    dummy.position.set(0, -500, 0);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(0.001);
    dummy.updateMatrix();
    for (let i = liveCount; i < MAX_RENDERED_OPERATORS; i++) {
      body.setMatrixAt(i, dummy.matrix);
      head.setMatrixAt(i, dummy.matrix);
      ring.setMatrixAt(i, dummy.matrix);
    }
    body.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
    ring.instanceMatrix.needsUpdate = true;
    lastState.current.fill(255);
  }, [liveCount, siteId]);

  useFrame(({ clock }) => {
    const body = bodyRef.current;
    const head = headRef.current;
    const ring = ringRef.current;
    if (!body || !head || !ring) return;

    const s = getSite(siteId);
    const { positions, headings, states } = s;
    const t = clock.elapsedTime;
    const hoverIdx = useMegnetoStore.getState().hoveredOperatorIndex;

    const activeFloor = useMegnetoStore.getState().activeFloor;

    for (let i = 0; i < liveCount; i++) {
      const o = i * 3;
      const x = positions[o];
      const y = positions[o + 1];
      const z = positions[o + 2];
      const isHovered = i === hoverIdx;

      // Isolating a level parks everyone on the other levels at zero scale.
      // Per-instance opacity would need a custom shader; a scale of nothing is
      // free, and the matrices are already being written this frame anyway.
      const onFloor = activeFloor === 'all' || s.operators[i]?.floor === activeFloor;
      if (!onFloor) {
        dummy.position.set(x, y, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        body.setMatrixAt(i, dummy.matrix);
        head.setMatrixAt(i, dummy.matrix);
        ring.setMatrixAt(i, dummy.matrix);
        continue;
      }

      const lift = isHovered ? 1.07 : 1;

      // `y` is slab elevation + walking bob. Split them, because the helmet
      // exaggerates the bob and the floor ring must ignore it entirely —
      // scaling the whole thing would send operators through the ceiling.
      const slabY = floorElevation(s.def, s.operators[i].floor);
      const bob = y - slabY;

      dummy.position.set(x, slabY + 0.56 + bob, z);
      dummy.rotation.set(0, headings[i], 0);
      dummy.scale.set(lift, lift, lift);
      dummy.updateMatrix();
      body.setMatrixAt(i, dummy.matrix);

      dummy.position.set(x, slabY + 1.08 + bob * 1.3, z);
      dummy.scale.setScalar(lift);
      dummy.updateMatrix();
      head.setMatrixAt(i, dummy.matrix);

      // Floor beacon: breathes while working, spins while hovered, and flares
      // with the operator's heat/solvent strain.
      const strain = s.operators[i]?.strain ?? 0;
      const pulse = states[i] === 1 ? 1 + Math.sin(t * 3 + i) * 0.14 : 1;
      dummy.position.set(x, slabY + 0.022, z);
      dummy.rotation.set(-Math.PI / 2, 0, isHovered ? t * 1.6 : 0);
      dummy.scale.setScalar(pulse * (isHovered ? 1.5 : 1) * (1 + strain * 0.5));
      dummy.updateMatrix();
      ring.setMatrixAt(i, dummy.matrix);

      // Colour upload only on an actual state transition.
      const st = states[i];
      if (lastState.current[i] !== st) {
        lastState.current[i] = st;
        const c = OPERATOR_STATE_COLOR[st] ?? OPERATOR_STATE_COLOR[0];
        body.setColorAt(i, c);
        ring.setColorAt(i, c);
        if (body.instanceColor) body.instanceColor.needsUpdate = true;
        if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
      }
    }

    body.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
    ring.instanceMatrix.needsUpdate = true;
  });

  const onMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      const id = e.instanceId;
      if (id == null || id >= liveCount) return;
      hoverOperator(id); // the store short-circuits when unchanged
    },
    [hoverOperator, liveCount],
  );

  const onOut = useCallback(() => hoverOperator(null), [hoverOperator]);

  return (
    <group>
      <instancedMesh
        ref={bodyRef}
        args={[
          undefined as unknown as THREE.BufferGeometry,
          undefined as unknown as THREE.Material,
          MAX_RENDERED_OPERATORS,
        ]}
        frustumCulled={false}
        onPointerMove={onMove}
        onPointerOut={onOut}
      >
        <capsuleGeometry args={[0.19, 0.5, 4, 10]} />
        <meshStandardMaterial color="#ffffff" roughness={0.46} metalness={0.06} />
      </instancedMesh>

      <instancedMesh
        ref={headRef}
        args={[
          undefined as unknown as THREE.BufferGeometry,
          undefined as unknown as THREE.Material,
          MAX_RENDERED_OPERATORS,
        ]}
        frustumCulled={false}
        raycast={() => null}
      >
        <sphereGeometry args={[0.145, 12, 10]} />
        <meshStandardMaterial color={THEME.helmet} roughness={0.52} metalness={0.04} />
      </instancedMesh>

      <instancedMesh
        ref={ringRef}
        args={[
          undefined as unknown as THREE.BufferGeometry,
          undefined as unknown as THREE.Material,
          MAX_RENDERED_OPERATORS,
        ]}
        frustumCulled={false}
        raycast={() => null}
      >
        <ringGeometry args={[0.26, 0.34, 20]} />
        <meshBasicMaterial color={THEME.accent} transparent opacity={0.72} toneMapped={false} />
      </instancedMesh>
    </group>
  );
});

/* ========================================================================== */
/* WARNING AURA — the shared "this needs a human" volume                      */
/* ========================================================================== */

/**
 * A soft additive shell. Two of these on screen read as a localized hazard
 * volume without a particle system, a shader pass or a single extra texture.
 */
function Aura({
  radius,
  color,
  active,
  height = 1,
}: {
  radius: number;
  color: string;
  active: () => boolean;
  height?: number;
}) {
  const shellRef = useRef<THREE.Mesh>(null);
  const discRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const on = active();
    const t = clock.elapsedTime;

    if (shellRef.current) {
      const mat = shellRef.current.material as THREE.MeshBasicMaterial;
      const target = on ? 0.17 + Math.abs(Math.sin(t * 2.1)) * 0.16 : 0;
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, target, 0.12);
      shellRef.current.visible = mat.opacity > 0.01;
      const s = on ? 1 + Math.sin(t * 2.1) * 0.06 : 1;
      shellRef.current.scale.set(s, s, s);
    }

    if (discRef.current) {
      const mat = discRef.current.material as THREE.MeshBasicMaterial;
      const target = on ? 0.3 + Math.abs(Math.sin(t * 3.4)) * 0.3 : 0;
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, target, 0.14);
      discRef.current.visible = mat.opacity > 0.01;
      // An expanding ripple on the floor: unmissable from the isometric view.
      const ripple = 1 + ((t * 0.55) % 1) * 0.85;
      discRef.current.scale.set(ripple, ripple, ripple);
    }
  });

  return (
    <group raycast={() => null}>
      <mesh ref={shellRef} position={[0, height * 0.55, 0]} raycast={() => null}>
        <sphereGeometry args={[radius, 16, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
          side={THREE.BackSide}
        />
      </mesh>
      <mesh ref={discRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} raycast={() => null}>
        <ringGeometry args={[radius * 0.62, radius * 0.78, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ========================================================================== */
/* MACHINES                                                                   */
/* ========================================================================== */

export const Machines = memo(function Machines({ siteId }: { siteId: SiteId }) {
  const def = SITES[siteId];
  return (
    <group>
      {def.machines.map((m, i) => (
        <MachineNode key={m.id} siteId={siteId} def={m} index={i} />
      ))}
    </group>
  );
});

function MachineNode({ siteId, def, index }: { siteId: SiteId; def: MachineDef; index: number }) {
  const groupRef = useRef<THREE.Group>(null);
  const shellRef = useRef<THREE.Mesh>(null);
  const beaconRef = useRef<THREE.Mesh>(null);
  const stripeRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const spindleRef = useRef<THREE.Mesh>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const lastStatus = useRef<MachineStatus | null>(null);

  const selected = useMegnetoStore((s) => s.selectedMachineId === def.id);
  const actOnMachine = useMegnetoStore((s) => s.actOnMachine);

  const chassisEdges = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(def.size[0], def.size[1], def.size[2])),
    [def.size],
  );
  useEffect(() => () => chassisEdges.dispose(), [chassisEdges]);

  useFloorFade(groupRef, def.floor);

  const isJammed = useCallback(() => {
    const m = getSite(siteId).machines.find((x) => x.def.id === def.id);
    return Boolean(m?.jammed);
  }, [siteId, def.id]);

  useFrame(({ clock }) => {
    const machine = getSite(siteId).machines.find((m) => m.def.id === def.id);
    if (!machine) return;
    const t = clock.elapsedTime;

    if (lastStatus.current !== machine.status) {
      lastStatus.current = machine.status;
      tmpColor.setHex(STATUS_COLOR_HEX[machine.status]);

      const shellMat = shellRef.current?.material as THREE.MeshStandardMaterial | undefined;
      if (shellMat) {
        // Keep the chassis reading as painted steel. Status is told by the
        // beacon, the halo and the stripe — not by dyeing the whole machine.
        shellMat.emissive.copy(tmpColor);
        shellMat.emissiveIntensity = machine.status === 'nominal' ? 0.04 : 0.24;
      }
      const stripeMat = stripeRef.current?.material as THREE.MeshBasicMaterial | undefined;
      if (stripeMat) stripeMat.color.copy(tmpColor);
      const beaconMat = beaconRef.current?.material as THREE.MeshBasicMaterial | undefined;
      if (beaconMat) beaconMat.color.copy(tmpColor);
      const haloMat = haloRef.current?.material as THREE.MeshBasicMaterial | undefined;
      if (haloMat) haloMat.color.copy(tmpColor);
      if (lightRef.current) lightRef.current.color.copy(tmpColor);
    }

    const faulted = machine.status === 'warning' || machine.status === 'critical' || machine.jammed;
    const strobe = faulted ? 0.35 + Math.abs(Math.sin(t * (machine.jammed ? 9 : 7))) * 0.9 : 0.4 + Math.sin(t * 1.6) * 0.18;
    if (beaconRef.current) beaconRef.current.scale.setScalar(0.9 + strobe * 0.5);
    if (lightRef.current) lightRef.current.intensity = (faulted ? 5.5 : 1.6) * strobe;

    if (haloRef.current) {
      const s = 1 + machine.load * 0.35 + (selected ? 0.3 : 0) + Math.sin(t * 2 + index) * 0.03;
      haloRef.current.scale.set(s, s, s);
      const mat = haloRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = (selected ? 0.62 : 0.38) + (faulted ? Math.abs(Math.sin(t * 7)) * 0.3 : 0);
    }

    // The moving part stops dead when the machine jams — the clearest possible
    // signal that the line is down.
    if (spindleRef.current) {
      spindleRef.current.rotation.y += machine.jammed ? 0 : (machine.rpm / 90000) * 0.5 + machine.load * 0.03;
    }
  });

  const onClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      // Clicking a jammed machine dispatches the floor and clears it; clicking
      // a healthy one just opens diagnostics.
      actOnMachine(def.id);
    },
    [def.id, actOnMachine],
  );

  const [sx, sy, sz] = def.size;

  const elevation = floorElevation(SITES[siteId], def.floor);

  return (
    <group
      ref={groupRef}
      position={[def.position[0], elevation + def.position[1], def.position[2]]}
      rotation={[0, def.rotation, 0]}
    >
      <mesh ref={shellRef} position={[0, sy / 2, 0]} onClick={onClick}>
        <boxGeometry args={[sx, sy, sz]} />
        <meshStandardMaterial
          color={THEME.machineBody}
          roughness={0.46}
          metalness={0.26}
          emissive={STATUS_COLOR.nominal}
          emissiveIntensity={0.04}
        />
      </mesh>

      {/* Status stripe across the operator face: the colour cue that survives
          being shrunk to thumbnail size on a projector. */}
      <mesh ref={stripeRef} position={[0, sy * 0.72, sz / 2 + 0.012]} raycast={() => null}>
        <planeGeometry args={[sx * 0.86, 0.085]} />
        <meshBasicMaterial color={STATUS_COLOR.nominal} toneMapped={false} />
      </mesh>

      <lineSegments geometry={chassisEdges} position={[0, sy / 2, 0]} raycast={() => null}>
        <lineBasicMaterial color={THEME.accent} transparent opacity={selected ? 0.9 : 0.4} />
      </lineSegments>

      <mesh ref={spindleRef} position={[0, sy + 0.16, 0]} raycast={() => null}>
        <cylinderGeometry args={[0.16, 0.22, 0.32, 10]} />
        <meshStandardMaterial color={THEME.machineTrim} metalness={0.7} roughness={0.34} />
      </mesh>

      <mesh ref={beaconRef} position={[sx / 2 - 0.16, sy + 0.42, sz / 2 - 0.16]} raycast={() => null}>
        <sphereGeometry args={[0.095, 10, 8]} />
        <meshBasicMaterial color={STATUS_COLOR.nominal} toneMapped={false} />
      </mesh>
      <pointLight
        ref={lightRef}
        position={[0, sy + 0.5, 0]}
        distance={4.2}
        intensity={1.6}
        color={STATUS_COLOR.nominal}
      />

      <mesh ref={haloRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.018, 0]} raycast={() => null}>
        <ringGeometry args={[Math.max(sx, sz) * 0.62, Math.max(sx, sz) * 0.78, 36]} />
        <meshBasicMaterial color={STATUS_COLOR.nominal} transparent opacity={0.38} toneMapped={false} />
      </mesh>

      {/* A jam needs a human. The aura says so from across the room. */}
      <Aura radius={Math.max(sx, sz) * 0.95} height={sy} color={STATUS_COLOR.jammed} active={isJammed} />
    </group>
  );
}

/* ========================================================================== */
/* ENVIRONMENTAL APPARATUS                                                    */
/* ========================================================================== */

export const EnvNodes = memo(function EnvNodes({ siteId }: { siteId: SiteId }) {
  const def = SITES[siteId];
  return (
    <group>
      {def.envNodes.map((n) => (
        <EnvNode key={n.id} siteId={siteId} def={n} />
      ))}
    </group>
  );
});

/** Each apparatus gets a silhouette you could recognise on a real site visit. */
function EnvGeometry({ def }: { def: EnvNodeDef }) {
  const [sx, sy, sz] = def.size;

  switch (def.kind) {
    case 'zld':
      // Pressure vessels: horizontal membrane tubes, or a tall evaporator body.
      return def.id.includes('MEE') ? (
        <group>
          <mesh position={[0, sy / 2, 0]}>
            <cylinderGeometry args={[sx * 0.42, sx * 0.42, sy, 18]} />
            <meshStandardMaterial color="#dfe9f2" roughness={0.42} metalness={0.5} />
          </mesh>
          <mesh position={[0, sy + 0.18, 0]} raycast={() => null}>
            <cylinderGeometry args={[sx * 0.2, sx * 0.2, 0.36, 12]} />
            <meshStandardMaterial color={THEME.machineTrim} roughness={0.5} metalness={0.6} />
          </mesh>
        </group>
      ) : (
        <group>
          {[0, 1, 2].map((i) => (
            <mesh key={i} position={[0, 0.5 + i * 0.62, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.26, 0.26, sz * 0.96, 14]} />
              <meshStandardMaterial color="#e6eef6" roughness={0.4} metalness={0.55} />
            </mesh>
          ))}
          <mesh position={[0, 0.2, 0]} raycast={() => null}>
            <boxGeometry args={[sx * 0.9, 0.4, sz * 0.9]} />
            <meshStandardMaterial color={THEME.machineTrim} roughness={0.7} metalness={0.2} />
          </mesh>
        </group>
      );

    case 'dyevat':
      return (
        <group>
          <mesh position={[0, sy / 2, 0]}>
            <boxGeometry args={[sx, sy, sz]} />
            <meshStandardMaterial color="#e9eef4" roughness={0.5} metalness={0.3} />
          </mesh>
          {/* Steam header running along the top. */}
          <mesh position={[0, sy + 0.22, 0]} rotation={[0, 0, Math.PI / 2]} raycast={() => null}>
            <cylinderGeometry args={[0.12, 0.12, sx * 1.1, 10]} />
            <meshStandardMaterial color="#b9c9d8" roughness={0.35} metalness={0.75} />
          </mesh>
        </group>
      );

    case 'humidity':
      return (
        <group>
          <mesh position={[0, sy / 2, 0]}>
            <boxGeometry args={[sx, sy, sz]} />
            <meshStandardMaterial color="#eaf2f9" roughness={0.6} metalness={0.15} />
          </mesh>
          {/* Fogging nozzles. */}
          {[-0.5, 0, 0.5].map((o, i) => (
            <mesh key={i} position={[o * sx * 0.6, sy + 0.16, 0]} raycast={() => null}>
              <coneGeometry args={[0.1, 0.26, 8]} />
              <meshStandardMaterial color={THEME.accent} roughness={0.4} metalness={0.4} />
            </mesh>
          ))}
        </group>
      );

    case 'voc':
      return (
        <group>
          <mesh position={[0, sy * 0.4, 0]}>
            <cylinderGeometry args={[sx * 0.45, sx * 0.45, sy * 0.8, 16]} />
            <meshStandardMaterial color="#e4ecf4" roughness={0.45} metalness={0.45} />
          </mesh>
          {/* Exhaust stack. */}
          <mesh position={[0, sy * 0.95, 0]} raycast={() => null}>
            <cylinderGeometry args={[0.2, 0.26, sy * 0.5, 12]} />
            <meshStandardMaterial color={THEME.machineTrim} roughness={0.4} metalness={0.65} />
          </mesh>
        </group>
      );

    case 'dust':
      return (
        <group>
          {/* Cyclone body: the cone is the recognisable part. */}
          <mesh position={[0, sy * 0.62, 0]}>
            <cylinderGeometry args={[sx * 0.4, sx * 0.4, sy * 0.5, 16]} />
            <meshStandardMaterial color="#e8eef5" roughness={0.5} metalness={0.4} />
          </mesh>
          <mesh position={[0, sy * 0.22, 0]} raycast={() => null}>
            <coneGeometry args={[sx * 0.4, sy * 0.45, 16]} />
            <meshStandardMaterial color="#d9e4ee" roughness={0.55} metalness={0.35} />
          </mesh>
        </group>
      );

    case 'power':
    default:
      return (
        <group>
          <mesh position={[0, sy / 2, 0]}>
            <boxGeometry args={[sx, sy, sz]} />
            <meshStandardMaterial color="#e3ebf3" roughness={0.55} metalness={0.35} />
          </mesh>
          {/* Bushings. */}
          {[-0.35, 0, 0.35].map((o, i) => (
            <mesh key={i} position={[o * sx, sy + 0.24, 0]} raycast={() => null}>
              <cylinderGeometry args={[0.09, 0.13, 0.46, 10]} />
              <meshStandardMaterial color="#b0c2d2" roughness={0.3} metalness={0.8} />
            </mesh>
          ))}
        </group>
      );
  }
}

function EnvNode({ siteId, def }: { siteId: SiteId; def: EnvNodeDef }) {
  const outerRef = useRef<THREE.Group>(null);
  const groupRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const beaconRef = useRef<THREE.Mesh>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const lastStatus = useRef<MachineStatus | null>(null);

  const selected = useMegnetoStore((s) => s.selectedEnvNodeId === def.id);
  const actOnEnvNode = useMegnetoStore((s) => s.actOnEnvNode);

  useFloorFade(outerRef, def.floor);

  const isAlerting = useCallback(() => {
    const n = getSite(siteId).envNodes.find((x) => x.def.id === def.id);
    return Boolean(n?.alert);
  }, [siteId, def.id]);

  useFrame(({ clock }) => {
    const node = getSite(siteId).envNodes.find((n) => n.def.id === def.id);
    if (!node) return;
    const t = clock.elapsedTime;

    if (lastStatus.current !== node.status) {
      lastStatus.current = node.status;
      tmpColor.setHex(STATUS_COLOR_HEX[node.status]);
      const haloMat = haloRef.current?.material as THREE.MeshBasicMaterial | undefined;
      if (haloMat) haloMat.color.copy(tmpColor);
      const beaconMat = beaconRef.current?.material as THREE.MeshBasicMaterial | undefined;
      if (beaconMat) beaconMat.color.copy(tmpColor);
      if (lightRef.current) lightRef.current.color.copy(tmpColor);
    }

    const faulted = node.status === 'warning' || node.status === 'critical';
    const strobe = faulted ? 0.35 + Math.abs(Math.sin(t * 6)) * 0.9 : 0.42 + Math.sin(t * 1.4) * 0.16;
    if (beaconRef.current) beaconRef.current.scale.setScalar(0.9 + strobe * 0.55);
    if (lightRef.current) lightRef.current.intensity = (faulted ? 6 : 1.4) * strobe;

    if (haloRef.current) {
      const mat = haloRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = (selected ? 0.6 : 0.34) + (faulted ? Math.abs(Math.sin(t * 6)) * 0.34 : 0);
    }

    // Apparatus under load works visibly harder.
    if (groupRef.current) {
      const duty = THREE.MathUtils.clamp(node.primary / Math.max(1, node.primary + node.secondary), 0, 1);
      groupRef.current.position.y = Math.sin(t * 6) * 0.004 * (faulted ? 3 : 1) * (0.4 + duty);
    }
  });

  const onClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      // Applies the real control change when the node is alerting.
      actOnEnvNode(def.id);
    },
    [def.id, actOnEnvNode],
  );

  const [sx, sy, sz] = def.size;

  const elevation = floorElevation(SITES[siteId], def.floor);

  return (
    <group ref={outerRef} position={[def.position[0], elevation + def.position[1], def.position[2]]}>
      <group ref={groupRef} onClick={onClick}>
        <EnvGeometry def={def} />
      </group>

      <mesh ref={beaconRef} position={[sx / 2 - 0.1, sy + 0.5, sz / 2 - 0.1]} raycast={() => null}>
        <sphereGeometry args={[0.1, 10, 8]} />
        <meshBasicMaterial color={STATUS_COLOR.nominal} toneMapped={false} />
      </mesh>
      <pointLight ref={lightRef} position={[0, sy + 0.6, 0]} distance={5} intensity={1.4} color={STATUS_COLOR.nominal} />

      <mesh ref={haloRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} raycast={() => null}>
        <ringGeometry args={[Math.max(sx, sz) * 0.7, Math.max(sx, sz) * 0.88, 40]} />
        <meshBasicMaterial color={STATUS_COLOR.nominal} transparent opacity={0.34} toneMapped={false} />
      </mesh>

      {/* The hazard volume. This is the thing that makes an environmental
          excursion impossible to miss from the isometric view. */}
      <Aura
        radius={Math.max(sx, sz) * 1.25}
        height={sy}
        color={def.kind === 'voc' ? '#8a5fd0' : def.kind === 'dust' ? '#b08640' : '#d13a57'}
        active={isAlerting}
      />
    </group>
  );
}

/* ========================================================================== */
/* STATIC DRESSING                                                            */
/* ========================================================================== */

export const Pallets = memo(function Pallets({ siteId }: { siteId: SiteId }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const def = SITES[siteId];

  /** Deterministic stacks tucked into the corners of each zone, per level. */
  const slots = useMemo(() => {
    const out: { pos: [number, number, number]; floor: FloorIndex }[] = [];
    def.zones.forEach((zone, zi) => {
      const [minX, minZ, maxX, maxZ] = zone.bounds;
      const count = 2 + (zi % 3);
      const y = floorElevation(def, zone.floor);
      for (let i = 0; i < count; i++) {
        const x = minX + 1.1 + ((i * 1.3 + zi * 0.5) % Math.max(1, maxX - minX - 2.4));
        const z = zi % 2 === 0 ? minZ + 1.0 : maxZ - 1.0;
        out.push({ pos: [x, y, z], floor: zone.floor });
      }
    });
    return out;
  }, [def]);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    slots.forEach((slot, i) => {
      const p = slot.pos;
      const h = 0.36 + ((i * 37) % 5) * 0.13;
      dummy.position.set(p[0], p[1] + h / 2, p[2]);
      dummy.rotation.set(0, ((i * 53) % 8) * 0.22, 0);
      dummy.scale.set(1, h / 0.5, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      tmpColor.setHex(THEME_HEX.pallets[i % 3]);
      mesh.setColorAt(i, tmpColor);
    });
    mesh.count = slots.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [slots]);

  // Isolating a level parks the other levels' stacks at zero scale.
  const lastFloor = useRef<string>('');
  useFrame(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const active = String(useMegnetoStore.getState().activeFloor);
    if (active === lastFloor.current) return;
    lastFloor.current = active;
    slots.forEach((slot, i) => {
      const on = active === 'all' || Number(active) === slot.floor;
      const h = 0.36 + ((i * 37) % 5) * 0.13;
      const p = slot.pos;
      dummy.position.set(p[0], p[1] + h / 2, p[2]);
      dummy.rotation.set(0, ((i * 53) % 8) * 0.22, 0);
      if (on) dummy.scale.set(1, h / 0.5, 1);
      else dummy.scale.setScalar(0.0001);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={ref}
      args={[
        undefined as unknown as THREE.BufferGeometry,
        undefined as unknown as THREE.Material,
        Math.max(1, slots.length),
      ]}
      frustumCulled={false}
      raycast={() => null}
    >
      <boxGeometry args={[0.82, 0.5, 0.82]} />
      <meshStandardMaterial color="#ffffff" roughness={0.9} metalness={0.04} />
    </instancedMesh>
  );
});

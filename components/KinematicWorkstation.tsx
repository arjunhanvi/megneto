'use client';

/**
 * KINEMATIC ACTION RECOGNITION — the macro lens
 *
 * ============================================================================
 * THE CLAIM THIS COMPONENT HAS TO EARN
 * ============================================================================
 * "We count products by watching the machine move, not by running a timer."
 *
 * An investor is right to be sceptical of that, because the easy way to build
 * this demo is a timer with an animation bolted on. So the wiring here is
 * deliberately the other way round:
 *
 *   `machine.kin` is a phase accumulator in the store, advanced per frame by
 *   `strokeHz`. The needle's Y position is read from it. The progress ring is
 *   read from it. The output counter is incremented from it. One variable,
 *   three consumers.
 *
 * Nothing in this file owns any state about production. It renders a readout
 * of a number the physics is maintaining. Which is why, when a machine jams,
 * the needle stops mid-air and the ring freezes at whatever fraction it had
 * reached — there is no second code path that could keep counting.
 *
 * To prove it live: jam the machine from the console and watch both stop on
 * the same frame.
 *
 *   __megneto.world.sites.tiruppur.machines[12].jammed = true
 * ============================================================================
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';

import { KINEMATICS, SITES, floorElevation, type MachineDef, type SiteId } from '@/lib/sites';
import { THEME } from '@/lib/theme';
import { getSite, useMegnetoStore } from '@/store/useMegnetoStore';

/** The AI tracker's box colour: nominal lock vs lost lock. */
const LOCK_COLOR = new THREE.Color('#1a8fd1');
const LOST_COLOR = new THREE.Color('#d13a57');

const tmp = new THREE.Color();

/* -------------------------------------------------------------------------- */
/* The moving part                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Four mechanisms, one phase input. Each reads `kin` (0..1 through one stroke)
 * and converts it to the motion that kind of machine actually performs.
 */
function MovingPart({
  siteId,
  def,
  onPhase,
}: {
  siteId: SiteId;
  def: MachineDef;
  /** Reports phase + lock state upward each frame, by ref, never by state. */
  onPhase: (kin: number, moving: boolean) => void;
}) {
  const profile = KINEMATICS[def.kind];
  const partRef = useRef<THREE.Group>(null);
  const boxRef = useRef<THREE.LineSegments>(null);
  const trailRef = useRef<THREE.Mesh>(null);

  const [sx, sy, sz] = def.size;

  /** Tracker box geometry, sized to the moving part's sweep. */
  const boxGeometry = useMemo(() => {
    const w = profile.kind === 'needle' ? 0.46 : Math.min(sx, sz) * 0.78;
    const h = profile.kind === 'needle' ? 1.25 : Math.min(sx, sz) * 0.78;
    return new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, w));
  }, [profile.kind, sx, sz]);
  useEffect(() => () => boxGeometry.dispose(), [boxGeometry]);

  useFrame(() => {
    const machine = getSite(siteId).machines.find((m) => m.def.id === def.id);
    const part = partRef.current;
    if (!machine || !part) return;

    const kin = machine.kin;
    const moving = machine.strokeHz > 0.001;
    onPhase(kin, moving);

    switch (profile.kind) {
      case 'needle': {
        // A needle bar is not a sine wave: it snaps down and eases back. Fast
        // on the stitch, slower on the return, which is what makes the motion
        // read as a sewing machine rather than a metronome.
        const down = kin < 0.42 ? Math.pow(kin / 0.42, 0.7) : 1 - Math.pow((kin - 0.42) / 0.58, 1.6);
        part.position.y = sy * 0.78 - down * 0.52;
        break;
      }
      case 'roller':
        // Impression cylinders turn about the press's long axis.
        part.rotation.z = -kin * Math.PI * 2;
        break;
      case 'rotary':
        part.rotation.y = kin * Math.PI * 2;
        break;
      case 'gantry': {
        // A traverse runs out and back: triangle wave, not saw, or the head
        // would teleport home every stroke.
        const tri = kin < 0.5 ? kin * 2 : 2 - kin * 2;
        part.position.x = (tri - 0.5) * sx * 0.6;
        break;
      }
    }

    /* ---- the tracker box follows the part and reports lock ---- */
    if (boxRef.current) {
      boxRef.current.position.copy(part.position);
      boxRef.current.rotation.copy(part.rotation);
      const mat = boxRef.current.material as THREE.LineBasicMaterial;
      tmp.copy(moving ? LOCK_COLOR : LOST_COLOR);
      mat.color.lerp(tmp, 0.2);
      // A tracker that has lost its subject blinks; a locked one is steady.
      mat.opacity = moving ? 0.95 : 0.35 + Math.abs(Math.sin(performance.now() * 0.006)) * 0.6;
    }

    /* ---- motion trail: makes a fast stroke legible at 60fps ---- */
    if (trailRef.current) {
      const mat = trailRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = moving ? 0.16 + Math.sin(kin * Math.PI) * 0.16 : 0;
      trailRef.current.visible = mat.opacity > 0.01;
    }
  });

  return (
    <group>
      {/* The part itself */}
      <group ref={partRef} position={[0, profile.kind === 'needle' ? sy * 0.78 : sy * 0.55, 0]}>
        {profile.kind === 'needle' && (
          <>
            {/* bar */}
            <mesh raycast={() => null}>
              <boxGeometry args={[0.1, 0.78, 0.1]} />
              <meshStandardMaterial color="#8da6c4" metalness={0.85} roughness={0.22} />
            </mesh>
            {/* needle */}
            <mesh position={[0, -0.5, 0]} raycast={() => null}>
              <cylinderGeometry args={[0.014, 0.008, 0.3, 6]} />
              <meshStandardMaterial color="#e8eef5" metalness={0.95} roughness={0.1} />
            </mesh>
            {/* presser foot */}
            <mesh position={[0, -0.66, 0]} raycast={() => null}>
              <boxGeometry args={[0.16, 0.05, 0.22]} />
              <meshStandardMaterial color="#6f89a3" metalness={0.7} roughness={0.35} />
            </mesh>
          </>
        )}

        {(profile.kind === 'roller' || profile.kind === 'rotary') && (
          <>
            <mesh
              rotation={profile.kind === 'roller' ? [0, 0, Math.PI / 2] : [0, 0, 0]}
              raycast={() => null}
            >
              <cylinderGeometry args={[Math.min(sx, sz) * 0.3, Math.min(sx, sz) * 0.3, sx * 0.72, 20]} />
              <meshStandardMaterial color="#9fb6cc" metalness={0.8} roughness={0.28} />
            </mesh>
            {/* Keyway stripe, so rotation is actually visible on a smooth cylinder. */}
            <mesh
              position={profile.kind === 'roller' ? [0, Math.min(sx, sz) * 0.3, 0] : [Math.min(sx, sz) * 0.3, 0, 0]}
              raycast={() => null}
            >
              <boxGeometry args={[sx * 0.72, 0.03, 0.08]} />
              <meshBasicMaterial color={THEME.accent} toneMapped={false} />
            </mesh>
          </>
        )}

        {profile.kind === 'gantry' && (
          <mesh raycast={() => null}>
            <boxGeometry args={[0.34, 0.26, Math.min(sz, 1.2)]} />
            <meshStandardMaterial color="#8da6c4" metalness={0.75} roughness={0.3} />
          </mesh>
        )}
      </group>

      {/* Motion trail */}
      <mesh
        ref={trailRef}
        position={[0, profile.kind === 'needle' ? sy * 0.52 : sy * 0.55, 0]}
        raycast={() => null}
      >
        {profile.kind === 'needle' ? (
          <boxGeometry args={[0.07, 0.56, 0.07]} />
        ) : (
          <sphereGeometry args={[Math.min(sx, sz) * 0.34, 12, 8]} />
        )}
        <meshBasicMaterial color={THEME.accent} transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>

      {/* ---- the AI tracker box ---- */}
      <lineSegments ref={boxRef} geometry={boxGeometry} raycast={() => null}>
        <lineBasicMaterial color={LOCK_COLOR} transparent opacity={0.95} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Public                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mounted only for the machine currently under the macro lens. Everything
 * else on the floor keeps running; this just adds the visible mechanism and
 * the tracker on top of the machine that is being inspected.
 */
export default function KinematicWorkstation({ siteId }: { siteId: SiteId }) {
  const machineId = useMegnetoStore((s) => s.kinematicMachineId);
  const def = useMemo(
    () => (machineId ? SITES[siteId].machines.find((m) => m.id === machineId) ?? null : null),
    [siteId, machineId],
  );

  /** Phase is reported upward through a ref so nothing re-renders at 60fps. */
  const phase = useRef({ kin: 0, moving: false });
  const onPhase = useCallback((kin: number, moving: boolean) => {
    phase.current.kin = kin;
    phase.current.moving = moving;
  }, []);

  if (!def) return null;

  const elevation = floorElevation(SITES[siteId], def.floor);

  return (
    <group position={[def.position[0], elevation + def.position[1], def.position[2]]} rotation={[0, def.rotation, 0]}>
      <MovingPart siteId={siteId} def={def} onPhase={onPhase} />
    </group>
  );
}

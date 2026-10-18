'use client';

/**
 * LAYER 1 — GOD'S EYE VIEW, TWO NODES
 *
 * A CesiumJS globe tuned hard for a GTX 1650. Lifecycle rules:
 *
 *   · Exactly one Viewer exists at a time, and it is `destroy()`ed on unmount.
 *     `page.tsx` unmounts this component before React Three Fiber is allowed to
 *     take a WebGL context, so the two renderers never share VRAM.
 *   · No React state is written during the flight. The camera animation is
 *     Cesium's own, and every live label, weather disc and convoy bead reads
 *     the mutable simulation world from inside a CallbackProperty — Cesium
 *     polls them per render tick, React never hears about it.
 *   · Works with or without a Cesium ion token. With one you get world terrain,
 *     aerial imagery and OSM buildings; without one it degrades to raster OSM
 *     tiles on a smooth ellipsoid, which still presents beautifully.
 */

import { useEffect, useRef } from 'react';
import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cesium3DTileset,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  Entity,
  HeightReference,
  ImageryLayer,
  Ion,
  JulianDate,
  LabelStyle,
  Math as CMath,
  NearFarScalar,
  OpenStreetMapImageryProvider,
  PolylineGlowMaterialProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Terrain,
  VerticalOrigin,
  Viewer,
  defined,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import { SITES, SITE_IDS, type SiteId } from '@/lib/sites';
import { THEME } from '@/lib/theme';
import { getWorld, useMegnetoStore } from '@/store/useMegnetoStore';

const ION_TOKEN = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN?.trim() ?? '';
const HAS_ION = ION_TOKEN.length > 20;

/** Where the camera sits at rest: both nodes and the corridor in one frame. */
const SPACE_VIEW = {
  lon: 78.6,
  lat: 6.2,
  height: 2_250_000,
  heading: 0,
  pitch: -62,
};

/** Rooftop three-quarter view over a site, computed from its coordinates. */
function streetViewFor(id: SiteId) {
  const s = SITES[id];
  return {
    lon: s.lon - 0.0006,
    lat: s.lat - 0.0008,
    height: s.alt + 90,
    heading: 36,
    pitch: -40,
  };
}

const ARC_SAMPLES = 64;

/** Great-circle-ish arc lifted into a parabola, in ECEF. */
function buildArc(fromLon: number, fromLat: number, toLon: number, toLat: number, peak: number) {
  const pts: Cartesian3[] = new Array(ARC_SAMPLES);
  for (let i = 0; i < ARC_SAMPLES; i++) {
    const t = i / (ARC_SAMPLES - 1);
    const lon = fromLon + (toLon - fromLon) * t;
    const lat = fromLat + (toLat - fromLat) * t;
    pts[i] = Cartesian3.fromDegrees(lon, lat, Math.sin(Math.PI * t) * peak);
  }
  return pts;
}

/**
 * Token-free imagery, and the palette wash both paths share.
 *
 * Full-saturation satellite is dark and busy, and a white HUD panel laid over
 * it is genuinely hard to read. Aerial keeps more saturation than the raster
 * fallback, because seeing the ground is the whole reason to spend a token.
 */
function washImagery(layer: ImageryLayer, kind: 'raster' | 'aerial') {
  if (kind === 'aerial') {
    layer.brightness = 1.42;
    layer.contrast = 0.78;
    layer.saturation = 0.34;
    layer.hue = 0.02;
    layer.gamma = 1.45;
  } else {
    layer.brightness = 1.12;
    layer.contrast = 0.92;
    layer.saturation = 0.16;
    layer.hue = 0.0;
    layer.gamma = 1.05;
  }
}

function buildFallbackImagery(): ImageryLayer {
  const provider = new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' });
  provider.errorEvent.addEventListener(() => {
    useMegnetoStore.getState().setGlobeDegraded(true);
  });
  const layer = new ImageryLayer(provider, {});
  washImagery(layer, 'raster');
  return layer;
}

export interface MacroGlobeProps {
  /** 'space' on first load, 'street' when returning from the micro layer. */
  entry?: 'space' | 'street';
  /** Which site we are returning from, so the camera starts in the right place. */
  returnFrom?: SiteId;
}

export default function MacroGlobe({ entry = 'space', returnFrom = 'tiruppur' }: MacroGlobeProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const idleSpinRef = useRef(true);

  /* ------------------------------------------------------------------ */
  /* Create / destroy the viewer                                         */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let viewer: Viewer | null = null;
    let handler: ScreenSpaceEventHandler | null = null;

    if (HAS_ION) Ion.defaultAccessToken = ION_TOKEN;

    try {
      viewer = new Viewer(host, {
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        sceneModePicker: false,
        selectionIndicator: false,
        navigationHelpButton: false,
        navigationInstructionsInitiallyVisible: false,
        creditContainer: document.createElement('div'),
        baseLayer: HAS_ION ? undefined : buildFallbackImagery(),
        contextOptions: {
          webgl: {
            alpha: false,
            antialias: false, // 4GB VRAM: MSAA on a full globe is not worth it
            powerPreference: 'high-performance',
            failIfMajorPerformanceCaveat: false,
          },
        },
      });
    } catch (err) {
      console.error('[megneto] Cesium viewer failed to initialise', err);
      useMegnetoStore.getState().setGlobeDegraded(true);
      return;
    }

    viewerRef.current = viewer;
    const scene = viewer.scene;
    const world = getWorld();

    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as Record<string, unknown>).__megnetoViewer = viewer;
    }

    /* ---- GPU budget ---- */
    viewer.useBrowserRecommendedResolution = true;
    viewer.resolutionScale = 0.92;
    viewer.targetFrameRate = 30;
    scene.globe.maximumScreenSpaceError = 4; // default 2: halves tile load
    scene.globe.tileCacheSize = 160;
    // Offline-safe Earth: if no tile ever arrives the globe is still a solid
    // sphere under the atmosphere, not a hole cut out of the page.
    scene.globe.baseColor = Color.fromCssColorString('#9ccbe9');
    // A light theme has no use for a night side, and the render should not
    // depend on what time the pitch happens to start.
    scene.globe.enableLighting = false;
    // The ground atmosphere bleaches a light-themed globe to solid white.
    scene.globe.showGroundAtmosphere = false;
    scene.fog.enabled = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.moon) scene.moon.show = false;
    if (scene.sun) scene.sun.show = false;
    scene.backgroundColor = Color.fromCssColorString(THEME.background);
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.hueShift = 0;
      scene.skyAtmosphere.saturationShift = 0;
      scene.skyAtmosphere.brightnessShift = 0;
    }
    scene.highDynamicRange = false;
    scene.msaaSamples = 1;
    scene.postProcessStages.fxaa.enabled = false;
    scene.screenSpaceCameraController.enableCollisionDetection = true;
    scene.screenSpaceCameraController.minimumZoomDistance = 40;

    /* ---- Terrain + buildings, ion only ---- */
    if (HAS_ION) {
      const ionBase = viewer.imageryLayers.length > 0 ? viewer.imageryLayers.get(0) : null;
      if (ionBase) washImagery(ionBase, 'aerial');
      try {
        scene.setTerrain(Terrain.fromWorldTerrain({ requestWaterMask: false, requestVertexNormals: true }));
      } catch (err) {
        console.warn('[megneto] world terrain unavailable, staying on the ellipsoid', err);
      }
      Cesium3DTileset.fromIonAssetId(96188, { maximumScreenSpaceError: 24 })
        .then((tileset) => {
          if (disposed || !viewer || viewer.isDestroyed()) {
            tileset.destroy();
            return;
          }
          scene.primitives.add(tileset);
        })
        .catch(() => {
          /* buildings are decoration; continue without them */
        });
    } else {
      useMegnetoStore.getState().setGlobeDegraded(true);
    }

    /* ---------------------------------------------------------------- */
    /* Site markers                                                      */
    /* ---------------------------------------------------------------- */

    const pulse = (base: number, amp: number, speed: number) =>
      new CallbackProperty((time?: JulianDate) => {
        const seconds = time ? time.secondsOfDay : performance.now() / 1000;
        return base + Math.abs(Math.sin(seconds * speed)) * amp;
      }, false);

    for (const id of SITE_IDS) {
      const def = SITES[id];
      const site = world.sites[id];
      const pos = Cartesian3.fromDegrees(def.lon, def.lat, def.alt + 6);
      const tint = def.kind === 'textile' ? '#1a8fd1' : '#5b55c9';

      /* --- weather disc: cloud cover and rain, straight from the OU model --- */
      viewer.entities.add({
        id: `weather-${id}`,
        position: Cartesian3.fromDegrees(def.lon, def.lat, 0),
        ellipse: {
          semiMinorAxis: new CallbackProperty(() => 24_000 + site.weather.cloud * 52_000, false),
          semiMajorAxis: new CallbackProperty(() => 28_000 + site.weather.cloud * 60_000, false),
          material: new ColorMaterialProperty(
            new CallbackProperty(
              () =>
                Color.fromCssColorString(site.weather.rainMmH > 0.2 ? '#4b7ea8' : '#8fb8d4').withAlpha(
                  0.08 + site.weather.cloud * 0.26,
                ),
              false,
            ),
          ),
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
      });

      /* --- rainfall ring: only drawn while it is actually raining --- */
      viewer.entities.add({
        id: `rain-${id}`,
        position: Cartesian3.fromDegrees(def.lon, def.lat, 0),
        ellipse: {
          semiMinorAxis: pulse(14_000, 26_000, 0.7),
          semiMajorAxis: pulse(14_000, 26_000, 0.7),
          material: new ColorMaterialProperty(
            new CallbackProperty(
              () => Color.fromCssColorString('#2f6f9e').withAlpha(Math.min(0.3, site.weather.rainMmH * 0.03)),
              false,
            ),
          ),
          outline: false,
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
      });

      /* --- the clickable node itself --- */
      viewer.entities.add({
        id: `site-${id}`,
        name: def.name,
        position: pos,
        point: {
          pixelSize: pulse(12, 9, 2.2),
          color: Color.fromCssColorString(tint),
          outlineColor: Color.fromCssColorString('#ffffff'),
          outlineWidth: 2,
          scaleByDistance: new NearFarScalar(2.0e2, 1.6, 4.0e6, 0.6),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        ellipse: {
          semiMinorAxis: pulse(900, 2600, 0.9),
          semiMajorAxis: pulse(900, 2600, 0.9),
          material: Color.fromCssColorString(tint).withAlpha(0.16),
          outline: true,
          outlineColor: Color.fromCssColorString(tint).withAlpha(0.5),
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          // Live site telemetry, polled by Cesium, never by React.
          text: new CallbackProperty(() => {
            const w = site.weather;
            const env =
              site.physics.kind === 'textile'
                ? `${site.physics.rh.toFixed(0)} %RH · WBGT ${site.physics.wbgt.toFixed(0)}`
                : `${site.physics.vocPpm.toFixed(0)} ppm VOC · ${site.physics.grid.kva.toFixed(0)} kVA`;
            const alerts = site.totals.actionableAlerts;
            return [
              def.shortName,
              `${def.city}`,
              `${w.tempC.toFixed(1)} °C · ${w.rh.toFixed(0)} %RH${w.rainMmH > 0.2 ? ` · rain ${w.rainMmH.toFixed(1)} mm/h` : ''}`,
              env,
              `${site.totals.onShift} on shift${alerts > 0 ? ` · ${alerts} ACTION` : ''}`,
            ].join('\n');
          }, false),
          font: '600 12px ui-monospace, SFMono-Regular, Menlo, monospace',
          fillColor: Color.fromCssColorString(THEME.ink),
          showBackground: true,
          backgroundColor: new CallbackProperty(
            () =>
              site.totals.actionableAlerts > 0
                ? Color.fromCssColorString('#fff2f4').withAlpha(0.95)
                : Color.fromCssColorString('#ffffff').withAlpha(0.92),
            false,
          ),
          backgroundPadding: new Cartesian2(10, 8),
          style: LabelStyle.FILL,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -26),
          scaleByDistance: new NearFarScalar(2.0e2, 1.0, 6.0e6, 0.0),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }

    /* ---------------------------------------------------------------- */
    /* Lanes and convoys                                                 */
    /* ---------------------------------------------------------------- */
    world.convoys.forEach((convoy, i) => {
      const span = Math.hypot(convoy.toLon - convoy.fromLon, convoy.toLat - convoy.fromLat);
      const arc = buildArc(
        convoy.fromLon,
        convoy.fromLat,
        convoy.toLon,
        convoy.toLat,
        span * 38_000 + 18_000,
      );

      const tint =
        convoy.kind === 'inter-site'
          ? '#c57600'
          : convoy.kind === 'supplier'
            ? '#5b55c9'
            : convoy.kind === 'customer'
              ? '#0c9183'
              : '#1a8fd1';

      viewer!.entities.add({
        id: `lane-${convoy.id}`,
        polyline: {
          positions: arc,
          width: convoy.kind === 'inter-site' ? 3.0 : 2.0,
          material: new PolylineGlowMaterialProperty({
            glowPower: 0.16,
            taperPower: 0.7,
            color: Color.fromCssColorString(tint).withAlpha(convoy.kind === 'inter-site' ? 0.92 : 0.7),
          }),
        },
      });

      // The bead's position is a pure function of the convoy's progress, which
      // the logistics model integrates. Cesium samples it per render tick.
      viewer!.entities.add({
        id: `convoy-${convoy.id}`,
        position: new CallbackPositionProperty(() => {
          const f = world.convoys[i].progress * (ARC_SAMPLES - 1);
          const lo = Math.floor(f);
          const hi = Math.min(ARC_SAMPLES - 1, lo + 1);
          return Cartesian3.lerp(arc[lo], arc[hi], f - lo, new Cartesian3());
        }, false),
        point: {
          pixelSize: convoy.kind === 'inter-site' ? 7 : 5,
          color: Color.fromCssColorString(tint),
          outlineColor: Color.fromCssColorString('#ffffff'),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          translucencyByDistance: new NearFarScalar(1.0e5, 1.0, 9.0e6, 0.0),
        },
        label:
          convoy.kind === 'inter-site'
            ? {
                text: new CallbackProperty(() => {
                  const c = world.convoys[i];
                  const h = Math.floor(c.etaMinutes / 60);
                  const m = Math.round(c.etaMinutes % 60);
                  return `${c.unitsInTransit.toLocaleString('en-IN')} u · ETA ${h}h ${m}m`;
                }, false),
                font: '500 10px ui-monospace, SFMono-Regular, Menlo, monospace',
                fillColor: Color.fromCssColorString('#8a5300'),
                showBackground: true,
                backgroundColor: Color.fromCssColorString('#ffffff').withAlpha(0.9),
                backgroundPadding: new Cartesian2(6, 4),
                verticalOrigin: VerticalOrigin.BOTTOM,
                pixelOffset: new Cartesian2(0, -12),
                scaleByDistance: new NearFarScalar(1.0e5, 1.0, 5.0e6, 0.0),
                translucencyByDistance: new NearFarScalar(1.0e5, 1.0, 5.0e6, 0.0),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              }
            : undefined,
      });
    });

    /* ---------------------------------------------------------------- */
    /* Camera                                                            */
    /* ---------------------------------------------------------------- */
    const start = entry === 'street' ? streetViewFor(returnFrom) : SPACE_VIEW;
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(start.lon, start.lat, start.height),
      orientation: {
        heading: CMath.toRadians(start.heading),
        pitch: CMath.toRadians(start.pitch),
        roll: 0,
      },
    });

    const stopSpin = () => {
      idleSpinRef.current = false;
    };
    scene.canvas.addEventListener('pointerdown', stopSpin);
    scene.canvas.addEventListener('wheel', stopSpin, { passive: true });

    const onPreRender = () => {
      if (!idleSpinRef.current) return;
      if (useMegnetoStore.getState().phase !== 'macro') return;
      viewer!.camera.rotate(Cartesian3.UNIT_Z, -0.00012);
    };
    scene.preRender.addEventListener(onPreRender);

    /* ---------------------------------------------------------------- */
    /* Interaction: click a site to dive                                 */
    /* ---------------------------------------------------------------- */
    handler = new ScreenSpaceEventHandler(scene.canvas);

    const siteIdFromPick = (picked: unknown): SiteId | null => {
      if (!defined(picked)) return null;
      const id = (picked as { id?: unknown }).id;
      if (!(id instanceof Entity) || typeof id.id !== 'string') return null;
      if (!id.id.startsWith('site-')) return null;
      const key = id.id.slice(5) as SiteId;
      return SITE_IDS.includes(key) ? key : null;
    };

    handler.setInputAction((movement: { position: Cartesian2 }) => {
      const site = siteIdFromPick(scene.pick(movement.position));
      if (site) useMegnetoStore.getState().beginDive(site);
    }, ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
      const site = siteIdFromPick(scene.pick(movement.endPosition));
      scene.canvas.style.cursor = site ? 'pointer' : 'grab';
      for (const id of SITE_IDS) {
        const entity = viewer!.entities.getById(`site-${id}`);
        if (entity?.point) entity.point.outlineWidth = new ConstantProperty(site === id ? 4 : 2);
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    /* ---------------------------------------------------------------- */
    /* Teardown — this is the VRAM contract                              */
    /* ---------------------------------------------------------------- */
    return () => {
      disposed = true;
      try {
        scene.canvas.removeEventListener('pointerdown', stopSpin);
        scene.canvas.removeEventListener('wheel', stopSpin);
        scene.preRender.removeEventListener(onPreRender);
        handler?.destroy();
        handler = null;
        if (viewer && !viewer.isDestroyed()) {
          // Stop the render loop FIRST. Emptying collections while a tick is
          // still scheduled lets the DataSourceDisplay reach for primitives
          // that are already gone ("This object was destroyed").
          viewer.useDefaultRenderLoop = false;
          viewer.clock.shouldAnimate = false;
          // destroy() tears down entities, primitives, the tile cache and the
          // WebGL context itself. Doing it by hand first causes the race.
          viewer.destroy();
        }
      } catch (err) {
        console.warn('[megneto] viewer teardown', err);
      }
      viewerRef.current = null;
    };
    // `entry` is read once at construction; remounting is how we change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------------ */
  /* Phase-driven camera flights                                         */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    // Subscribing imperatively keeps this component out of the render path.
    const unsub = useMegnetoStore.subscribe((state, prev) => {
      if (state.phase === prev.phase) return;
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      if (state.phase === 'descending') {
        idleSpinRef.current = false;
        const target = streetViewFor(state.targetSite);
        viewer.camera.flyTo({
          destination: Cartesian3.fromDegrees(target.lon, target.lat, target.height),
          orientation: {
            heading: CMath.toRadians(target.heading),
            pitch: CMath.toRadians(target.pitch),
            roll: 0,
          },
          duration: 4.2,
          maximumHeight: 420_000,
          easingFunction: (t: number) => 1 - Math.pow(1 - t, 3),
          complete: () => useMegnetoStore.getState().enterHandoff(),
          cancel: () => useMegnetoStore.getState().enterHandoff(),
        });
      }

      if (state.phase === 'ascending') {
        viewer.camera.flyTo({
          destination: Cartesian3.fromDegrees(SPACE_VIEW.lon, SPACE_VIEW.lat, SPACE_VIEW.height),
          orientation: {
            heading: CMath.toRadians(SPACE_VIEW.heading),
            pitch: CMath.toRadians(SPACE_VIEW.pitch),
            roll: 0,
          },
          duration: 3.0,
          complete: () => {
            idleSpinRef.current = true;
            useMegnetoStore.getState().completeAscent();
          },
          cancel: () => useMegnetoStore.getState().completeAscent(),
        });
      }
    });
    return unsub;
  }, []);

  /* ------------------------------------------------------------------ */
  /* An ascending mount starts at street level and pulls straight out    */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (entry !== 'street') return;
    const id = window.setTimeout(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;
      if (useMegnetoStore.getState().phase !== 'ascending') return;
      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(SPACE_VIEW.lon, SPACE_VIEW.lat, SPACE_VIEW.height),
        orientation: {
          heading: CMath.toRadians(SPACE_VIEW.heading),
          pitch: CMath.toRadians(SPACE_VIEW.pitch),
          roll: 0,
        },
        duration: 3.4,
        complete: () => {
          idleSpinRef.current = true;
          useMegnetoStore.getState().completeAscent();
        },
        cancel: () => useMegnetoStore.getState().completeAscent(),
      });
    }, 260);
    return () => window.clearTimeout(id);
  }, [entry]);

  return (
    <div className="absolute inset-0">
      <div ref={hostRef} className="h-full w-full [&_.cesium-widget-credits]:hidden" />
      {/* Vignette + scanlines sell the "orbital feed" look for free. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_58%,rgba(234,244,253,0.55)_100%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.05] [background-image:repeating-linear-gradient(0deg,#1a8fd1_0px,#1a8fd1_1px,transparent_1px,transparent_3px)]" />
    </div>
  );
}

'use client';
/**
 * Lookout's 3D theater: a CesiumJS view that lives inside the console, beside the
 * flat MapLibre map rather than instead of it. MapLibre stays the working surface
 * (layers, canvass, cases); this is where a place — or an aircraft — is looked at in 3D.
 *
 * Cesium is loaded as its prebuilt bundle from /vendor (tools/prepare-cesium-assets.mjs)
 * so Turbopack never has to transpile the engine; the package is imported for types only.
 *
 * Google's Map Tiles terms allow these tiles to be *displayed*. They do not allow
 * analysing them: no object detection, no feeding frames to a vision model, no
 * caching or exporting the geometry. Keep this view a viewport.
 *
 * Layers: src/components/theater/layers/* draw Lookout's /api feeds (useTheaterFeeds
 * polls them). Follow / cockpit: src/lib/theater/cockpit-math. Contacts: everything the
 * switched-on layers hold within 250 km of the selected object. Sensor looks:
 * src/lib/theater/styles (post-process shaders, keys 1–7).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type * as CesiumNS from 'cesium';
import { DEFAULT_THEATER_VIEW, altitudeForZoom, parseTheaterView, theaterViewToSearch, zoomForAltitude, type TheaterView } from '@/lib/theater-view';
import { registerActuators } from '@/lib/assistant/registry';
import { nearbyContacts, parseLayerParam, serializeLayerParam, type NearbyContact, type TheaterContact, type TheaterLayerId } from '@/lib/theater/layers';
import { CHASE_PRESET, COCKPIT_PRESET, HEADING_SLEW_DEG_PER_S, MIN_GROUND_CLEARANCE_M, chasePose, cockpitGroundSafeHeight, slewHeading } from '@/lib/theater/cockpit-math';
import { SENSOR_STYLES, createStyleManager } from '@/lib/theater/styles';
import type { TheaterConfig } from '@/app/api/theater/config/route';
import { isPickId, type CesiumGlobal, type TheaterLayer } from './layers/base';
import { FlightsLayer } from './layers/flights';
import { SatellitesLayer } from './layers/satellites';
import { CamerasLayer, CanvassLayer } from './layers/cameras';
import { EarthquakesLayer } from './layers/earthquakes';
import { TracksLayer } from './layers/tracks';
import { VesselsLayer } from './layers/vessels';
import { AnnotationsLayer } from './layers/annotations';
import { TraceLayer, type TraceDetail, type TraceInfo, type TracePlayState } from './layers/trace';
import { TracePanel } from './TracePanel';
import { DetectPanel, summarizeDetections, type DetectResult, type DetectState } from './DetectPanel';
import { AnnotatePanel } from './AnnotatePanel';
import { measureOf, validateAnnotation, ANNOTATION_MAX, type Annotation, type AnnotationKind, type AnnotationPoint } from '@/lib/theater/annotations';
import { HistoryPanel, type HistoryBridge, type HistoryHandle } from './HistoryPanel';
import { WatchPanel, type WatchBridge } from './WatchPanel';
import { useTheaterFeeds, type ViewCenter } from './useTheaterFeeds';
import { TheaterContactsPanel, TheaterInfoCard, TheaterLayerPanel } from './TheaterHud';
import { ScenesPanel, type SceneBridge } from './ScenesPanel';
import type { SceneShotCamera } from '@/lib/theater/director';
import { THEATER_LAYERS, isTheaterLayerId } from '@/lib/theater/layers';

declare global {
  interface Window {
    Cesium?: CesiumGlobal;
    CESIUM_BASE_URL?: string;
  }
}

type Imagery = 'google-3d' | 'esri';
type Status =
  | { phase: 'loading'; note: string }
  | { phase: 'ready'; imagery: Imagery; note: string }
  | { phase: 'error'; note: string };
type FollowMode = 'chase' | 'cockpit';

/** Command-dock quick places (the flat map's search covers everything else). */
const PRESET_PLACES = [
  { name: 'Los Angeles', lat: 34.0407, lng: -118.2468, alt: 2600 },
  { name: 'Santa Monica', lat: 34.0089, lng: -118.4973, alt: 900 },
  { name: 'New York', lat: 40.7484, lng: -73.9857, alt: 1600 },
  { name: 'Washington', lat: 38.8895, lng: -77.0353, alt: 1400 },
];
const STYLE_ICON: Record<string, string> = { normal: '◯', retro: '▦', surveillance: '◑', thermal: '◈', anime: '✦', noir: '◐', snow: '❄' };
type Selected = { contact: TheaterContact; raw?: Record<string, unknown> };
type StyleManager = ReturnType<typeof createStyleManager>;

/** The public kit ships the theater without the console: its menu points at the source instead. */
const KIT = process.env.NEXT_PUBLIC_LOOKOUT_KIT === '1';
const ESRI_WORLD_IMAGERY = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_CREDIT = 'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const CONTACT_RADIUS_KM = 250;
const STYLE_NAMES = new Set(SENSOR_STYLES.map((s) => s.name));

let cesiumLoad: Promise<CesiumGlobal> | null = null;

/** One script tag per page lifetime, however many times the component mounts. */
function loadCesium(version: string): Promise<CesiumGlobal> {
  if (window.Cesium) return Promise.resolve(window.Cesium);
  if (cesiumLoad) return cesiumLoad;
  // NEXT_PUBLIC_CESIUM_CDN=1 (the hosted demo) loads the same pinned version from Cesium's own CDN so the
  // host serves none of the ~15 MB; self-hosted installs stage it under /vendor at build time.
  // Cesium's CDN names releases MAJOR.MINOR (1.145), npm names them MAJOR.MINOR.PATCH (1.145.0).
  const cdn = process.env.NEXT_PUBLIC_CESIUM_CDN === '1';
  const base = cdn ? `https://cesium.com/downloads/cesiumjs/releases/${version.replace(/\.0$/, '')}/Build/Cesium/` : `/vendor/cesium/${version}/`;
  // Cesium resolves its workers, WASM decoders and widget assets against this.
  window.CESIUM_BASE_URL = base;
  cesiumLoad = new Promise<CesiumGlobal>((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${base}Widgets/widgets.css`;
    document.head.appendChild(css);
    const script = document.createElement('script');
    script.src = `${base}Cesium.js`;
    script.async = true;
    script.onload = () => (window.Cesium ? resolve(window.Cesium) : reject(new Error('Cesium loaded but did not register')));
    script.onerror = () => reject(new Error(cdn ? `Could not load the 3D engine from Cesium's CDN (${base}) — check the network or build without NEXT_PUBLIC_CESIUM_CDN` : `Could not load the 3D engine from ${base} — run "npm run build" (its prebuild step stages it)`));
    document.head.appendChild(script);
  }).catch((e) => {
    cesiumLoad = null; // let a retry try again
    throw e;
  });
  return cesiumLoad;
}

function readView(Cesium: CesiumGlobal, viewer: CesiumNS.Viewer): TheaterView {
  const c = viewer.camera.positionCartographic;
  return {
    lat: Cesium.Math.toDegrees(c.latitude),
    lng: Cesium.Math.toDegrees(c.longitude),
    alt: c.height,
    heading: Cesium.Math.toDegrees(viewer.camera.heading),
    pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
  };
}

export default function CesiumTheater({ cesiumVersion }: { cesiumVersion: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const credits = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ phase: 'loading', note: 'Loading the 3D engine…' });
  const [view, setView] = useState<TheaterView>(DEFAULT_THEATER_VIEW);
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState<Set<TheaterLayerId>>(() => new Set());
  const [panelOpen, setPanelOpen] = useState(true);
  const [layers, setLayers] = useState<Map<TheaterLayerId, TheaterLayer> | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [follow, setFollow] = useState<FollowMode | null>(null);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [contacts, setContacts] = useState<NearbyContact[]>([]);
  const [hud, setHud] = useState<{ speedKt: number; heading: number; altFt: number; coasting: boolean } | null>(null);
  const [style, setStyle] = useState('normal');
  const [now, setNow] = useState(() => Date.now());
  const [scenesOpen, setScenesOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [sceneStart, setSceneStart] = useState<{ id: string | null; play: boolean }>({ id: null, play: false });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [drawMode, setDrawMode] = useState<AnnotationKind | null>(null);
  const [draftPoints, setDraftPoints] = useState(0);
  const [annLabel, setAnnLabel] = useState('');
  const annLayerRef = useRef<AnnotationsLayer | null>(null);
  const drawRef = useRef<{ kind: AnnotationKind; points: AnnotationPoint[] } | null>(null);
  const annLabelRef = useRef('');
  const addDrawPointRef = useRef<(pos: CesiumNS.Cartesian2) => void>(() => {});
  const finishDrawRef = useRef<() => void>(() => {});
  const traceRef = useRef<TraceLayer | null>(null);
  const [trace, setTrace] = useState<TraceInfo | null>(null);
  const [tracePlay, setTracePlay] = useState<TracePlayState | null>(null);
  const [traceBusy, setTraceBusy] = useState<string | null>(null);
  const [traceErr, setTraceErr] = useState<string | null>(null);
  const [trackerOnline, setTrackerOnline] = useState<boolean>(false);
  const [detect, setDetect] = useState<DetectState | null>(null);
  const [staged, setStaged] = useState<{ staged: number; loaded: number }>({ staged: 0, loaded: 0 });
  const [modelCount, setModelCount] = useState(0);
  // Skin: 'lookout' (the console's gold identity, default) or 'gev' (the God's Eye shell, credited).
  const [skin, setSkinState] = useState<'lookout' | 'gev'>('lookout');
  useEffect(() => {
    // Scout's dock and panel live outside .theater in the DOM; they read the skin's accent from <html>.
    const r = document.documentElement.style;
    const gold = skin === 'lookout';
    r.setProperty('--theater-accent', gold ? '#D4AF37' : '#00d4ff');
    r.setProperty('--theater-accent-rgb', gold ? '212, 175, 55' : '0, 212, 255');
    r.setProperty('--theater-accent-fg', gold ? '#111111' : '#04131a');
    r.setProperty('--theater-panel-bg', gold ? 'rgba(8, 10, 20, 0.94)' : 'rgba(9, 18, 27, 0.92)');
    r.setProperty('--theater-panel-border', gold ? 'rgba(212, 175, 55, 0.22)' : 'rgba(123, 189, 211, 0.28)');
    return () => { for (const k of ['--theater-accent', '--theater-accent-rgb', '--theater-accent-fg', '--theater-panel-bg', '--theater-panel-border']) r.removeProperty(k); };
  }, [skin]);
  // Recording mode (R / ?rec=1): 16:9 safe frame for capture; the operator's private bits are blurred.
  const [recording, setRecording] = useState(false);
  const setSkin = useCallback((next: 'lookout' | 'gev') => {
    setSkinState(next);
    try { window.localStorage.setItem('lookout.theater.skin', next); } catch { /* private mode */ }
    const qs = new URLSearchParams(window.location.search);
    if (next === 'gev') qs.set('skin', 'gev'); else qs.delete('skin');
    window.history.replaceState(null, '', `?${qs.toString()}`);
  }, []);
  const [historyStart, setHistoryStart] = useState<{ from: number; to: number } | null>(null);
  const historyRef = useRef<HistoryHandle | null>(null);

  const viewerRef = useRef<CesiumNS.Viewer | null>(null);
  const cesiumRef = useRef<CesiumGlobal | null>(null);
  const layersRef = useRef<Map<TheaterLayerId, TheaterLayer> | null>(null);
  const stylesRef = useRef<StyleManager | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  // `layer` is what the camera rides: a live aircraft, or a recorded track at the HISTORY playhead.
  const followRef = useRef<{ mode: FollowMode; id: string; layer: 'flights' | 'tracks'; heading: number; lastT: number; ground: number | null; lastGroundAt: number; lastHudAt: number } | null>(null);
  const selectedRef = useRef<Selected | null>(null);
  selectedRef.current = selected;
  const refreshCanvassRef = useRef<() => void>(() => {});

  const getViewCenter = useCallback((): ViewCenter | null => {
    const viewer = viewerRef.current, Cesium = cesiumRef.current;
    if (!viewer || !Cesium) return null;
    const canvas = viewer.scene.canvas;
    const centre = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const ray = viewer.camera.getPickRay(centre);
    const hit = (ray && viewer.scene.globe.show ? viewer.scene.globe.pick(ray, viewer.scene) : undefined) ?? viewer.camera.pickEllipsoid(centre);
    const carto = hit ? Cesium.Cartographic.fromCartesian(hit) : viewer.camera.positionCartographic;
    return { lat: Cesium.Math.toDegrees(carto.latitude), lng: Cesium.Math.toDegrees(carto.longitude), alt: viewer.camera.positionCartographic.height };
  }, []);

  const { status: feeds, refreshCanvass } = useTheaterFeeds(active, layers, getViewCenter);
  refreshCanvassRef.current = refreshCanvass;

  const stopFollow = useCallback(() => {
    const viewer = viewerRef.current;
    if (viewer && !viewer.isDestroyed()) viewer.scene.screenSpaceCameraController.enableInputs = true;
    const f = followRef.current;
    const flights = layersRef.current?.get('flights') as FlightsLayer | undefined;
    const tracks = layersRef.current?.get('tracks') as TracksLayer | undefined;
    if (f) { flights?.setLabelsAround(null); (f.layer === 'tracks' ? tracks : flights)?.setPointHidden(f.id, false); }
    followRef.current = null;
    setFollow(null);
    setHud(null);
  }, []);

  // ── engine ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let viewer: CesiumNS.Viewer | null = null;
    let writeTimer: ReturnType<typeof setTimeout> | undefined;
    let canvassTimer: ReturnType<typeof setTimeout> | undefined;
    let handler: CesiumNS.ScreenSpaceEventHandler | null = null;
    let removePreRender: (() => void) | null = null;
    let built: TheaterLayer[] = [];
    let styleManager: StyleManager | null = null;

    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const start = parseTheaterView(params);
        setView(start);
        setActive(parseLayerParam(params.get('layers')));
        const wantedStyle = params.get('style') || 'normal';
        const skinParam = params.get('skin');
        let storedSkin: string | null = null;
        try { storedSkin = window.localStorage.getItem('lookout.theater.skin'); } catch { storedSkin = null; }
        const wantedSkin = skinParam === 'gev' || skinParam === 'lookout' ? skinParam : storedSkin === 'gev' ? 'gev' : 'lookout';
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the URL/storage once at mount, like the style above
        setSkinState(wantedSkin);
        if (params.get('rec') === '1') setRecording(true);
        const sceneParam = params.get('scene');
        if (sceneParam) { setSceneStart({ id: sceneParam, play: params.get('play') === '1' }); setScenesOpen(true); }
        // ?history=<fromISO>~<toISO> opens a recorded window (Scout's replay_tracks deep link).
        const historyParam = params.get('history');
        if (historyParam) {
          const [f, t] = historyParam.split('~').map((s) => Date.parse(s));
          if (Number.isFinite(f) && Number.isFinite(t) && t > f) { setHistoryStart({ from: f, to: t }); setHistoryOpen(true); }
        }
        setStatus({ phase: 'loading', note: 'Loading the 3D engine…' });
        const [Cesium, config] = await Promise.all([
          loadCesium(cesiumVersion),
          fetch('/api/theater/config')
            .then((r) => (r.ok ? (r.json() as Promise<TheaterConfig>) : Promise.reject(new Error(`config ${r.status}`))))
            // A missing config is survivable: it only decides which imagery loads.
            .catch((e): TheaterConfig => { console.warn('[theater] config unavailable, running keyless:', e); return { googleTilesKey: null, ionToken: null }; }),
        ]);
        if (cancelled || !holder.current || !credits.current) return;
        cesiumRef.current = Cesium;

        // Nothing here uses Cesium ion. Blank the SDK's bundled demo token so a
        // stray default never phones home or paints an ion upsell over the view.
        // No ion calls unless the operator brought a token (the free tier reaches Google's photoreal tiles through ion).
        Cesium.Ion.defaultAccessToken = config.ionToken || '';

        viewer = new Cesium.Viewer(holder.current, {
          timeline: false, animation: false, baseLayerPicker: false, geocoder: false, homeButton: false,
          sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, vrButton: false,
          selectionIndicator: false, infoBox: false,
          baseLayer: false,
          // Provider attribution is a licence condition. It renders into our own
          // strip so it stays visible and legible instead of overlapping the HUD.
          creditContainer: credits.current,
          msaaSamples: 4,
        });
        viewerRef.current = viewer;

        // Camera controls, Mac-first. Cesium's defaults make looking around a middle-drag or
        // Ctrl-drag (no middle button on a laptop; Ctrl-click is a right-click) and make
        // right-drag ZOOM — which is why "panning the camera" fought "moving the map".
        //   left-drag / one finger  → move the map (rotate the globe under the camera)
        //   right-drag / two-finger click-drag → look around / tilt / orbit the point under the cursor
        //   wheel / pinch           → zoom
        //   shift + left-drag       → free look (turn your head in place)
        // Inertia is shortened so the view stops where you stop.
        {
          const ssc = viewer.scene.screenSpaceCameraController;
          const T = Cesium.CameraEventType, M = Cesium.KeyboardEventModifier;
          ssc.tiltEventTypes = [T.RIGHT_DRAG, T.MIDDLE_DRAG, T.PINCH, { eventType: T.LEFT_DRAG, modifier: M.CTRL }];
          ssc.zoomEventTypes = [T.WHEEL, T.PINCH];
          ssc.lookEventTypes = [{ eventType: T.LEFT_DRAG, modifier: M.SHIFT }];
          ssc.inertiaSpin = 0.6; ssc.inertiaTranslate = 0.6; ssc.inertiaZoom = 0.6;
          ssc.minimumZoomDistance = 40;
          ssc.enableCollisionDetection = true;
        }

        let imagery: Imagery = 'esri';
        let note = 'Keyless mode — satellite imagery on a smooth globe. Add a Google Map Tiles key, or a free Cesium ion token, for photoreal 3D cities.';
        if (config.googleTilesKey || config.ionToken) {
          setStatus({ phase: 'loading', note: 'Loading Google photorealistic 3D tiles…' });
          try {
            const tileset = await (config.googleTilesKey
              ? Cesium.createGooglePhotorealistic3DTileset({ key: config.googleTilesKey, onlyUsingWithGoogleGeocoder: true })
              : Cesium.createGooglePhotorealistic3DTileset()); // through Cesium ion, with the operator's token
            if (cancelled) { tileset.destroy(); return; }
            viewer.scene.primitives.add(tileset);
            // The tileset is the whole planet, terrain included; the ellipsoid
            // underneath would only z-fight with it.
            viewer.scene.globe.show = false;
            imagery = 'google-3d';
            note = config.googleTilesKey ? 'Google photorealistic 3D tiles' : 'Google photorealistic 3D tiles via Cesium ion';
          } catch (e) {
            console.error('[theater] Google 3D tiles failed, falling back to Esri:', e);
            note = config.googleTilesKey ? 'Google 3D tiles did not load (check the key’s API restriction, referrers and quota) — showing satellite imagery instead.' : 'Photoreal tiles via Cesium ion did not load (check the token) — showing satellite imagery instead.';
          }
        }
        if (imagery === 'esri') {
          // showOnScreen: Esri's terms want the credit visible, not folded into Cesium's attribution popup.
          const provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY, { credit: new Cesium.Credit(ESRI_CREDIT, true), enablePickFeatures: false });
          if (cancelled) return;
          viewer.imageryLayers.addImageryProvider(provider);
        }

        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(start.lng, start.lat, start.alt),
          orientation: { heading: Cesium.Math.toRadians(start.heading), pitch: Cesium.Math.toRadians(start.pitch), roll: 0 },
        });

        // ── sensor looks ──
        styleManager = createStyleManager(Cesium, viewer);
        stylesRef.current = styleManager;
        if (STYLE_NAMES.has(wantedStyle) && wantedStyle !== 'normal') { styleManager.setStyle(wantedStyle); setStyle(wantedStyle); }

        // ── layers ──
        const flights = new FlightsLayer(Cesium, viewer);
        const sats = new SatellitesLayer(Cesium, viewer, 60_000);
        const cams = new CamerasLayer(Cesium, viewer);
        const canvass = new CanvassLayer(Cesium, viewer);
        const quakes = new EarthquakesLayer(Cesium, viewer);
        const tracks = new TracksLayer(Cesium, viewer);
        const vessels = new VesselsLayer(Cesium, viewer);
        built = [flights, sats, cams, canvass, quakes, tracks, vessels];
        const map = new Map<TheaterLayerId, TheaterLayer>([
          ['flights', flights], ['military', flights], ['vessels', vessels], ['satellites', sats], ['cctv', cams], ['canvass', canvass], ['earthquakes', quakes], ['tracks', tracks],
        ]);
        annLayerRef.current = new AnnotationsLayer(Cesium, viewer);
        traceRef.current = new TraceLayer(Cesium, viewer);
        // Our own double-click finishes a drawing; the Viewer's default would zoom to an entity.
        viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
        layersRef.current = map;
        setLayers(map);

        // ── picking ──
        handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction((click: { position: CesiumNS.Cartesian2 }) => {
          const live = viewerRef.current;
          if (!live) return;
          if (drawRef.current) { addDrawPointRef.current(click.position); return; }
          const picked = live.scene.pick(click.position);
          const pid = picked?.id;
          if (!isPickId(pid)) { setSelected(null); return; }
          const layer = layersRef.current?.get(pid.layer);
          const contact = layer?.contact(pid.id);
          if (!contact) return;
          const raw = layer instanceof CamerasLayer || layer instanceof CanvassLayer ? layer.rawOf(pid.id) : undefined;
          setSelected({ contact, raw });
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
        handler.setInputAction(() => { if (drawRef.current) finishDrawRef.current(); }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

        // ── per-frame: motion, follow camera, HUD ──
        const live = viewer;
        removePreRender = live.scene.preRender.addEventListener(() => {
          const t = Date.now();
          for (const l of built) l.tick(t);
          traceRef.current?.tick(t);
          const f = followRef.current;
          if (!f) return;
          const st = f.layer === 'tracks' ? tracks.state(f.id) : flights.state(f.id, t);
          if (!st) { stopFollow(); return; }
          const dt = Math.min(0.5, (t - f.lastT) / 1000);
          f.lastT = t;
          const preset = f.mode === 'cockpit' ? COCKPIT_PRESET : CHASE_PRESET;
          const pose = chasePose({ lat: st.lat, lng: st.lng, alt: st.alt, heading: st.heading }, preset);
          f.heading = slewHeading(f.heading, pose.heading, HEADING_SLEW_DEG_PER_S, dt);
          // Ground safety: sample the rendered surface under the camera twice a second at most.
          if (t - f.lastGroundAt > 500) {
            f.lastGroundAt = t;
            try {
              const h = live.scene.sampleHeight(Cesium.Cartographic.fromDegrees(pose.lng, pose.lat));
              if (typeof h === 'number' && Number.isFinite(h)) f.ground = h;
            } catch { /* surface not loaded yet */ }
          }
          const alt = f.ground === null ? pose.alt : cockpitGroundSafeHeight(pose.alt, f.ground, MIN_GROUND_CLEARANCE_M);
          live.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(pose.lng, pose.lat, alt),
            orientation: { heading: Cesium.Math.toRadians(f.heading), pitch: Cesium.Math.toRadians(pose.pitch), roll: 0 },
          });
          if (t - f.lastHudAt > 200) {
            f.lastHudAt = t;
            setHud({ speedKt: Math.round(st.speedMps / 0.514444), heading: Math.round(st.heading), altFt: Math.round(st.alt * 3.28084), coasting: st.coasting });
            // moveEnd never fires while the camera is driven every frame, so keep the readout honest here.
            setView({ lat: pose.lat, lng: pose.lng, alt, heading: f.heading, pitch: pose.pitch });
          }
        });

        // Keep the URL in step with the camera so a reload, or a link pasted into a
        // case note, returns to this exact view; refresh the canvass ring when the view settles.
        live.camera.moveEnd.addEventListener(() => {
          const v = readView(Cesium, live);
          setView(v);
          clearTimeout(writeTimer);
          writeTimer = setTimeout(() => {
            const qs = new URLSearchParams(window.location.search);
            for (const [k, val] of new URLSearchParams(theaterViewToSearch(v).slice(1))) qs.set(k, val);
            qs.set('layers', serializeLayerParam(activeRef.current));
            window.history.replaceState(null, '', `?${qs.toString()}`);
          }, 400);
          clearTimeout(canvassTimer);
          canvassTimer = setTimeout(() => refreshCanvassRef.current(), 600);
        });

        setStatus({ phase: 'ready', imagery, note });
      } catch (e) {
        console.error('[theater] failed to start:', e);
        if (!cancelled) setStatus({ phase: 'error', note: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(writeTimer);
      clearTimeout(canvassTimer);
      removePreRender?.();
      handler?.destroy();
      for (const l of built) l.dispose();
      traceRef.current?.dispose(); traceRef.current = null;
      annLayerRef.current?.dispose(); annLayerRef.current = null;
      styleManager?.dispose();
      stylesRef.current = null;
      layersRef.current = null;
      setLayers(null);
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cesiumVersion, attempt]);

  // ── layer visibility follows the toggles; the URL remembers them ──
  useEffect(() => {
    const map = layersRef.current;
    if (!map) return;
    const flights = map.get('flights') as FlightsLayer | undefined;
    flights?.setCategoryVisible('flights', active.has('flights'));
    flights?.setCategoryVisible('military', active.has('military'));
    for (const id of ['vessels', 'satellites', 'cctv', 'canvass', 'earthquakes', 'tracks'] as const) map.get(id)?.setVisible(active.has(id));
    const qs = new URLSearchParams(window.location.search);
    qs.set('layers', serializeLayerParam(active));
    window.history.replaceState(null, '', `?${qs.toString()}`);
  }, [active, layers]);

  // ── sensor look: applied to the scene and remembered in the URL ──
  const applyStyle = useCallback((name: string) => {
    if (!STYLE_NAMES.has(name)) return;
    stylesRef.current?.setStyle(name);
    setStyle(name);
    const qs = new URLSearchParams(window.location.search);
    if (name === 'normal') qs.delete('style'); else qs.set('style', name);
    window.history.replaceState(null, '', `?${qs.toString()}`);
  }, []);

  // ── contacts within 250 km of the selection, refreshed while the panel is open ──
  useEffect(() => {
    if (!contactsOpen || !selected) { setContacts([]); return; }
    const compute = () => {
      const map = layersRef.current;
      const c = selectedRef.current?.contact;
      if (!map || !c) return;
      const all: TheaterContact[] = [];
      const seen = new Set<TheaterLayer>();
      for (const l of map.values()) { if (seen.has(l)) continue; seen.add(l); for (const x of l.contacts()) if (!(x.layer === c.layer && x.id === c.id)) all.push(x); }
      setContacts(nearbyContacts(all, c.lat, c.lng, CONTACT_RADIUS_KM, 200));
    };
    compute();
    const timer = setInterval(compute, 2000);
    return () => clearInterval(timer);
  }, [contactsOpen, selected]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const startFollow = useCallback((mode: FollowMode) => {
    const viewer = viewerRef.current, Cesium = cesiumRef.current, c = selectedRef.current?.contact;
    const flights = layersRef.current?.get('flights') as FlightsLayer | undefined;
    const tracks = layersRef.current?.get('tracks') as TracksLayer | undefined;
    if (!viewer || !Cesium || !c) return;
    if (c.layer !== 'flights' && c.layer !== 'tracks') return;
    const layer = c.layer === 'tracks' ? tracks : flights;
    if (!layer) return;
    const prev = followRef.current;
    if (prev && prev.id !== c.id) { (prev.layer === 'tracks' ? tracks : flights)?.setPointHidden(prev.id, false); }
    // We are inside the aircraft in cockpit mode; its own dot would sit on the lens.
    layer.setPointHidden(c.id, mode === 'cockpit');
    if (c.layer === 'flights') flights?.setLabelsAround(c.id);
    viewer.scene.screenSpaceCameraController.enableInputs = false;
    followRef.current = { mode, id: c.id, layer: c.layer, heading: prev?.heading ?? Cesium.Math.toDegrees(viewer.camera.heading), lastT: Date.now(), ground: null, lastGroundAt: 0, lastHudAt: 0 };
    setFollow(mode);
  }, []);

  const flyTo = useCallback((c: TheaterContact) => {
    const viewer = viewerRef.current, Cesium = cesiumRef.current;
    if (!viewer || !Cesium) return;
    stopFollow();
    const radius = c.layer === 'satellites' ? 1.5e6 : c.layer === 'flights' || c.layer === 'tracks' ? 6000 : 400;
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(c.lng, c.lat, c.alt), radius), {
      duration: 2.0,
      offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(view.heading), Cesium.Math.toRadians(c.layer === 'satellites' ? -60 : -35), radius * 2.2),
    });
  }, [stopFollow, view.heading]);

  const pickContact = useCallback((c: NearbyContact) => {
    const layer = layersRef.current?.get(c.layer);
    const raw = layer instanceof CamerasLayer || layer instanceof CanvassLayer ? layer.rawOf(c.id) : undefined;
    setSelected({ contact: c, raw });
    flyTo(c);
  }, [flyTo]);

  const toggleLayer = useCallback((id: TheaterLayerId) => {
    setActive((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);

  // ── scenes bridge: what the shot list needs from the engine ──
  const sceneBridge: SceneBridge = useMemo(() => ({
    captureCamera: (): SceneShotCamera | null => {
      const viewer = viewerRef.current, Cesium = cesiumRef.current;
      if (!viewer || !Cesium) return null;
      const v = readView(Cesium, viewer);
      return { lat: v.lat, lng: v.lng, alt: v.alt, heading: v.heading, pitch: v.pitch };
    },
    currentStyle: style,
    currentLayers: Object.fromEntries(THEATER_LAYERS.map((l) => [l.id, active.has(l.id)])),
    applyStyle: (name) => applyStyle(name),
    applyLayers: (layers) => setActive(new Set(Object.entries(layers).filter(([k, v]) => v && isTheaterLayerId(k)).map(([k]) => k as TheaterLayerId))),
    travel: (camera, durationSec, signal) => new Promise<void>((resolve) => {
      const viewer = viewerRef.current, Cesium = cesiumRef.current;
      if (!viewer || !Cesium || signal.aborted) { resolve(); return; }
      stopFollow();
      const onAbort = () => { viewer.camera.cancelFlight(); resolve(); };
      signal.addEventListener('abort', onAbort, { once: true });
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(camera.lng, camera.lat, camera.alt),
        orientation: { heading: Cesium.Math.toRadians(camera.heading), pitch: Cesium.Math.toRadians(camera.pitch), roll: 0 },
        duration: durationSec,
        complete: () => { signal.removeEventListener('abort', onAbort); resolve(); },
        cancel: () => { signal.removeEventListener('abort', onAbort); resolve(); },
      });
    }),
    jumpTo: (camera) => {
      const viewer = viewerRef.current, Cesium = cesiumRef.current;
      if (!viewer || !Cesium) return;
      stopFollow();
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(camera.lng, camera.lat, camera.alt),
        orientation: { heading: Cesium.Math.toRadians(camera.heading), pitch: Cesium.Math.toRadians(camera.pitch), roll: 0 },
        duration: 1.2,
      });
    },
    onPlayingChange: (p) => { setPlaying(p); if (p) { stopFollow(); setSelected(null); setContactsOpen(false); } },
  }), [style, active, applyStyle, stopFollow]);

  // ── history bridge: the HISTORY panel drives the tracks layer; the layer answers picks ──
  const historyBridge: HistoryBridge = useMemo(() => ({
    setTracks: (tracks) => {
      (layersRef.current?.get('tracks') as TracksLayer | undefined)?.update({ tracks });
      if (tracks.length) setActive((prev) => (prev.has('tracks') ? prev : new Set(prev).add('tracks')));
    },
    setPlayhead: (t) => (layersRef.current?.get('tracks') as TracksLayer | undefined)?.setPlayhead(t),
    flyToTrack: (hex) => {
      const c = layersRef.current?.get('tracks')?.contact(hex);
      if (c) { setSelected({ contact: c }); flyTo(c); }
    },
  }), [flyTo]);

  // ── annotations: draw by clicking, or by Scout with coordinates; the layer mirrors the list ──
  const applyAnnotations = useCallback((next: Annotation[]) => { setAnnotations(next); annLayerRef.current?.set(next); }, []);
  const cancelDraw = useCallback(() => { drawRef.current = null; setDrawMode(null); setDraftPoints(0); annLayerRef.current?.draft(null, []); }, []);
  const startDraw = useCallback((kind: AnnotationKind) => { drawRef.current = { kind, points: [] }; setDrawMode(kind); setDraftPoints(0); annLayerRef.current?.draft(null, []); setAnnotateOpen(true); }, []);
  const removeAnnotation = useCallback((id: string) => { applyAnnotations(annotations.filter((a) => a.id !== id)); }, [annotations, applyAnnotations]);
  const flyToAnnotation = useCallback((id: string) => {
    const a = annotations.find((x) => x.id === id);
    const viewer = viewerRef.current, Cesium = cesiumRef.current;
    if (!a || !viewer || !Cesium) return;
    const c = a.points.reduce((s, p) => ({ lat: s.lat + p.lat / a.points.length, lng: s.lng + p.lng / a.points.length }), { lat: 0, lng: 0 });
    const span = a.points.length > 1 ? Math.max(...a.points.map((p) => Math.hypot(p.lat - c.lat, (p.lng - c.lng) * Math.cos((c.lat * Math.PI) / 180)))) * 111_000 : 0;
    stopFollow();
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(c.lng, c.lat, Math.max(300, span * 3)), orientation: { heading: Cesium.Math.toRadians(view.heading), pitch: Cesium.Math.toRadians(-60), roll: 0 }, duration: 1.4 });
  }, [annotations, stopFollow, view.heading]);
  useEffect(() => {
    // The engine's click handler is created once; it reaches the live list and label through refs.
    addDrawPointRef.current = (pos) => {
      const viewer = viewerRef.current, Cesium = cesiumRef.current, d = drawRef.current, layer = annLayerRef.current;
      if (!viewer || !Cesium || !d || !layer) return;
      let cart: CesiumNS.Cartesian3 | undefined;
      try { cart = viewer.scene.pickPositionSupported ? viewer.scene.pickPosition(pos) : undefined; } catch { cart = undefined; }
      if (!cart) cart = viewer.camera.pickEllipsoid(pos) ?? undefined;
      if (!cart) return;
      const c = Cesium.Cartographic.fromCartesian(cart);
      const pt: AnnotationPoint = { lat: Cesium.Math.toDegrees(c.latitude), lng: Cesium.Math.toDegrees(c.longitude), alt: Math.max(0, c.height) };
      const last = d.points[d.points.length - 1];
      if (last && Math.abs(last.lat - pt.lat) < 1e-7 && Math.abs(last.lng - pt.lng) < 1e-7) return; // the first click of a double-click already landed
      d.points.push(pt);
      if (d.kind === 'pin' || d.kind === 'label') { finishDrawRef.current(); return; }
      setDraftPoints(d.points.length);
      layer.draft(d.kind, d.points, annLabelRef.current || undefined);
    };
    finishDrawRef.current = () => {
      const d = drawRef.current;
      if (!d) return;
      const v = validateAnnotation({ kind: d.kind, points: d.points, label: annLabelRef.current || undefined });
      if (!v.ok) { if (d.kind === 'label') setAnnLabel(''); annLayerRef.current?.draft(null, []); if (d.kind !== 'label') return; drawRef.current = null; setDrawMode(null); setDraftPoints(0); return; }
      const next = [...annotations, v.item].slice(0, ANNOTATION_MAX);
      applyAnnotations(next);
      annLayerRef.current?.draft(null, []);
      setAnnLabel(''); annLabelRef.current = ''; // a label belongs to one mark
      // pins and labels stay in their mode for the next click; lines finish the mode
      if (d.kind === 'pin' || d.kind === 'label') { drawRef.current = { kind: d.kind, points: [] }; setDraftPoints(0); }
      else { drawRef.current = null; setDrawMode(null); setDraftPoints(0); }
    };
  }, [annotations, applyAnnotations]);

  // ── trace: the last day's flown path of one aircraft, from adsb.lol, with replay ──
  const clearTrace = useCallback(() => { traceRef.current?.clear(); setTrace(null); setTracePlay(null); setTraceErr(null); }, []);
  const frameTrace = useCallback((info: TraceInfo) => {
    const viewer = viewerRef.current, Cesium = cesiumRef.current;
    if (!viewer || !Cesium) return;
    stopFollow();
    const sphere = traceRef.current?.boundingSphere();
    if (sphere) viewer.camera.flyToBoundingSphere(sphere, { duration: 1.6, offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-55), Math.max(6000, sphere.radius * 2.4)) });
    else viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(info.center.lng, info.center.lat, Math.max(4000, info.spanM * 1.7)), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 }, duration: 1.6 });
  }, [stopFollow]);
  const loadTrace = useCallback(async (icao24: string, frame = true): Promise<{ ok: boolean; note?: string; info?: TraceInfo }> => {
    const hex = icao24.trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return { ok: false, note: 'this contact has no ICAO24 hex address, so no trace can be fetched' };
    setTraceBusy(hex); setTraceErr(null);
    try {
      const r = await fetch(`/api/aircraft?icao24=${hex}&legs=all&max=2500`, { signal: AbortSignal.timeout(25_000) });
      const j = (await r.json()) as TraceDetail & { error?: string };
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      if (!traceRef.current) throw new Error('theater not ready');
      if (!j.track?.length) throw new Error('no path in the last 24 h from community receivers (identity only)');
      const info = traceRef.current.show(j);
      setTrace(info); setTracePlay(traceRef.current.state());
      if (frame) frameTrace(info);
      return { ok: true, info };
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      setTraceErr(note); setTrace(null); setTracePlay(null);
      return { ok: false, note };
    } finally { setTraceBusy(null); }
  }, [frameTrace]);
  useEffect(() => {
    // the playhead moves in the render loop; React only needs a 4 Hz read of it
    if (!trace) return;
    const id = window.setInterval(() => { const s = traceRef.current?.state(); if (s) setTracePlay((prev) => (prev && prev.t === s.t && prev.playing === s.playing && prev.rate === s.rate ? prev : s)); }, 250);
    return () => window.clearInterval(id);
  }, [trace]);

  // ── detect: the operator's loopback YOLO tracker on a camera's feed (present only on the owner's Mac) ──
  useEffect(() => {
    let alive = true;
    fetch('/api/tracker/health', { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).then((j: { ok?: boolean }) => { if (alive) setTrackerOnline(!!j.ok); }).catch(() => { if (alive) setTrackerOnline(false); });
    return () => { alive = false; };
  }, []);
  const runDetect = useCallback(async (camId: string, raw: Record<string, unknown> | undefined, windowS = 8): Promise<{ ok: boolean; note?: string; result?: DetectResult }> => {
    const url = String(raw?.feed_url || raw?.stream_url || '');
    const kind = String(raw?.stream_type || '');
    if (!url) return { ok: false, note: 'this camera publishes no feed to analyse' };
    if (kind === 'iframe') return { ok: false, note: 'this camera is an embedded player; the tracker cannot read it from here' };
    setDetect({ camId, status: 'running', startedAt: Date.now(), windowS });
    try {
      const r = await fetch('/api/tracker/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, kind: kind === 'jpg' ? 'jpg' : 'auto', max_seconds: windowS, poll_s: 2, conf: 0.35 }), signal: AbortSignal.timeout(60_000) });
      const j = (await r.json()) as DetectResult & { error?: string };
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      const result: DetectResult = { job_id: j.job_id, annotated_url: j.annotated_url ?? null, meta: j.meta || {}, vehicles: Array.isArray(j.vehicles) ? j.vehicles : [] };
      setDetect({ camId, status: 'done', result, startedAt: Date.now(), windowS });
      return { ok: true, result };
    } catch (e) {
      const note = e instanceof Error ? (e.name === 'TimeoutError' ? 'the tracker did not answer in 60 s' : e.message) : String(e);
      setDetect({ camId, status: 'error', error: note, startedAt: Date.now(), windowS });
      return { ok: false, note };
    }
  }, []);

  // ── staged camera frames: the cameras layer floats nearby snapshot frames in the scene below 6 km ──
  useEffect(() => {
    if (!active.has('cctv')) { setStaged({ staged: 0, loaded: 0 }); return; }
    const id = window.setInterval(() => { const cams = layersRef.current?.get('cctv'); if (cams instanceof CamerasLayer) { const s = cams.stagedCount(); setStaged((p) => (p.staged === s.staged && p.loaded === s.loaded ? p : s)); } }, 1000);
    return () => window.clearInterval(id);
  }, [active]);
  useEffect(() => {
    const id = window.setInterval(() => { const fl = layersRef.current?.get('flights'); if (fl instanceof FlightsLayer) setModelCount(fl.modelCount()); }, 1000);
    return () => window.clearInterval(id);
  }, []);
  // the selected / followed airframe always wears its 3D model
  useEffect(() => {
    const fl = layersRef.current?.get('flights');
    const f = followRef.current;
    if (fl instanceof FlightsLayer) fl.setFocus(f?.layer === 'flights' ? f.id : selected?.contact.layer === 'flights' ? selected.contact.id : null);
  }, [selected, follow]);
  const nearestCam = useCallback(() => {
    const cams = layersRef.current?.get('cctv');
    const c = selectedRef.current?.contact;
    if (!(cams instanceof CamerasLayer) || !c) return;
    if (!active.has('cctv')) setActive((prev) => new Set(prev).add('cctv'));
    const hit = cams.nearestTo(c.lat, c.lng);
    if (!hit) return; // catalogue not loaded yet: the layer is now on, press again once it lands
    stopFollow();
    setSelected({ contact: hit.contact, raw: hit.raw });
    flyTo(hit.contact);
  }, [active, flyTo, stopFollow]);

  // ── watch bridge: the WATCHLIST panel selects a watched airframe that is on screen ──
  const watchBridge: WatchBridge = useMemo(() => ({
    selectByHex: (hex) => {
      const c = layersRef.current?.get('flights')?.contact(hex.toLowerCase());
      if (!c) return false;
      setSelected({ contact: c }); flyTo(c);
      return true;
    },
    flyTo: (lat, lng, altM) => {
      const viewer = viewerRef.current, Cesium = cesiumRef.current;
      if (!viewer || !Cesium) return;
      stopFollow();
      viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lng, lat, altM), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 }, duration: 1.6 });
    },
  }), [flyTo, stopFollow]);

  // ── Scout: what the assistant can do while the theater is on screen ──
  useEffect(() => registerActuators({
    view: () => ({
      page: 'theater', path: '/theater',
      camera: { lat: view.lat, lng: view.lng, altitudeM: Math.round(view.alt), heading: Math.round(view.heading), pitch: Math.round(view.pitch) },
      layersOn: [...active], style,
      selected: selected ? { layer: selected.contact.layer, id: selected.contact.id, name: selected.contact.name } : null,
      follow,
      // Per-feed counts (what the layer panel shows): "flights" and "military" share one layer
      // object, so layer.count() would report the same total under both ids.
      counts: Object.fromEntries(THEATER_LAYERS.filter((l) => active.has(l.id)).map((l) => [l.id, feeds[l.id]?.count ?? 0])),
      history: (() => { const i = historyRef.current?.info(); return i ? { from: new Date(i.from).toISOString(), to: new Date(i.to).toISOString(), tracks: i.tracks, fixes: i.fixes, playhead: new Date(i.playhead).toISOString(), playing: i.playing } : null; })(),
      annotations: annotations.map((a) => ({ id: a.id, kind: a.kind, label: a.label, points: a.points.length, measure: measureOf(a)?.text })),
      trace: trace ? { icao24: trace.icao24, label: trace.label, points: trace.points, from: trace.from !== null ? new Date(trace.from * 1000).toISOString() : null, to: trace.to !== null ? new Date(trace.to * 1000).toISOString() : null, distanceKm: Math.round(trace.distanceKm * 10) / 10 } : null,
    }),
    loadHistory: async (fromMs, toMs) => {
      setHistoryOpen(true);
      // The panel registers its handle on mount; give it a beat when it was closed.
      for (let i = 0; i < 20 && !historyRef.current; i++) await new Promise((r) => setTimeout(r, 50));
      if (!historyRef.current) return { ok: false, note: 'the HISTORY panel did not open' };
      return historyRef.current.load(fromMs, toMs);
    },
    flyTo: ({ lat, lng, altitudeM, zoom, heading, pitch }) => {
      const viewer = viewerRef.current, Cesium = cesiumRef.current;
      if (!viewer || !Cesium) return { ok: false, note: 'the 3D engine is not ready yet' };
      stopFollow();
      const alt = Math.min(5e6, Math.max(50, altitudeM ?? (zoom !== undefined ? altitudeForZoom(zoom, lat) : 1200)));
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lng, lat, alt),
        orientation: { heading: Cesium.Math.toRadians(heading ?? view.heading), pitch: Cesium.Math.toRadians(pitch ?? -35), roll: 0 },
        duration: 2.0,
      });
      return { ok: true, altitude_m: Math.round(alt) };
    },
    listLayers: () => THEATER_LAYERS.map((l) => ({ id: l.id, on: active.has(l.id) })),
    setLayer: (id, on) => {
      if (!isTheaterLayerId(id)) return { ok: false, note: `unknown 3D layer; available: ${THEATER_LAYERS.map((l) => l.id).join(', ')}` };
      setActive((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });
      return { ok: true };
    },
    setStyle: (name) => {
      if (!SENSOR_STYLES.some((s) => s.name === name)) return { ok: false, note: `styles: ${SENSOR_STYLES.map((s) => s.name).join(', ')}` };
      applyStyle(name);
      return { ok: true };
    },
    follow: (mode) => {
      if (mode === 'off') { stopFollow(); return { ok: true }; }
      const c = selectedRef.current?.contact;
      if (!c || (c.layer !== 'flights' && c.layer !== 'tracks')) return { ok: false, note: 'select an aircraft or a recorded track first (select_contact)' };
      startFollow(mode);
      return { ok: true, following: c.name, recorded: c.layer === 'tracks' };
    },
    selectContact: (query) => {
      const q = query.toLowerCase();
      const map = layersRef.current;
      if (!map) return { ok: false, note: 'no layers loaded' };
      const seen = new Set<TheaterLayer>();
      const all: TheaterContact[] = [];
      for (const l of map.values()) { if (seen.has(l)) continue; seen.add(l); for (const x of l.contacts()) all.push(x); }
      const hit = all.find((x) => x.name.toLowerCase() === q) ?? all.find((x) => x.name.toLowerCase().includes(q));
      if (!hit) return { ok: false, note: `no live contact matches "${query}" among ${all.length} loaded (are the right layers on?)` };
      pickContact({ ...hit, distanceKm: 0, bearingDeg: 0 });
      return { ok: true, selected: { layer: hit.layer, id: hit.id, name: hit.name, lat: hit.lat, lng: hit.lng } };
    },
    nearby: (radiusKm, limit) => {
      const map = layersRef.current;
      const centre = selectedRef.current?.contact ?? getViewCenter();
      if (!map || !centre) return [];
      const seen = new Set<TheaterLayer>();
      const all: TheaterContact[] = [];
      const sel = selectedRef.current?.contact;
      for (const l of map.values()) { if (seen.has(l)) continue; seen.add(l); for (const x of l.contacts()) if (!(sel && x.layer === sel.layer && x.id === sel.id)) all.push(x); }
      return nearbyContacts(all, centre.lat, centre.lng, radiusKm, limit).map((c) => ({ layer: c.layer, id: c.id, name: c.name, lat: c.lat, lng: c.lng, distanceKm: c.distanceKm, bearingDeg: c.bearingDeg }));
    },
    playScene: (id) => { setSceneStart({ id, play: true }); setScenesOpen(true); return { ok: true }; },
    annotate: (items, replace) => {
      const added: { id: string; kind: string; label?: string; measure?: string }[] = [];
      const errors: string[] = [];
      const next = replace ? [] : [...annotations];
      for (const raw of items) {
        const v = validateAnnotation(raw);
        if (!v.ok) { errors.push(v.errors.join('; ')); continue; }
        if (next.length >= ANNOTATION_MAX) { errors.push(`at most ${ANNOTATION_MAX} annotations`); break; }
        next.push(v.item);
        added.push({ id: v.item.id, kind: v.item.kind, label: v.item.label, measure: measureOf(v.item)?.text });
      }
      applyAnnotations(next);
      if (added.length) setAnnotateOpen(true);
      return { ok: added.length > 0, added, errors, total: next.length, note: added.length ? undefined : 'nothing added' };
    },
    clearAnnotations: () => { const n = annotations.length; applyAnnotations([]); return { ok: true, removed: n }; },
    showTrace: async (query) => {
      const q = query.trim().toLowerCase();
      let hex = /^[0-9a-f]{6}$/.test(q) ? q : null;
      if (!hex) {
        const fl = layersRef.current?.get('flights');
        const all = fl ? [...fl.contacts()] : [];
        const hit = all.find((x) => x.name.toLowerCase() === q) ?? all.find((x) => x.name.toLowerCase().includes(q));
        if (!hit) return { ok: false, note: `no live aircraft matches "${query}" on screen (${all.length} loaded)` };
        hex = hit.id;
      }
      const r = await loadTrace(hex);
      if (!r.ok || !r.info) return { ok: false, note: r.note };
      const i = r.info;
      return { ok: true, icao24: i.icao24, label: i.label, points: i.points, from: i.from !== null ? new Date(i.from * 1000).toISOString() : null, to: i.to !== null ? new Date(i.to * 1000).toISOString() : null, distance_km: Math.round(i.distanceKm * 10) / 10, min_alt_ft: i.minAltFt, max_alt_ft: i.maxAltFt, replayable: i.replayable, source: i.source, note: 'community-receiver coverage: gaps in the line are gaps in reception' };
    },
    clearTrace: () => { const had = !!traceRef.current?.current(); clearTrace(); return { ok: true, removed: had }; },
    detectVehicles: async (query) => {
      if (!trackerOnline) return { ok: false, note: "the on-device tracker is offline — it runs only on the operator's own Mac" };
      let target = selected && selected.contact.layer === 'cctv' ? selected : null;
      if (query) {
        const q = query.toLowerCase();
        const cams = layersRef.current?.get('cctv');
        const all = cams ? [...cams.contacts()] : [];
        const hit = all.find((x) => x.name.toLowerCase() === q) ?? all.find((x) => x.name.toLowerCase().includes(q));
        if (!hit) return { ok: false, note: `no camera on screen matches "${query}" (${all.length} loaded — is the Cameras layer on?)` };
        target = { contact: hit, raw: cams instanceof CamerasLayer ? cams.rawOf(hit.id) : undefined };
        setSelected(target);
      }
      if (!target) return { ok: false, note: 'select a camera first, or name one' };
      const r = await runDetect(target.contact.id, target.raw);
      if (!r.ok || !r.result) return { ok: false, note: r.note };
      const v = r.result.vehicles;
      return { ok: true, camera: target.contact.name, window_s: 8, frames: r.result.meta.frames ?? null, vehicles: v.length, summary: summarizeDetections(v), detections: v.slice(0, 12).map((x) => ({ type: x.type, color: x.color ?? null, direction: x.direction ?? null, dwell_s: x.dwell_s ?? null })), note: 'on-device yolo11s detections in an 8 s window — counts, not identities; none seen ≠ empty road' };
    },
  }), [view, active, style, selected, follow, feeds, annotations, applyAnnotations, applyStyle, stopFollow, startFollow, pickContact, getViewCenter, loadTrace, clearTrace, runDetect, trackerOnline]);

  // ── keyboard: Esc stop/close · F follow · C cockpit · K contacts · L layers · 1–7 sensor looks ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      // Keyboard camera: arrows look around (turn the head in place), shift+arrows move the
      // map, + / - zoom. Steps scale with height so they feel the same at 300 m and 30 km.
      if (k.startsWith('Arrow') || k === '+' || k === '=' || k === '-' || k === '_') {
        const viewer = viewerRef.current, Cesium = cesiumRef.current;
        if (!viewer || !Cesium || followRef.current) return;
        e.preventDefault();
        const cam = viewer.camera;
        const h = Math.max(50, cam.positionCartographic.height);
        if (k === '+' || k === '=') { cam.zoomIn(h * 0.2); return; }
        if (k === '-' || k === '_') { cam.zoomOut(h * 0.25); return; }
        if (e.shiftKey) {
          const step = h * 0.08;
          if (k === 'ArrowLeft') cam.moveLeft(step); else if (k === 'ArrowRight') cam.moveRight(step);
          else if (k === 'ArrowUp') cam.moveUp(step); else if (k === 'ArrowDown') cam.moveDown(step);
          return;
        }
        const turn = Cesium.Math.toRadians(3);
        const heading = cam.heading + (k === 'ArrowRight' ? turn : k === 'ArrowLeft' ? -turn : 0);
        const pitch = Math.max(Cesium.Math.toRadians(-89), Math.min(Cesium.Math.toRadians(5), cam.pitch + (k === 'ArrowUp' ? turn : k === 'ArrowDown' ? -turn : 0)));
        cam.setView({ orientation: { heading, pitch, roll: 0 } });
        return;
      }
      if (k === 'Escape' && drawRef.current) { cancelDraw(); return; }
      if (k === 'Enter' && drawRef.current) { finishDrawRef.current(); return; }
      if (k === 'Escape') { if (followRef.current) stopFollow(); else if (contactsOpen) setContactsOpen(false); else setSelected(null); }
      else if (k === 'c' || k === 'C') { if (followRef.current?.mode === 'cockpit') stopFollow(); else startFollow('cockpit'); }
      else if (k === 'f' || k === 'F') { if (followRef.current?.mode === 'chase') stopFollow(); else startFollow('chase'); }
      else if (k === 'l' || k === 'L') setPanelOpen((o) => !o);
      else if (k === 'k' || k === 'K') setContactsOpen((o) => { if (!o) setPanelOpen(false); return !o; }); // contacts take the left stack
      else if (k === 's' || k === 'S') setScenesOpen((o) => !o);
      else if (k === 'h' || k === 'H') setHistoryOpen((o) => !o);
      else if (k === 'w' || k === 'W') setWatchOpen((o) => !o);
      else if (k === 'a' || k === 'A') setAnnotateOpen((o) => !o);
      else if (k === 'r' || k === 'R') setRecording((o) => !o);
      else if (k === 't' || k === 'T') { const s = selectedRef.current; if (s?.contact.layer === 'flights') { if (traceRef.current?.current()?.icao24 === s.contact.id) clearTrace(); else void loadTrace(s.contact.id); } }
      else if (/^[1-7]$/.test(k)) { const s = SENSOR_STYLES.find((x) => x.key === k); if (s) applyStyle(s.name); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contactsOpen, startFollow, stopFollow, applyStyle, cancelDraw, clearTrace, loadTrace]);

  // Same parameter names the flat map's Share panel writes (lat / lon / zoom).
  const flatHref = `/?lat=${view.lat.toFixed(5)}&lon=${view.lng.toFixed(5)}&zoom=${zoomForAltitude(view.alt, view.lat).toFixed(2)}`;
  const selectedRaw = useMemo(() => selected?.raw, [selected]);

  // ── the God's Eye shell: this page owns the viewport (global nav hidden), round actions, dock ──
  useEffect(() => {
    document.documentElement.dataset.surface = 'theater';
    return () => { delete document.documentElement.dataset.surface; };
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const [searchQ, setSearchQ] = useState('');
  const [searching, setSearching] = useState(false);
  const showToast = useCallback((m: string) => { setToast(m); window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToast(null), 1800); }, []);
  const flyCamera = useCallback((lat: number, lng: number, alt: number, heading: number, pitch: number) => {
    const viewer = viewerRef.current, Cesium = cesiumRef.current;
    if (!viewer || !Cesium) return;
    stopFollow();
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lng, lat, alt), orientation: { heading: Cesium.Math.toRadians(heading), pitch: Cesium.Math.toRadians(pitch), roll: 0 }, duration: 1.6 });
  }, [stopFollow]);
  const tilted = view.pitch > -60;
  const searchPlace = async () => {
    const q = searchQ.trim();
    if (!q) return;
    setSearching(true);
    try {
      const r = await fetch(`/api/geosearch?q=${encodeURIComponent(q)}`);
      const j = (await r.json()) as { results?: { name: string; lat: number; lng: number }[] };
      const hit = j.results?.[0];
      if (!hit) { showToast('NO MATCH'); return; }
      flyCamera(hit.lat, hit.lng, 1200, view.heading, -35);
      showToast(hit.name.toUpperCase().slice(0, 40));
    } catch { showToast('SEARCH FAILED'); } finally { setSearching(false); }
  };
  const utc = new Date(now).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  const styleLabel = SENSOR_STYLES.find((s) => s.name === style)?.label ?? style.toUpperCase();
  const militaryFollow = /military/.test(selected?.contact.kind ?? '');

  return (
    <main className={`theater ${follow ? `is-following is-${follow}` : ''} style-${style} ${playing ? 'is-playing' : ''} ${scenesOpen ? 'scenes-open' : ''} ${drawMode ? 'is-drawing' : ''}`} data-style={style} data-skin={skin} data-recording={recording ? 'true' : undefined}>
      <div ref={holder} className="theater-canvas" aria-label="3D view" />
      <div className="theater-scope" aria-hidden />
      {style !== 'normal' && status.phase === 'ready' && (
        <div className="theater-intel" aria-hidden>
          <i /><i /><i /><i /><b><span /></b>
          <em>{styleLabel} · {status.imagery === 'google-3d' ? 'PHOTOREAL' : 'SAT'}</em><em>{utc}</em>
        </div>
      )}

      <div className="theater-brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <h1><img src="/eye-of-horus.svg" alt="" /> LOOKOUT <span>THEATER</span></h1>
        <p>Personal intelligence · <b>self-hosted</b> · nothing leaves this machine</p>
      </div>

      <nav className="theater-actions" aria-label="Globe actions">
        <Link href={flatHref} aria-label="Back to the flat map at this location" title="Flat map">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M19 12H5m0 0 6-6m-6 6 6 6" /></svg>
        </Link>
        <button type="button" aria-label="Data layers" aria-pressed={panelOpen} onClick={() => setPanelOpen((o) => !o)} title="Layers (L)">
          <svg viewBox="0 0 24 24" aria-hidden><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></svg>
        </button>
        <button type="button" aria-label={tilted ? 'Look straight down' : 'Tilt to an oblique view'} aria-pressed={tilted} onClick={() => flyCamera(view.lat, view.lng, view.alt, view.heading, tilted ? -90 : -35)} title="Straight down / oblique">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M4 16 12 6l8 10H4Z" /><path d="M4 20h16" /></svg>
        </button>
        <button type="button" className="theater-compass" style={{ ['--heading' as string]: `${Math.round(view.heading)}deg` }} aria-label="Reset to north up" onClick={() => flyCamera(view.lat, view.lng, view.alt, 0, view.pitch)} title="North up">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M12 3 8 14l4-2 4 2-4-11Z" /><path d="M12 12v9" /></svg>
        </button>
        <button type="button" aria-label="Reset to full globe" onClick={() => flyCamera(DEFAULT_THEATER_VIEW.lat, DEFAULT_THEATER_VIEW.lng, DEFAULT_THEATER_VIEW.alt, 0, DEFAULT_THEATER_VIEW.pitch)} title="Full globe">
          <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></svg>
        </button>
        <button type="button" aria-label="Copy share link" onClick={() => { navigator.clipboard.writeText(window.location.href).then(() => showToast('LINK COPIED'), () => showToast('COPY FAILED')); }} title="Copy link">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" /></svg>
        </button>
        <button type="button" aria-label="Console and other surfaces" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)} title="Console · Fisherman">
          <svg viewBox="0 0 24 24" aria-hidden><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
        </button>
      </nav>
      {menuOpen && (
        <div className="theater-menu" role="menu" onMouseLeave={() => setMenuOpen(false)}>
          {KIT ? (
            <a href={process.env.NEXT_PUBLIC_LOOKOUT_REPO_URL || 'https://github.com/ExtremeAI-Labs/lookout'} role="menuitem" target="_blank" rel="noopener">◇ Source &amp; docs</a>
          ) : (<>
            <a href="/console" role="menuitem">◇ Console · lookups &amp; cases</a>
            <Link href={flatHref} role="menuitem">◉ Working map</Link>
            <a href="/fisherman" role="menuitem">⌖ Fisherman</a>
          </>)}
        </div>
      )}
      {toast && <div className="theater-toast" role="status">{toast}</div>}

      <div className="theater-indicator">
        <span className="label">Active style</span>
        <span className="value">{styleLabel}</span>
        <span className="theater-rec" suppressHydrationWarning>REC {utc}</span>
        <span className="theater-telemetry">
          <b className={status.phase === 'ready' && status.imagery === 'google-3d' ? 'ok' : ''}>{status.phase === 'ready' ? (status.imagery === 'google-3d' ? 'PHOTOREAL' : 'KEYLESS · SAT') : status.phase.toUpperCase()}</b>
          {feeds.flights.updatedAt ? <> · AIR <b>{feeds.flights.count.toLocaleString()}</b> · MIL <b>{feeds.military.count.toLocaleString()}</b></> : null}
          {active.has('satellites') && feeds.satellites.updatedAt ? <> · SAT <b>{feeds.satellites.count.toLocaleString()}</b></> : null}
        </span>
        {follow && <div className="theater-pill is-follow">{follow === 'cockpit' ? 'COCKPIT' : 'FOLLOWING'} · {selected?.contact.name}</div>}
      </div>

      {status.phase === 'ready' && (
        <>
          <ScenesPanel bridge={sceneBridge} open={scenesOpen} onOpenChange={setScenesOpen} initialSceneId={sceneStart.id} autoplay={sceneStart.play} />
          <HistoryPanel bridge={historyBridge} open={historyOpen} onOpenChange={setHistoryOpen} handleRef={historyRef} initialWindow={historyStart} />
          <WatchPanel bridge={watchBridge} open={watchOpen} onOpenChange={setWatchOpen} />
          <AnnotatePanel open={annotateOpen} onOpenChange={setAnnotateOpen} annotations={annotations} drawMode={drawMode} draftPoints={draftPoints} label={annLabel} onLabel={(s) => { setAnnLabel(s); annLabelRef.current = s; }} onStart={startDraw} onFinish={() => finishDrawRef.current()} onCancel={cancelDraw} onRemove={removeAnnotation} onClear={() => applyAnnotations([])} onFly={flyToAnnotation} camera={{ lat: view.lat, lng: view.lng, alt: view.alt, heading: view.heading, pitch: view.pitch }} />
        </>
      )}
      {status.phase === 'ready' && (
        <TheaterLayerPanel active={active} status={feeds} onToggle={toggleLayer} open={panelOpen} onOpenChange={setPanelOpen} now={now} />
      )}

      {selected && status.phase === 'ready' && !scenesOpen && !historyOpen && !watchOpen && !annotateOpen && (
        <TheaterInfoCard
          contact={selected.contact}
          raw={selectedRaw}
          onClose={() => { stopFollow(); setSelected(null); setContactsOpen(false); }}
          onFollow={selected.contact.layer === 'flights' || selected.contact.layer === 'tracks' ? () => (follow ? stopFollow() : startFollow('chase')) : undefined}
          following={!!follow}
          onFly={() => flyTo(selected.contact)}
          onTrace={selected.contact.layer === 'flights' ? () => { if (trace?.icao24 === selected.contact.id) clearTrace(); else void loadTrace(selected.contact.id); } : undefined}
          traceActive={!!trace && trace.icao24 === selected.contact.id}
          traceBusy={traceBusy === selected.contact.id}
          onDetect={trackerOnline && selected.contact.layer === 'cctv' && selected.raw && (selected.raw.feed_url || selected.raw.stream_url) && selected.raw.stream_type !== 'iframe' ? () => void runDetect(selected.contact.id, selected.raw) : undefined}
          detectBusy={detect?.camId === selected.contact.id && detect.status === 'running'}
          onNearestCam={selected.contact.layer !== 'cctv' ? nearestCam : undefined}
        >
          {selected.contact.layer === 'cctv' && detect && detect.camId === selected.contact.id && <DetectPanel state={detect} onRun={() => void runDetect(selected.contact.id, selected.raw)} />}
          {selected.contact.layer === 'flights' && (traceBusy === selected.contact.id || (traceErr && !trace) || (trace && trace.icao24 === selected.contact.id)) && (
            <TracePanel info={trace && trace.icao24 === selected.contact.id ? trace : null} play={tracePlay} loading={traceBusy === selected.contact.id} error={trace ? null : traceErr}
              onSeek={(f) => { traceRef.current?.seek(f); setTracePlay(traceRef.current?.state() ?? null); }}
              onPlay={(on) => { traceRef.current?.setPlaying(on); setTracePlay(traceRef.current?.state() ?? null); }}
              onRate={(r) => { traceRef.current?.setRate(r); setTracePlay(traceRef.current?.state() ?? null); }}
              onFrame={() => trace && frameTrace(trace)} onClear={clearTrace} />
          )}
        </TheaterInfoCard>
      )}
      {selected && status.phase === 'ready' && !scenesOpen && !historyOpen && !watchOpen && (
        <button className="theater-btn theater-contacts-toggle" onClick={() => setContactsOpen((o) => { if (!o) setPanelOpen(false); return !o; })} aria-pressed={contactsOpen}>
          {contactsOpen ? 'HIDE CONTACTS' : 'CONTACTS · 250 KM'}
        </button>
      )}
      {selected && contactsOpen && !scenesOpen && (
        <TheaterContactsPanel around={selected.contact} contacts={contacts} onPick={pickContact} onClose={() => setContactsOpen(false)} />
      )}

      {follow && hud && (
        <div className={`theater-cockpit ${hud.coasting ? 'is-coasting' : ''} ${militaryFollow ? 'is-military' : ''}`} aria-live="off">
          <div className="theater-cockpit-dials">
            <div><span>GROUND SPEED</span><b>{hud.speedKt}</b><i>kt</i></div>
            <div><span>HEADING</span><b>{String(hud.heading).padStart(3, '0')}</b><i>°</i></div>
            <div><span>ALTITUDE</span><b>{hud.altFt.toLocaleString()}</b><i>ft</i></div>
          </div>
          {hud.coasting && <div className="theater-cockpit-note">position is dead-reckoned — no fresh report</div>}
          <div className="theater-cockpit-actions">
            <button className="theater-btn" onClick={() => startFollow(follow === 'cockpit' ? 'chase' : 'cockpit')}>{follow === 'cockpit' ? 'CHASE VIEW' : 'COCKPIT'}</button>
            <button className="theater-btn" onClick={stopFollow}>EXIT</button>
          </div>
        </div>
      )}

      {recording && (
        <div className="theater-safeframe" aria-hidden>
          <div className="frame" /><div className="title" />
          <div className="tag">REC FRAME 16:9 · TITLE-SAFE 90% · PRIVATE BLURRED · R TO EXIT</div>
        </div>
      )}
      <div className="theater-readout" aria-live="off">
        <span>{view.lat.toFixed(5)}° {view.lat >= 0 ? 'N' : 'S'} · {Math.abs(view.lng).toFixed(5)}° {view.lng >= 0 ? 'E' : 'W'}</span>
        {staged.staged > 0 && <span>CAMERAS STAGED {staged.loaded}/{staged.staged} · latest frames, via the console proxy</span>}
        {modelCount > 0 && <span>3D AIRCRAFT {modelCount} · models CC BY 4.0, see /models/ATTRIBUTION.md</span>}
        <span>ALT {view.alt >= 10_000 ? `${(view.alt / 1000).toFixed(0)} KM` : `${Math.round(view.alt)} M`} · HDG {String(Math.round(view.heading) % 360).padStart(3, '0')}° · PITCH {Math.round(view.pitch)}°</span>
        <span className="theater-keys">drag: move map · right-drag: look around · wheel: zoom · ⇧drag: free look · arrows: look · ⇧arrows: move · + −: zoom</span>
        <span className="theater-keys">L layers · S scenes · H history · W watchlist · A annotate · K contacts · F follow · C cockpit · T trace · R rec frame · 1–7 look · Esc</span>
      </div>

      {status.phase === 'ready' && (
        <div className="theater-dock" role="region" aria-label="Command dock">
          <div className="theater-dock-cell">
            <div className="theater-dock-title">Locations</div>
            <form className="theater-dock-search" onSubmit={(e) => { e.preventDefault(); void searchPlace(); }}>
              <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Place, address or landmark…" aria-label="Fly to a place" autoComplete="off" />
              <button type="submit" className="theater-pill is-primary" disabled={searching || !searchQ.trim()}>{searching ? '…' : 'GO'}</button>
            </form>
            <div className="theater-dock-chips">
              {PRESET_PLACES.map((p) => <button key={p.name} type="button" className="theater-pill" onClick={() => flyCamera(p.lat, p.lng, p.alt, 20, -35)}>{p.name}</button>)}
            </div>
          </div>
          <div className="theater-dock-cell theater-dock-voice" id="scout-dock-slot" />
          <div className="theater-dock-cell">
            <div className="theater-dock-title">Visual presets<b>{styleLabel}</b>
              <span className="theater-skin" role="radiogroup" aria-label="Skin">
                <span>Skin</span>
                <button type="button" role="radio" aria-checked={skin === 'lookout'} className={`theater-pill ${skin === 'lookout' ? 'is-on' : ''}`} onClick={() => setSkin('lookout')} title="Lookout's own identity">LOOKOUT</button>
                <button type="button" role="radio" aria-checked={skin === 'gev'} className={`theater-pill ${skin === 'gev' ? 'is-on' : ''}`} onClick={() => setSkin('gev')} title="The shell of God's Eye View by Bilawal Sidhu (MIT) — credited in THIRD_PARTY_NOTICES.md">GOD’S EYE</button>
              </span>
            </div>
            <div className="theater-styles" role="radiogroup" aria-label="Sensor look">
              {SENSOR_STYLES.map((s) => (
                <button key={s.name} type="button" role="radio" aria-checked={style === s.name} className={`theater-style ${style === s.name ? 'is-on' : ''}`} onClick={() => applyStyle(s.name)} title={`${s.label} (key ${s.key})`}>
                  <span className="icon" aria-hidden>{STYLE_ICON[s.name] ?? '◯'}</span><span className="label">{s.label}</span><span className="key">{s.key}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {status.phase === 'loading' && (
        <div className="theater-veil" role="status"><div className="theater-spinner" aria-hidden />{status.note}</div>
      )}
      {status.phase === 'error' && (
        <div className="theater-veil is-error" role="alert">
          <strong>The 3D view could not start.</strong>
          <span>{status.note}</span>
          <button className="theater-btn" onClick={() => setAttempt((n) => n + 1)}>TRY AGAIN</button>
        </div>
      )}
      <div ref={credits} className="theater-credits" />
    </main>
  );
}

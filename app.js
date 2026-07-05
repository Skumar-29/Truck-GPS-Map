(() => {
  'use strict';

  const BUILD = 'aps-truck-gps-live-navigation-v2.0.0';
  const STORE_KEY = 'apsTruckGpsState.v2';
  const OLD_STORE_KEY = 'apsTruckGpsState.v1';
  const AU_CENTER = [-25.2744, 133.7751];
  const SAFETY_RADIUS_M = 320;
  const ROUTE_WIDTH_FOR_BRIDGE_M = 180;
  const GEOCODE_COUNTRY = 'au';
  const $ = (id) => document.getElementById(id);
  const nowIso = () => new Date().toISOString();

  const defaultState = {
    profile: {
      vehicleType: 'B-double', height: 4.3, margin: 0.2, width: 2.5, length: 26, weight: 68,
      avoidUnknown: true, blockLowBridge: true
    },
    settings: {
      autoStartGps: false, autoReroute: true, keepScreenAwake: true,
      offRouteDistance: 90, voiceMode: 'important'
    },
    gps: null,
    currentRoute: null,
    savedRoutes: [], places: [], customBridges: [], offlinePacks: [], lastUpdated: nowIso()
  };

  const state = loadState();
  let map, routeLayer, routeBorderLayer, walkedLayer, startMarker, destMarker, gpsMarker, accuracyCircle, bridgeLayer;
  let watchId = null;
  let navigationActive = false;
  let followMode = true;
  let voiceEnabled = true;
  let toastTimer = null;
  let safetyReport = null;
  let activeStepIndex = 0;
  let lastSpokenStep = -1;
  let lastOffRouteAt = 0;
  let wakeLock = null;
  let deferredInstallPrompt = null;

  const el = {
    routeStatus: $('routeStatus'), gpsPill: $('gpsPill'), navPill: $('navPill'), netPill: $('netPill'), dataPill: $('dataPill'),
    installBtn: $('installBtn'), navigationHud: $('navigationHud'), nextInstruction: $('nextInstruction'), nextDistance: $('nextDistance'),
    maneuverIcon: $('maneuverIcon'), etaText: $('etaText'), remainingText: $('remainingText'), arrivalText: $('arrivalText'),
    summaryTitle: $('summaryTitle'), summaryText: $('summaryText'), riskBadge: $('riskBadge'), safetyStrip: $('safetyStrip'), warningsList: $('warningsList'),
    startInput: $('startInput'), destInput: $('destInput'), distanceStat: $('distanceStat'), durationStat: $('durationStat'), routeTypeStat: $('routeTypeStat'), safetyStat: $('safetyStat'), directionsList: $('directionsList'),
    vehicleType: $('vehicleType'), truckHeight: $('truckHeight'), heightMargin: $('heightMargin'), truckWidth: $('truckWidth'), truckLength: $('truckLength'), truckWeight: $('truckWeight'), avoidUnknown: $('avoidUnknown'), blockLowBridge: $('blockLowBridge'),
    bridgeList: $('bridgeList'), offlinePacks: $('offlinePacks'), savedRoutesList: $('savedRoutesList'), placesList: $('placesList'), toast: $('toast'), buildInfo: $('buildInfo'),
    autoStartGps: $('autoStartGps'), autoReroute: $('autoReroute'), keepScreenAwake: $('keepScreenAwake'), offRouteDistance: $('offRouteDistance'), voiceMode: $('voiceMode')
  };

  boot();

  function boot() {
    hydrateForm();
    setupTabs();
    bindEvents();
    initMap();
    renderAll();
    updateNetworkPill();
    el.buildInfo.textContent = `Build: ${BUILD}`;
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    window.addEventListener('online', updateNetworkPill);
    window.addEventListener('offline', updateNetworkPill);
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; el.installBtn.hidden = false; });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && navigationActive) requestWakeLock(); });
    if (state.settings.autoStartGps) startGps(false);
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY) || localStorage.getItem(OLD_STORE_KEY);
      if (!raw) return clone(defaultState);
      return deepMerge(clone(defaultState), JSON.parse(raw));
    } catch (err) {
      console.warn('State restore failed', err);
      return clone(defaultState);
    }
  }

  function saveState(silent = true) {
    state.lastUpdated = nowIso();
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    if (!silent) showToast('Saved');
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function deepMerge(base, incoming) {
    for (const [k, v] of Object.entries(incoming || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) base[k] = deepMerge(base[k] || {}, v);
      else base[k] = v;
    }
    return base;
  }

  function setupTabs() {
    document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => switchScreen(btn.dataset.screen), { passive: true }));
  }

  function switchScreen(screen) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.screen === screen));
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${screen}`));
    if (screen === 'drive') setTimeout(() => map?.invalidateSize(), 80);
  }

  function bindEvents() {
    $('locateBtn').addEventListener('click', () => startGps(true));
    $('followBtn').addEventListener('click', () => { followMode = !followMode; $('followBtn').classList.toggle('active', followMode); showToast(followMode ? 'Follow mode on' : 'Follow mode off'); });
    $('layersBtn').addEventListener('click', cycleMapView);
    $('voiceBtn').addEventListener('click', () => { voiceEnabled = !voiceEnabled; $('voiceBtn').classList.toggle('active', voiceEnabled); showToast(voiceEnabled ? 'Voice on' : 'Voice off'); });
    $('startNavBtn').addEventListener('click', startNavigation);
    $('stopNavBtn').addEventListener('click', stopNavigation);
    $('useCurrentStartBtn').addEventListener('click', () => { el.startInput.value = 'Current GPS'; if (!state.gps) showToast('Tap GPS first or allow location permission'); });
    $('planRouteBtn').addEventListener('click', planRoute);
    $('clearRouteBtn').addEventListener('click', clearRoute);
    $('saveProfileBtn').addEventListener('click', () => saveProfileFromForm(false));
    $('saveSettingsBtn').addEventListener('click', saveSettingsFromForm);
    $('addBridgeBtn').addEventListener('click', addBridgeWarning);
    $('useGpsForBridgeBtn').addEventListener('click', fillBridgeFromGps);
    $('saveRouteBtn').addEventListener('click', saveCurrentRoute);
    $('savePlaceBtn').addEventListener('click', savePlace);
    $('exportBtn').addEventListener('click', exportBackup);
    $('importFile').addEventListener('change', importBackup);
    $('deleteOfflineBtn').addEventListener('click', () => { state.offlinePacks = []; saveState(false); renderOfflinePacks(); updateDataPill(); });
    $('openAppleMapsBtn').addEventListener('click', openAppleMaps);
    $('openGoogleMapsBtn').addEventListener('click', openGoogleMaps);
    el.installBtn.addEventListener('click', installApp);
    document.querySelectorAll('.packBtn').forEach((btn) => btn.addEventListener('click', () => downloadPack(btn.dataset.pack)));
    [el.truckHeight, el.heightMargin, el.avoidUnknown, el.blockLowBridge, el.vehicleType].forEach((input) => input.addEventListener('change', () => { saveProfileFromForm(true); recheckSafety(false); }));
  }

  function hydrateForm() {
    el.vehicleType.value = state.profile.vehicleType;
    el.truckHeight.value = state.profile.height;
    el.heightMargin.value = state.profile.margin;
    el.truckWidth.value = state.profile.width;
    el.truckLength.value = state.profile.length;
    el.truckWeight.value = state.profile.weight;
    el.avoidUnknown.checked = !!state.profile.avoidUnknown;
    el.blockLowBridge.checked = !!state.profile.blockLowBridge;
    el.autoStartGps.checked = !!state.settings.autoStartGps;
    el.autoReroute.checked = !!state.settings.autoReroute;
    el.keepScreenAwake.checked = !!state.settings.keepScreenAwake;
    el.offRouteDistance.value = String(state.settings.offRouteDistance || 90);
    el.voiceMode.value = state.settings.voiceMode || 'important';
  }

  function initMap() {
    if (!window.L) { showToast('Map library not loaded. Check internet first time.'); return; }
    map = L.map('map', { zoomControl: false, preferCanvas: true, inertia: true, renderer: L.canvas({ padding: 0.4 }) }).setView(AU_CENTER, 4);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors', updateWhenIdle: true, keepBuffer: 4
    }).addTo(map);
    bridgeLayer = L.layerGroup().addTo(map);
    drawCurrentRoute();
    drawBridgeMarkers();
  }

  function updateNetworkPill() {
    const online = navigator.onLine;
    el.netPill.textContent = online ? 'Online' : 'Offline';
    el.netPill.className = `pill ${online ? 'ok' : 'warn'}`;
    updateDataPill();
  }

  function updateDataPill() {
    const packCount = state.offlinePacks.length;
    const bridgeCount = getBridgeDatabase().length;
    if (bridgeCount) { el.dataPill.textContent = `${bridgeCount} custom bridge warning${bridgeCount === 1 ? '' : 's'}`; el.dataPill.className = 'pill warn'; }
    else if (packCount) { el.dataPill.textContent = `${packCount} offline record${packCount === 1 ? '' : 's'}`; el.dataPill.className = 'pill warn'; }
    else { el.dataPill.textContent = 'No certified truck data'; el.dataPill.className = 'pill bad'; }
  }

  function startGps(userRequested) {
    if (!navigator.geolocation) { showToast('GPS is not supported on this device'); return; }
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    el.gpsPill.textContent = 'GPS starting'; el.gpsPill.className = 'pill warn';
    watchId = navigator.geolocation.watchPosition(onGpsPosition, onGpsError, { enableHighAccuracy: true, maximumAge: 1200, timeout: 15000 });
    if (userRequested) showToast('Starting live GPS…');
  }

  function onGpsPosition(pos) {
    const c = {
      lat: roundCoord(pos.coords.latitude), lng: roundCoord(pos.coords.longitude), accuracy: Math.round(pos.coords.accuracy || 0),
      heading: Number.isFinite(pos.coords.heading) ? Math.round(pos.coords.heading) : null,
      speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : 0,
      time: nowIso()
    };
    state.gps = c; saveState(true);
    updateGpsMarker(c);
    el.gpsPill.textContent = `GPS ${c.accuracy || '?'}m`; el.gpsPill.className = c.accuracy > 80 ? 'pill warn' : 'pill ok';
    if (navigationActive) updateNavigationProgress();
    else if (followMode && map) map.setView([c.lat, c.lng], Math.max(map.getZoom(), 15), { animate: true });
  }

  function onGpsError(err) {
    el.gpsPill.textContent = 'GPS blocked'; el.gpsPill.className = 'pill bad';
    showToast(err.message || 'GPS permission needed');
  }

  function updateGpsMarker(c) {
    if (!map || !c) return;
    const latlng = [c.lat, c.lng];
    const iconHtml = c.heading !== null ? `<div class="gps-arrow" style="transform:rotate(${c.heading}deg)"></div>` : '<div class="gps-dot"></div>';
    const icon = L.divIcon({ className: '', html: iconHtml, iconSize: [28, 28], iconAnchor: [14, 14] });
    if (!gpsMarker) gpsMarker = L.marker(latlng, { icon, title: 'Current GPS' }).addTo(map).bindPopup('Current GPS');
    else { gpsMarker.setLatLng(latlng); gpsMarker.setIcon(icon); }
    if (!accuracyCircle) accuracyCircle = L.circle(latlng, { radius: c.accuracy || 20, color: '#38bdf8', weight: 1, fillColor: '#38bdf8', fillOpacity: 0.12 }).addTo(map);
    else accuracyCircle.setLatLng(latlng).setRadius(c.accuracy || 20);
  }

  async function planRoute() {
    const destText = el.destInput.value.trim();
    if (!destText) { showToast('Enter destination first'); return; }
    setRouteStatus('Planning navigation route…');
    try {
      const start = await resolveStart(el.startInput.value.trim());
      const destination = await geocode(destText);
      if (!start || !destination) throw new Error('Could not find start or destination');
      const route = await getOsrmRoute(start, destination);
      state.currentRoute = {
        id: makeId(), name: `${start.label} → ${destination.label}`, start, destination,
        geometry: route.geometry, steps: route.steps, distanceM: route.distanceM, durationS: route.durationS,
        mode: route.mode, createdAt: nowIso(), safetyCheckedAt: null
      };
      activeStepIndex = 0; lastSpokenStep = -1; saveState(true);
      drawCurrentRoute(); recheckSafety(false); renderRouteDetails(); setRouteStatus(state.currentRoute.name);
      showToast('Route ready'); switchScreen('drive');
    } catch (err) {
      console.warn(err); setRouteStatus('Route planning failed'); showToast(err.message || 'Route planning failed');
    }
  }

  async function resolveStart(text) {
    if (!text || /^current/i.test(text)) {
      if (!state.gps) throw new Error('GPS is not ready. Tap GPS first or type a start address.');
      return { label: 'Current GPS', lat: state.gps.lat, lng: state.gps.lng };
    }
    return geocode(text);
  }

  async function geocode(query) {
    const coord = parseCoords(query);
    if (coord) return { label: query, lat: coord.lat, lng: coord.lng };
    if (!navigator.onLine) throw new Error('Address search needs internet. Use saved route or coordinates offline.');
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=${GEOCODE_COUNTRY}&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('Address search failed');
    const data = await res.json();
    if (!data.length) throw new Error('Address not found');
    return { label: data[0].display_name.split(',').slice(0, 3).join(','), lat: Number(data[0].lat), lng: Number(data[0].lon) };
  }

  async function getOsrmRoute(start, dest) {
    if (!navigator.onLine) return getDirectRoute(start, dest);
    const coords = `${start.lng},${start.lat};${dest.lng},${dest.lat}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&alternatives=false`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Routing service failed');
      const data = await res.json();
      const r = data.routes?.[0];
      if (!r) throw new Error('No route returned');
      const geometry = r.geometry.coordinates.map(([lng, lat]) => [Number(lat), Number(lng)]);
      const steps = (r.legs || []).flatMap((leg) => (leg.steps || []).map(normaliseStep));
      return { geometry, steps, distanceM: r.distance, durationS: r.duration, mode: 'OSRM normal driving route' };
    } catch (err) {
      console.warn('OSRM failed, fallback direct route', err);
      return getDirectRoute(start, dest);
    }
  }

  function getDirectRoute(start, dest) {
    const distanceM = distanceBetween(start, dest);
    const durationS = distanceM / (80 * 1000 / 3600);
    return {
      geometry: [[start.lat, start.lng], [dest.lat, dest.lng]], distanceM, durationS, mode: 'Direct fallback line',
      steps: [{ instruction: 'Head toward destination. Full turn-by-turn requires online routing.', distanceM, durationS, maneuver: 'depart', location: [start.lat, start.lng] }]
    };
  }

  function normaliseStep(step) {
    const man = step.maneuver || {};
    return {
      instruction: stepInstruction(step), distanceM: step.distance || 0, durationS: step.duration || 0,
      maneuver: man.type || 'continue', modifier: man.modifier || '', location: man.location ? [man.location[1], man.location[0]] : null,
      name: step.name || '', geometry: step.geometry?.coordinates?.map(([lng, lat]) => [lat, lng]) || []
    };
  }

  function stepInstruction(step) {
    const man = step.maneuver || {}; const type = man.type || 'continue'; const mod = man.modifier || ''; const road = step.name ? ` onto ${step.name}` : '';
    if (type === 'depart') return `Start${road}`;
    if (type === 'arrive') return 'Arrive at destination';
    if (type === 'turn') return `Turn ${mod}${road}`.replace('  ', ' ');
    if (type === 'new name') return `Continue${road}`;
    if (type === 'roundabout') return `Enter roundabout and take the exit${road}`;
    if (type === 'merge') return `Merge ${mod}${road}`.replace('  ', ' ');
    if (type === 'fork') return `Keep ${mod}${road}`.replace('  ', ' ');
    if (type === 'end of road') return `At end of road, turn ${mod}${road}`.replace('  ', ' ');
    if (type === 'continue') return `Continue${road}`;
    return `${titleCase(type)} ${mod}${road}`.trim();
  }

  function drawCurrentRoute() {
    if (!map) return;
    [routeLayer, routeBorderLayer, walkedLayer, startMarker, destMarker].forEach((layer) => layer && map.removeLayer(layer));
    routeLayer = routeBorderLayer = walkedLayer = startMarker = destMarker = null;
    const r = state.currentRoute;
    if (!r?.geometry?.length) return;
    routeBorderLayer = L.polyline(r.geometry, { color: '#0f172a', weight: 8, opacity: 0.78 }).addTo(map);
    routeLayer = L.polyline(r.geometry, { color: '#22c55e', weight: 5, opacity: 0.95 }).addTo(map);
    startMarker = L.marker([r.start.lat, r.start.lng], { title: 'Start' }).addTo(map).bindPopup(`Start: ${escapeHtml(r.start.label)}`);
    destMarker = L.marker([r.destination.lat, r.destination.lng], { title: 'Destination' }).addTo(map).bindPopup(`Destination: ${escapeHtml(r.destination.label)}`);
    map.fitBounds(routeLayer.getBounds(), { padding: [28, 28] });
    drawBridgeMarkers(); renderRouteDetails();
  }

  function startNavigation() {
    if (!state.currentRoute) { showToast('Plan a route first'); switchScreen('plan'); return; }
    if (state.profile.blockLowBridge && safetyReport?.level === 'bad') { showToast('Blocked: low bridge/restriction detected'); speak('Route blocked. Low bridge or restriction detected.'); return; }
    if (!state.gps) startGps(false);
    navigationActive = true; followMode = true; $('followBtn').classList.add('active');
    $('startNavBtn').hidden = true; $('stopNavBtn').hidden = false; el.navigationHud.hidden = false;
    el.navPill.textContent = 'Navigating'; el.navPill.className = 'pill ok';
    activeStepIndex = 0; lastSpokenStep = -1; requestWakeLock(); updateNavigationProgress(); speak('Navigation started. Drive safely and obey truck route signs.');
  }

  function stopNavigation() {
    navigationActive = false; $('startNavBtn').hidden = false; $('stopNavBtn').hidden = true; el.navigationHud.hidden = true;
    el.navPill.textContent = 'Navigation off'; el.navPill.className = 'pill neutral'; releaseWakeLock(); showToast('Navigation stopped');
  }

  function updateNavigationProgress() {
    const r = state.currentRoute; const gps = state.gps;
    if (!r || !gps) return;
    const nearest = nearestPointOnRoute({ lat: gps.lat, lng: gps.lng }, r.geometry);
    const remainingM = Math.max(0, (r.distanceM || polylineLength(r.geometry)) - nearest.distanceAlongM);
    const progress = Math.min(1, Math.max(0, nearest.distanceAlongM / (r.distanceM || 1)));
    const approxRemainingS = (r.durationS || 0) * (1 - progress);
    const next = findActiveStep(gps, r.steps, nearest.distanceAlongM);
    activeStepIndex = next.index;
    const offRoute = nearest.distanceM > Number(state.settings.offRouteDistance || 90);

    el.nextInstruction.textContent = next.step?.instruction || 'Continue on route';
    el.nextDistance.textContent = offRoute ? `Off route by ${formatMeters(nearest.distanceM)}` : `${formatMeters(next.distanceToStepM)} to next instruction`;
    el.maneuverIcon.textContent = iconForStep(next.step);
    el.etaText.textContent = `ETA ${formatDuration(approxRemainingS)}`;
    el.remainingText.textContent = `${formatDistance(remainingM)} left`;
    el.arrivalText.textContent = `Arrive ${formatArrival(approxRemainingS)}`;
    el.summaryText.textContent = offRoute ? `Off-route warning: ${formatMeters(nearest.distanceM)} away from planned route.` : `${formatDistance(remainingM)} remaining · ${formatDuration(approxRemainingS)}`;

    drawWalkedRoute(r.geometry, nearest.index);
    renderDirectionsList();
    if (followMode && map) map.setView([gps.lat, gps.lng], Math.max(map.getZoom(), 16), { animate: true });

    if (offRoute) handleOffRoute(nearest.distanceM);
    else if (next.index !== lastSpokenStep && next.distanceToStepM < 650) {
      const shouldSpeak = state.settings.voiceMode === 'all' || next.distanceToStepM < 280 || next.step?.maneuver === 'turn' || next.step?.maneuver === 'roundabout';
      if (shouldSpeak) { speak(`${formatMeters(next.distanceToStepM)}. ${next.step?.instruction || 'Continue'}`); lastSpokenStep = next.index; }
    }

    if (remainingM < 90) { speak('You have arrived at destination.'); stopNavigation(); }
  }

  function drawWalkedRoute(geometry, index) {
    if (!map || !geometry?.length) return;
    if (walkedLayer) map.removeLayer(walkedLayer);
    const walked = geometry.slice(0, Math.min(index + 1, geometry.length));
    if (walked.length > 1) walkedLayer = L.polyline(walked, { color: '#64748b', weight: 5, opacity: 0.78 }).addTo(map);
  }

  async function handleOffRoute(distanceM) {
    const now = Date.now();
    el.navPill.textContent = 'Off route'; el.navPill.className = 'pill warn';
    if (now - lastOffRouteAt < 16000) return;
    lastOffRouteAt = now;
    speak(`Off route by ${formatMeters(distanceM)}.`);
    if (state.settings.autoReroute && navigator.onLine && state.gps && state.currentRoute) {
      try {
        setRouteStatus('Rerouting…');
        const start = { label: 'Current GPS', lat: state.gps.lat, lng: state.gps.lng };
        const destination = state.currentRoute.destination;
        const route = await getOsrmRoute(start, destination);
        state.currentRoute = { ...state.currentRoute, start, geometry: route.geometry, steps: route.steps, distanceM: route.distanceM, durationS: route.durationS, mode: route.mode, reroutedAt: nowIso() };
        activeStepIndex = 0; lastSpokenStep = -1; saveState(true); drawCurrentRoute(); recheckSafety(false); setRouteStatus('Rerouted from current GPS'); speak('Route recalculated.');
      } catch (err) { console.warn(err); showToast('Reroute failed'); }
    }
  }

  function findActiveStep(gps, steps, distanceAlongM) {
    if (!steps?.length) return { index: 0, step: null, distanceToStepM: 0 };
    let cumulative = 0;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepDistance = Math.max(0, step.distanceM || 0);
      if (cumulative + stepDistance + 30 >= distanceAlongM) {
        const distanceToStepM = Math.max(0, cumulative + stepDistance - distanceAlongM);
        return { index: i, step, distanceToStepM };
      }
      cumulative += stepDistance;
    }
    return { index: steps.length - 1, step: steps[steps.length - 1], distanceToStepM: 0 };
  }

  function recheckSafety(showSavedToast) {
    const r = state.currentRoute;
    if (!r?.geometry?.length) { safetyReport = null; renderSafetyReport(); return; }
    const required = Number(state.profile.height) + Number(state.profile.margin || 0);
    const warnings = [];
    for (const b of getBridgeDatabase()) {
      const nearest = nearestPointOnRoute({ lat: b.lat, lng: b.lng }, r.geometry);
      if (nearest.distanceM <= ROUTE_WIDTH_FOR_BRIDGE_M) {
        const clearance = Number(b.height);
        if (Number.isFinite(clearance) && clearance > 0 && clearance < required) {
          warnings.push({ level: 'red', title: `LOW BRIDGE: ${b.name || 'Restriction'}`, text: `${clearance.toFixed(2)} m clearance is below required ${required.toFixed(2)} m. Do not use this route.`, bridge: b });
        } else if (Number.isFinite(clearance) && clearance > 0 && clearance < required + 0.35) {
          warnings.push({ level: 'amber', title: `Close clearance: ${b.name || 'Bridge'}`, text: `${clearance.toFixed(2)} m clearance is close to required ${required.toFixed(2)} m. Recheck signs and official source.`, bridge: b });
        } else if (state.profile.avoidUnknown && (!Number.isFinite(clearance) || clearance <= 0)) {
          warnings.push({ level: 'amber', title: `Unknown clearance: ${b.name || 'Bridge'}`, text: 'Clearance is unknown. Treat as warning until confirmed.', bridge: b });
        }
      }
    }
    if (!warnings.length) warnings.push({ level: 'amber', title: 'No certified truck-route/bridge data loaded', text: 'The app did not find a saved low-bridge point on this route, but this does not prove the route is truck-safe.' });
    const hasRed = warnings.some((w) => w.level === 'red');
    const hasAmber = warnings.some((w) => w.level === 'amber');
    safetyReport = { level: hasRed ? 'bad' : hasAmber ? 'warn' : 'ok', warnings, checkedAt: nowIso() };
    state.currentRoute.safetyCheckedAt = safetyReport.checkedAt; saveState(true); renderSafetyReport();
    if (showSavedToast) showToast('Safety rechecked');
  }

  function renderSafetyReport() {
    const report = safetyReport;
    if (!state.currentRoute) {
      el.summaryTitle.textContent = 'No route planned'; el.summaryText.textContent = 'Search a destination, then start navigation.';
      el.riskBadge.textContent = '—'; el.riskBadge.className = 'risk-badge'; el.warningsList.innerHTML = ''; el.safetyStat.textContent = '—'; return;
    }
    if (!report) { el.riskBadge.textContent = '?'; el.riskBadge.className = 'risk-badge warn'; return; }
    const cls = report.level === 'bad' ? 'bad' : report.level === 'ok' ? 'ok' : 'warn';
    el.riskBadge.textContent = report.level === 'bad' ? 'STOP' : report.level === 'ok' ? 'OK' : 'WARN';
    el.riskBadge.className = `risk-badge ${cls}`;
    el.safetyStat.textContent = el.riskBadge.textContent;
    el.safetyStrip.className = `safety-strip ${report.level === 'bad' ? 'red' : report.level === 'ok' ? 'green' : 'amber'}`;
    el.safetyStrip.textContent = report.level === 'bad' ? 'Route blocked by low bridge/restriction in saved data. Do not navigate this route.' : report.level === 'ok' ? 'No saved low-bridge warning found on this route. Still confirm official truck route data.' : 'Warning: route is not certified truck-safe. Unknown/limited bridge data.';
    el.warningsList.innerHTML = report.warnings.map((w) => `<div class="warning-card ${w.level === 'red' ? 'red' : w.level === 'amber' ? 'amber' : 'green'}"><h3>${escapeHtml(w.title)}</h3><p>${escapeHtml(w.text)}</p>${w.bridge ? `<p><strong>Point:</strong> ${Number(w.bridge.lat).toFixed(5)}, ${Number(w.bridge.lng).toFixed(5)}</p>` : ''}</div>`).join('');
  }

  function renderRouteDetails() {
    const r = state.currentRoute;
    if (!r) {
      el.distanceStat.textContent = el.durationStat.textContent = el.routeTypeStat.textContent = el.safetyStat.textContent = '—';
      el.directionsList.textContent = 'No route yet.'; el.directionsList.className = 'directions-list empty'; return;
    }
    el.summaryTitle.textContent = r.name;
    el.summaryText.textContent = `${formatDistance(r.distanceM)} · ${formatDuration(r.durationS)} · ${r.mode}`;
    el.distanceStat.textContent = formatDistance(r.distanceM);
    el.durationStat.textContent = formatDuration(r.durationS);
    el.routeTypeStat.textContent = r.mode || 'Normal route';
    renderDirectionsList();
  }

  function renderDirectionsList() {
    const r = state.currentRoute;
    if (!r?.steps?.length) { el.directionsList.textContent = 'No route yet.'; el.directionsList.className = 'directions-list empty'; return; }
    el.directionsList.className = 'directions-list';
    el.directionsList.innerHTML = r.steps.map((s, i) => `<div class="step-card ${i === activeStepIndex ? 'active' : ''}"><div class="step-icon">${iconForStep(s)}</div><div><strong>${escapeHtml(s.instruction)}</strong><br><small>${formatDistance(s.distanceM)} · ${formatDuration(s.durationS)}</small></div><small>${i + 1}</small></div>`).join('');
  }

  function iconForStep(step) {
    const type = step?.maneuver || '';
    const mod = step?.modifier || '';
    if (type === 'arrive') return '🏁'; if (type === 'depart') return '▶'; if (type === 'roundabout') return '⟳';
    if (mod.includes('left')) return '↰'; if (mod.includes('right')) return '↱'; if (type === 'merge') return '⇢'; if (type === 'fork') return '⋔'; return '↑';
  }

  function clearRoute() {
    state.currentRoute = null; activeStepIndex = 0; safetyReport = null; saveState(false); stopNavigation(); drawCurrentRoute(); renderRouteDetails(); renderSafetyReport(); setRouteStatus('Route cleared');
  }

  function saveProfileFromForm(silent) {
    state.profile = {
      vehicleType: el.vehicleType.value, height: Number(el.truckHeight.value || 0), margin: Number(el.heightMargin.value || 0), width: Number(el.truckWidth.value || 0), length: Number(el.truckLength.value || 0), weight: Number(el.truckWeight.value || 0),
      avoidUnknown: el.avoidUnknown.checked, blockLowBridge: el.blockLowBridge.checked
    };
    saveState(silent); if (!silent) showToast('Truck profile saved');
  }

  function saveSettingsFromForm() {
    state.settings = { autoStartGps: el.autoStartGps.checked, autoReroute: el.autoReroute.checked, keepScreenAwake: el.keepScreenAwake.checked, offRouteDistance: Number(el.offRouteDistance.value || 90), voiceMode: el.voiceMode.value };
    if (state.settings.voiceMode === 'off') voiceEnabled = false;
    saveState(false); showToast('Navigation settings saved');
  }

  function fillBridgeFromGps() {
    if (!state.gps) { showToast('GPS not ready'); return; }
    $('bridgeLat').value = state.gps.lat; $('bridgeLng').value = state.gps.lng; showToast('Current GPS copied');
  }

  function addBridgeWarning() {
    const name = $('bridgeName').value.trim() || 'Low bridge / restriction';
    const height = Number($('bridgeHeight').value); const lat = Number($('bridgeLat').value); const lng = Number($('bridgeLng').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { showToast('Enter valid bridge latitude and longitude'); return; }
    state.customBridges.unshift({ id: makeId(), name, height: Number.isFinite(height) ? height : 0, lat, lng, note: $('bridgeNote').value.trim(), createdAt: nowIso() });
    ['bridgeName','bridgeHeight','bridgeLat','bridgeLng','bridgeNote'].forEach((id) => $(id).value = ''); saveState(false); drawBridgeMarkers(); renderBridgeList(); updateDataPill(); recheckSafety(false);
  }

  function drawBridgeMarkers() {
    if (!map || !bridgeLayer) return;
    bridgeLayer.clearLayers();
    getBridgeDatabase().forEach((b) => {
      const icon = L.divIcon({ className: '', html: '<div class="bridge-marker">!</div>', iconSize: [28, 28], iconAnchor: [14, 14] });
      L.marker([b.lat, b.lng], { icon }).addTo(bridgeLayer).bindPopup(`<strong>${escapeHtml(b.name)}</strong><br>Clearance: ${b.height ? `${b.height} m` : 'Unknown'}<br>${escapeHtml(b.note || '')}`);
    });
  }

  function getBridgeDatabase() { return state.customBridges.map((b) => ({ ...b, lat: Number(b.lat), lng: Number(b.lng), height: Number(b.height) })); }

  function renderBridgeList() {
    const list = state.customBridges;
    el.bridgeList.innerHTML = list.length ? list.map((b) => `<div class="list-card"><strong>${escapeHtml(b.name)}</strong><p>Clearance: ${b.height ? `${b.height} m` : 'Unknown'} · ${Number(b.lat).toFixed(5)}, ${Number(b.lng).toFixed(5)}</p><p>${escapeHtml(b.note || '')}</p><div class="list-actions"><button class="ghost danger" data-delete-bridge="${b.id}">Delete</button></div></div>`).join('') : '<p class="hint">No custom bridge warnings saved.</p>';
    el.bridgeList.querySelectorAll('[data-delete-bridge]').forEach((btn) => btn.addEventListener('click', () => { state.customBridges = state.customBridges.filter((b) => b.id !== btn.dataset.deleteBridge); saveState(false); renderBridgeList(); drawBridgeMarkers(); updateDataPill(); recheckSafety(false); }));
  }

  function saveCurrentRoute() {
    if (!state.currentRoute) { showToast('Plan a route first'); return; }
    const name = $('routeNameInput').value.trim() || state.currentRoute.name;
    state.savedRoutes.unshift({ ...clone(state.currentRoute), id: makeId(), name, savedAt: nowIso() });
    $('routeNameInput').value = ''; saveState(false); renderSavedRoutes();
  }

  function loadSavedRoute(id) {
    const r = state.savedRoutes.find((x) => x.id === id); if (!r) return;
    state.currentRoute = clone(r); activeStepIndex = 0; saveState(true); drawCurrentRoute(); recheckSafety(false); switchScreen('drive'); showToast('Route loaded');
  }

  function deleteSavedRoute(id) { state.savedRoutes = state.savedRoutes.filter((r) => r.id !== id); saveState(false); renderSavedRoutes(); }

  function renderSavedRoutes() {
    el.savedRoutesList.innerHTML = state.savedRoutes.length ? state.savedRoutes.map((r) => `<div class="list-card"><strong>${escapeHtml(r.name)}</strong><p>${formatDistance(r.distanceM)} · ${formatDuration(r.durationS)} · ${escapeHtml(r.mode || '')}</p><div class="list-actions"><button class="secondary" data-load-route="${r.id}">Load</button><button class="ghost danger" data-delete-route="${r.id}">Delete</button></div></div>`).join('') : '<p class="hint">No saved routes yet.</p>';
    el.savedRoutesList.querySelectorAll('[data-load-route]').forEach((b) => b.addEventListener('click', () => loadSavedRoute(b.dataset.loadRoute)));
    el.savedRoutesList.querySelectorAll('[data-delete-route]').forEach((b) => b.addEventListener('click', () => deleteSavedRoute(b.dataset.deleteRoute)));
  }

  async function savePlace() {
    const name = $('placeNameInput').value.trim(); const address = $('placeAddressInput').value.trim();
    if (!name || !address) { showToast('Enter place name and address'); return; }
    try { const loc = await geocode(address); state.places.unshift({ id: makeId(), name, address, ...loc, savedAt: nowIso() }); $('placeNameInput').value = $('placeAddressInput').value = ''; saveState(false); renderPlaces(); }
    catch (err) { showToast(err.message || 'Could not save place'); }
  }

  function renderPlaces() {
    el.placesList.innerHTML = state.places.length ? state.places.map((p) => `<div class="list-card"><strong>${escapeHtml(p.name)}</strong><p>${escapeHtml(p.label || p.address || '')}</p><div class="list-actions"><button class="secondary" data-dest-place="${p.id}">Use as destination</button><button class="ghost danger" data-delete-place="${p.id}">Delete</button></div></div>`).join('') : '<p class="hint">No saved places yet.</p>';
    el.placesList.querySelectorAll('[data-dest-place]').forEach((b) => b.addEventListener('click', () => { const p = state.places.find((x) => x.id === b.dataset.destPlace); if (p) { el.destInput.value = `${p.lat},${p.lng}`; switchScreen('plan'); } }));
    el.placesList.querySelectorAll('[data-delete-place]').forEach((b) => b.addEventListener('click', () => { state.places = state.places.filter((p) => p.id !== b.dataset.deletePlace); saveState(false); renderPlaces(); }));
  }

  function downloadPack(pack) {
    const existing = state.offlinePacks.find((p) => p.pack === pack);
    if (existing) existing.updatedAt = nowIso(); else state.offlinePacks.push({ id: makeId(), pack, updatedAt: nowIso(), note: 'Offline record saved. Full map tiles/routing graph require production map package.' });
    saveState(false); renderOfflinePacks(); updateDataPill();
  }

  function renderOfflinePacks() {
    el.offlinePacks.innerHTML = state.offlinePacks.length ? state.offlinePacks.map((p) => `<div class="list-card"><strong>${escapeHtml(p.pack)}</strong><p>Updated: ${new Date(p.updatedAt).toLocaleString()}</p><p>${escapeHtml(p.note || '')}</p></div>`).join('') : '<p class="hint">No offline records saved yet.</p>';
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify({ build: BUILD, exportedAt: nowIso(), state }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `aps-truck-gps-backup-${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(a.href);
  }

  function importBackup(e) {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { try { const parsed = JSON.parse(reader.result); deepMerge(state, parsed.state || parsed); saveState(false); hydrateForm(); renderAll(); drawCurrentRoute(); showToast('Backup imported'); } catch { showToast('Backup import failed'); } };
    reader.readAsText(file); e.target.value = '';
  }

  function openAppleMaps() {
    const r = state.currentRoute; if (!r) { showToast('Plan a route first'); return; }
    window.open(`https://maps.apple.com/?saddr=${r.start.lat},${r.start.lng}&daddr=${r.destination.lat},${r.destination.lng}&dirflg=d`, '_blank');
  }

  function openGoogleMaps() {
    const r = state.currentRoute; if (!r) { showToast('Plan a route first'); return; }
    window.open(`https://www.google.com/maps/dir/?api=1&origin=${r.start.lat},${r.start.lng}&destination=${r.destination.lat},${r.destination.lng}&travelmode=driving`, '_blank');
  }

  async function installApp() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice.catch(() => {}); deferredInstallPrompt = null; el.installBtn.hidden = true;
  }

  function renderAll() { renderRouteDetails(); renderSafetyReport(); renderBridgeList(); renderSavedRoutes(); renderPlaces(); renderOfflinePacks(); updateDataPill(); }

  function nearestPointOnRoute(point, geometry) {
    let best = { distanceM: Infinity, index: 0, distanceAlongM: 0 };
    let cumulative = 0;
    for (let i = 0; i < geometry.length - 1; i++) {
      const a = { lat: geometry[i][0], lng: geometry[i][1] }; const b = { lat: geometry[i + 1][0], lng: geometry[i + 1][1] };
      const approx = projectPointToSegment(point, a, b);
      const segLen = distanceBetween(a, b); const dist = distanceBetween(point, approx.point);
      if (dist < best.distanceM) best = { distanceM: dist, index: i + 1, distanceAlongM: cumulative + segLen * approx.t };
      cumulative += segLen;
    }
    return best;
  }

  function projectPointToSegment(p, a, b) {
    const latScale = 111320; const lngScale = 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    const ax = a.lng * lngScale, ay = a.lat * latScale, bx = b.lng * lngScale, by = b.lat * latScale, px = p.lng * lngScale, py = p.lat * latScale;
    const dx = bx - ax, dy = by - ay; const len2 = dx*dx + dy*dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return { t, point: { lat: (ay + t * dy) / latScale, lng: (ax + t * dx) / lngScale } };
  }

  function polylineLength(geometry) { let total = 0; for (let i=0;i<geometry.length-1;i++) total += distanceBetween({lat: geometry[i][0], lng: geometry[i][1]}, {lat: geometry[i+1][0], lng: geometry[i+1][1]}); return total; }
  function distanceBetween(a, b) { const R = 6371000, toRad = (d) => d * Math.PI / 180; const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng); const s1 = Math.sin(dLat/2), s2 = Math.sin(dLng/2); const q = s1*s1 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*s2*s2; return 2*R*Math.atan2(Math.sqrt(q), Math.sqrt(1-q)); }
  function parseCoords(text) { const m = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/); return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null; }
  function roundCoord(v) { return Math.round(v * 1e6) / 1e6; }
  function makeId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`; }
  function formatDistance(m) { if (!Number.isFinite(m)) return '—'; return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m > 10000 ? 0 : 1)} km`; }
  function formatMeters(m) { return m < 1000 ? `${Math.round(m)} metres` : `${(m/1000).toFixed(1)} kilometres`; }
  function formatDuration(s) { if (!Number.isFinite(s)) return '—'; const min = Math.max(0, Math.round(s / 60)); if (min < 60) return `${min} min`; const h = Math.floor(min / 60), mm = min % 60; return `${h}h ${mm}m`; }
  function formatArrival(s) { const d = new Date(Date.now() + Math.max(0, s || 0) * 1000); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function titleCase(s) { return String(s || '').replace(/\b\w/g, (c) => c.toUpperCase()); }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
  function setRouteStatus(t) { el.routeStatus.textContent = t; }
  function showToast(message) { clearTimeout(toastTimer); el.toast.textContent = message; el.toast.classList.add('show'); toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2300); }
  function speak(text) { if (!voiceEnabled || state.settings.voiceMode === 'off' || !('speechSynthesis' in window)) return; window.speechSynthesis.cancel(); const utter = new SpeechSynthesisUtterance(text); utter.lang = 'en-AU'; utter.rate = 0.96; window.speechSynthesis.speak(utter); }

  async function requestWakeLock() { try { if (!state.settings.keepScreenAwake || !('wakeLock' in navigator) || wakeLock) return; wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch {} }
  function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }
  function cycleMapView() { showToast('Map view button ready for satellite/traffic layers in next build'); }
})();

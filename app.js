(() => {
  'use strict';

  const BUILD = 'aps-truck-gps-smooth-safety-v1.0.0';
  const STORE_KEY = 'apsTruckGpsState.v1';
  const AU_CENTER = [-25.2744, 133.7751];
  const ROUTE_MATCH_RADIUS_M = 90;
  const DIRECT_MATCH_RADIUS_M = 260;

  const $ = (id) => document.getElementById(id);
  const nowIso = () => new Date().toISOString();

  const defaultState = {
    profile: {
      vehicleType: 'B-double',
      height: 4.3,
      margin: 0.2,
      width: 2.5,
      length: 26,
      weight: 68,
      avoidUnknown: true
    },
    settings: {
      routingMode: 'safe',
      warningLevel: 'strict',
      autoRecheck: true
    },
    gps: null,
    currentRoute: null,
    savedRoutes: [],
    places: [],
    customBridges: [],
    offlinePacks: [],
    lastUpdated: nowIso()
  };

  const state = loadState();
  let map = null;
  let routeLayer = null;
  let startMarker = null;
  let destMarker = null;
  let gpsMarker = null;
  let bridgeLayer = null;
  let watchId = null;
  let toastTimer = null;
  let safetyReport = null;

  const el = {
    routeStatus: $('routeStatus'),
    gpsPill: $('gpsPill'),
    netPill: $('netPill'),
    dataPill: $('dataPill'),
    offlineMap: $('offlineMap'),
    summaryTitle: $('summaryTitle'),
    summaryText: $('summaryText'),
    riskBadge: $('riskBadge'),
    warningsList: $('warningsList'),
    startInput: $('startInput'),
    destInput: $('destInput'),
    vehicleType: $('vehicleType'),
    truckHeight: $('truckHeight'),
    heightMargin: $('heightMargin'),
    truckWidth: $('truckWidth'),
    truckLength: $('truckLength'),
    truckWeight: $('truckWeight'),
    avoidUnknown: $('avoidUnknown'),
    bridgeList: $('bridgeList'),
    offlinePacks: $('offlinePacks'),
    savedRoutesList: $('savedRoutesList'),
    placesList: $('placesList'),
    toast: $('toast'),
    buildInfo: $('buildInfo'),
    routingMode: $('routingMode'),
    warningLevel: $('warningLevel'),
    autoRecheck: $('autoRecheck')
  };

  boot();

  function boot() {
    hydrateForm();
    setupNavigation();
    bindEvents();
    initMap();
    renderAll();
    updateNetworkPill();
    el.buildInfo.textContent = `Build: ${BUILD}`;

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    window.addEventListener('online', updateNetworkPill);
    window.addEventListener('offline', updateNetworkPill);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.settings.autoRecheck) recheckSafety(false);
    });
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
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

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function deepMerge(base, incoming) {
    for (const [key, value] of Object.entries(incoming || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        base[key] = deepMerge(base[key] || {}, value);
      } else {
        base[key] = value;
      }
    }
    return base;
  }

  function setupNavigation() {
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const screen = btn.dataset.screen;
        document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${screen}`));
        if (screen === 'drive') setTimeout(() => map?.invalidateSize(), 80);
      }, { passive: true });
    });
  }

  function bindEvents() {
    $('locateBtn').addEventListener('click', startGps);
    $('recheckBtn').addEventListener('click', () => recheckSafety(true));
    $('useCurrentStartBtn').addEventListener('click', () => {
      el.startInput.value = state.gps ? 'Current GPS' : '';
      if (!state.gps) showToast('GPS not ready yet');
    });
    $('planRouteBtn').addEventListener('click', planRoute);
    $('clearRouteBtn').addEventListener('click', clearRoute);
    $('saveProfileBtn').addEventListener('click', saveProfileFromForm);
    $('saveSettingsBtn').addEventListener('click', saveSettingsFromForm);
    $('addBridgeBtn').addEventListener('click', addBridgeWarning);
    $('saveRouteBtn').addEventListener('click', saveCurrentRoute);
    $('savePlaceBtn').addEventListener('click', savePlace);
    $('exportBtn').addEventListener('click', exportBackup);
    $('importFile').addEventListener('change', importBackup);
    $('deleteOfflineBtn').addEventListener('click', () => {
      state.offlinePacks = [];
      saveState(false);
      renderOfflinePacks();
      updateDataPill();
    });
    document.querySelectorAll('.packBtn').forEach((btn) => {
      btn.addEventListener('click', () => downloadPack(btn.dataset.pack));
    });

    const routeInputs = [el.truckHeight, el.heightMargin, el.avoidUnknown, el.vehicleType];
    routeInputs.forEach((input) => input.addEventListener('change', () => {
      saveProfileFromForm(true);
      if (state.settings.autoRecheck) recheckSafety(false);
    }));
  }

  function hydrateForm() {
    el.vehicleType.value = state.profile.vehicleType;
    el.truckHeight.value = state.profile.height;
    el.heightMargin.value = state.profile.margin;
    el.truckWidth.value = state.profile.width;
    el.truckLength.value = state.profile.length;
    el.truckWeight.value = state.profile.weight;
    el.avoidUnknown.checked = !!state.profile.avoidUnknown;
    el.routingMode.value = state.settings.routingMode;
    el.warningLevel.value = state.settings.warningLevel;
    el.autoRecheck.checked = !!state.settings.autoRecheck;
  }

  function initMap() {
    if (!window.L) {
      el.offlineMap.hidden = false;
      return;
    }
    map = L.map('map', {
      zoomControl: false,
      preferCanvas: true,
      inertia: true,
      renderer: L.canvas({ padding: 0.25 })
    }).setView(AU_CENTER, 4);

    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
      updateWhenIdle: true,
      keepBuffer: 3
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
    if (packCount > 0 || bridgeCount > 0) {
      el.dataPill.textContent = `${packCount} pack${packCount === 1 ? '' : 's'} · ${bridgeCount} warnings`;
      el.dataPill.className = 'pill warn';
    } else {
      el.dataPill.textContent = 'No certified truck data';
      el.dataPill.className = 'pill bad';
    }
  }

  function startGps() {
    if (!navigator.geolocation) {
      showToast('GPS is not supported on this device');
      return;
    }
    el.gpsPill.textContent = 'GPS starting';
    el.gpsPill.className = 'pill warn';
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition((pos) => {
      const coords = {
        lat: roundCoord(pos.coords.latitude),
        lng: roundCoord(pos.coords.longitude),
        accuracy: Math.round(pos.coords.accuracy || 0),
        time: nowIso()
      };
      state.gps = coords;
      saveState(true);
      updateGpsMarker();
      el.gpsPill.textContent = `GPS ${coords.accuracy || '?'}m`;
      el.gpsPill.className = 'pill ok';
      if (!state.currentRoute) map?.setView([coords.lat, coords.lng], 14);
    }, (err) => {
      el.gpsPill.textContent = 'GPS blocked';
      el.gpsPill.className = 'pill bad';
      showToast(err.message || 'GPS permission needed');
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }

  function updateGpsMarker() {
    if (!map || !state.gps) return;
    const latlng = [state.gps.lat, state.gps.lng];
    if (!gpsMarker) {
      gpsMarker = L.marker(latlng, { title: 'Current GPS' }).addTo(map).bindPopup('Current GPS position');
    } else {
      gpsMarker.setLatLng(latlng);
    }
  }

  async function planRoute() {
    const startText = el.startInput.value.trim();
    const destText = el.destInput.value.trim();
    if (!destText) {
      showToast('Enter destination first');
      return;
    }
    setRouteStatus('Planning route…');
    try {
      const start = await resolveStart(startText);
      const destination = await geocode(destText);
      if (!start || !destination) throw new Error('Could not find start or destination');
      const route = await getRoute(start, destination);
      state.currentRoute = {
        id: makeId(),
        name: `${start.label} → ${destination.label}`,
        start,
        destination,
        geometry: route.geometry,
        distanceM: route.distanceM,
        durationS: route.durationS,
        mode: route.mode,
        createdAt: nowIso(),
        safetyCheckedAt: null,
        notes: []
      };
      saveState(true);
      drawCurrentRoute();
      recheckSafety(false);
      setRouteStatus(state.currentRoute.name);
      showToast('Route planned');
      switchScreen('drive');
    } catch (err) {
      console.warn(err);
      setRouteStatus('Route planning failed');
      showToast(err.message || 'Route planning failed');
    }
  }

  async function resolveStart(text) {
    if (!text || /^current/i.test(text)) {
      if (!state.gps) startGps();
      if (state.gps) return { label: 'Current GPS', lat: state.gps.lat, lng: state.gps.lng };
      throw new Error('GPS not ready. Type a start address or allow location.');
    }
    return geocode(text);
  }

  async function geocode(query) {
    const coordinate = parseCoordinates(query);
    if (coordinate) return { ...coordinate, label: coordinate.label || query };

    const saved = state.places.find((p) => p.name.toLowerCase() === query.toLowerCase());
    if (saved) return { label: saved.name, lat: saved.lat, lng: saved.lng };

    if (!navigator.onLine) throw new Error('Address search needs internet. Use saved place or coordinates offline.');

    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('Address search failed');
    const data = await res.json();
    if (!Array.isArray(data) || !data[0]) throw new Error('Address not found');
    return {
      label: data[0].display_name.split(',').slice(0, 3).join(','),
      lat: Number(data[0].lat),
      lng: Number(data[0].lon)
    };
  }

  async function getRoute(start, dest) {
    if (!navigator.onLine) return directRoute(start, dest, 'offline-direct');
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${start.lng},${start.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson&steps=false`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('Route server unavailable');
      const data = await res.json();
      const first = data.routes && data.routes[0];
      if (!first) throw new Error('No route returned');
      return {
        geometry: first.geometry.coordinates.map(([lng, lat]) => [roundCoord(lat), roundCoord(lng)]),
        distanceM: Math.round(first.distance),
        durationS: Math.round(first.duration),
        mode: 'normal-online'
      };
    } catch (err) {
      console.warn('OSRM fallback route used', err);
      return directRoute(start, dest, 'direct-fallback');
    }
  }

  function directRoute(start, dest, mode) {
    const distanceM = haversineMeters(start.lat, start.lng, dest.lat, dest.lng);
    return {
      geometry: [[start.lat, start.lng], [dest.lat, dest.lng]],
      distanceM: Math.round(distanceM),
      durationS: Math.round(distanceM / 19.4),
      mode
    };
  }

  function drawCurrentRoute() {
    if (!map) return;
    if (routeLayer) routeLayer.remove();
    if (startMarker) startMarker.remove();
    if (destMarker) destMarker.remove();
    const route = state.currentRoute;
    if (!route) return;
    routeLayer = L.polyline(route.geometry, { weight: 6, opacity: 0.88 }).addTo(map);
    startMarker = L.marker([route.start.lat, route.start.lng], { title: 'Start' }).addTo(map).bindPopup(`Start: ${escapeHtml(route.start.label)}`);
    destMarker = L.marker([route.destination.lat, route.destination.lng], { title: 'Destination' }).addTo(map).bindPopup(`Destination: ${escapeHtml(route.destination.label)}`);
    map.fitBounds(routeLayer.getBounds(), { padding: [24, 24] });
    drawBridgeMarkers();
  }

  function clearRoute() {
    state.currentRoute = null;
    safetyReport = null;
    saveState(false);
    drawCurrentRoute();
    renderSummary();
    setRouteStatus('Route cleared');
  }

  function setRouteStatus(text) {
    el.routeStatus.textContent = text;
  }

  function recheckSafety(showDoneToast = true) {
    const route = state.currentRoute;
    if (!route) {
      renderSummary();
      if (showDoneToast) showToast('No route to check');
      return;
    }
    safetyReport = checkRouteSafety(route);
    route.safetyCheckedAt = nowIso();
    saveState(true);
    renderSummary();
    drawBridgeMarkers();
    if (showDoneToast) showToast('Safety checked');
  }

  function checkRouteSafety(route) {
    const requiredHeight = Number(state.profile.height) + Number(state.profile.margin);
    const matchRadius = route.mode.includes('direct') ? DIRECT_MATCH_RADIUS_M : ROUTE_MATCH_RADIUS_M;
    const warnings = [];
    const bridges = getBridgeDatabase();

    for (const bridge of bridges) {
      const distance = distancePointToRouteMeters(bridge.lat, bridge.lng, route.geometry);
      if (distance <= matchRadius) {
        const clearance = Number(bridge.height);
        let level = 'green';
        let title = 'Bridge clearance checked';
        if (!Number.isFinite(clearance) || clearance <= 0) {
          level = state.profile.avoidUnknown || state.settings.warningLevel === 'strict' ? 'amber' : 'green';
          title = 'Unknown bridge height near route';
        } else if (clearance < requiredHeight) {
          level = 'red';
          title = 'LOW BRIDGE — DO NOT USE';
        } else if (clearance < requiredHeight + 0.15) {
          level = 'amber';
          title = 'Tight bridge clearance';
        }
        warnings.push({
          level,
          title,
          name: bridge.name,
          height: bridge.height,
          requiredHeight: round1(requiredHeight),
          distanceM: Math.round(distance),
          note: bridge.note || '',
          source: bridge.source || 'User saved'
        });
      }
    }

    if (route.mode !== 'normal-online') {
      warnings.push({
        level: 'amber',
        title: 'Fallback route used',
        name: 'Route data warning',
        note: 'This route line is not precise turn-by-turn routing. Check road signs and official truck maps.',
        source: route.mode
      });
    }

    warnings.push({
      level: 'amber',
      title: 'Not certified truck-safe routing',
      name: 'Safety reminder',
      note: 'This build checks saved height warnings only. It does not yet contain complete certified Australian truck bridge data.',
      source: 'App safety rule'
    });

    const red = warnings.some((w) => w.level === 'red');
    const amber = warnings.some((w) => w.level === 'amber');
    return {
      level: red ? 'red' : (amber ? 'amber' : 'green'),
      warnings,
      requiredHeight: round1(requiredHeight),
      checkedAt: nowIso()
    };
  }

  function renderSummary() {
    const route = state.currentRoute;
    el.warningsList.innerHTML = '';
    el.riskBadge.className = 'risk-badge';
    if (!route) {
      el.summaryTitle.textContent = 'No route planned';
      el.summaryText.textContent = 'Enter a destination or tap a saved route.';
      el.riskBadge.textContent = '—';
      return;
    }
    if (!safetyReport) safetyReport = checkRouteSafety(route);
    const km = (route.distanceM / 1000).toFixed(route.distanceM > 100000 ? 0 : 1);
    const mins = Math.round(route.durationS / 60);
    const eta = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    el.summaryTitle.textContent = route.name;
    el.summaryText.textContent = `${km} km · approx ${eta} · required clearance ${safetyReport.requiredHeight} m`;
    if (safetyReport.level === 'red') {
      el.riskBadge.textContent = 'STOP';
      el.riskBadge.classList.add('bad');
    } else if (safetyReport.level === 'amber') {
      el.riskBadge.textContent = 'WARN';
      el.riskBadge.classList.add('warn');
    } else {
      el.riskBadge.textContent = 'OK';
      el.riskBadge.classList.add('ok');
    }
    for (const warning of safetyReport.warnings) {
      const card = document.createElement('div');
      card.className = `warning-card ${warning.level === 'red' ? 'red' : warning.level === 'amber' ? 'amber' : 'green'}`;
      const clearance = warning.height ? `<p>Clearance: <strong>${escapeHtml(String(warning.height))} m</strong> · Required: <strong>${safetyReport.requiredHeight} m</strong></p>` : '';
      const distance = warning.distanceM !== undefined ? `<p>Approx distance from route line: ${warning.distanceM} m</p>` : '';
      card.innerHTML = `<h3>${escapeHtml(warning.title)}</h3><p><strong>${escapeHtml(warning.name || '')}</strong></p>${clearance}${distance}<p>${escapeHtml(warning.note || '')}</p><p class="hint">Source: ${escapeHtml(warning.source || 'Unknown')}</p>`;
      el.warningsList.appendChild(card);
    }
  }

  function drawBridgeMarkers() {
    if (!map || !bridgeLayer) return;
    bridgeLayer.clearLayers();
    const bridges = getBridgeDatabase();
    for (const bridge of bridges) {
      const color = classifyBridge(bridge).level;
      const marker = L.circleMarker([bridge.lat, bridge.lng], {
        radius: 8,
        weight: 2,
        color: color === 'red' ? '#ef4444' : color === 'amber' ? '#f59e0b' : '#22c55e',
        fillOpacity: 0.45
      }).bindPopup(`<strong>${escapeHtml(bridge.name)}</strong><br>Clearance: ${bridge.height || 'Unknown'} m<br>${escapeHtml(bridge.note || '')}`);
      marker.addTo(bridgeLayer);
    }
  }

  function classifyBridge(bridge) {
    const required = Number(state.profile.height) + Number(state.profile.margin);
    const clearance = Number(bridge.height);
    if (!Number.isFinite(clearance) || clearance <= 0) return { level: 'amber' };
    if (clearance < required) return { level: 'red' };
    if (clearance < required + 0.15) return { level: 'amber' };
    return { level: 'green' };
  }

  function saveProfileFromForm(silent = false) {
    state.profile.vehicleType = el.vehicleType.value;
    state.profile.height = readPositive(el.truckHeight.value, 4.3);
    state.profile.margin = readPositive(el.heightMargin.value, 0.2);
    state.profile.width = readPositive(el.truckWidth.value, 2.5);
    state.profile.length = readPositive(el.truckLength.value, 26);
    state.profile.weight = readPositive(el.truckWeight.value, 68);
    state.profile.avoidUnknown = el.avoidUnknown.checked;
    hydrateForm();
    saveState(!silent);
    if (!silent) showToast('Truck profile saved');
    drawBridgeMarkers();
  }

  function saveSettingsFromForm() {
    state.settings.routingMode = el.routingMode.value;
    state.settings.warningLevel = el.warningLevel.value;
    state.settings.autoRecheck = el.autoRecheck.checked;
    saveState(false);
    if (state.settings.autoRecheck) recheckSafety(false);
  }

  function addBridgeWarning() {
    const name = $('bridgeName').value.trim() || 'Custom low bridge / restriction';
    const height = readPositive($('bridgeHeight').value, 0);
    const lat = Number($('bridgeLat').value);
    const lng = Number($('bridgeLng').value);
    const note = $('bridgeNote').value.trim();
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      showToast('Enter bridge latitude and longitude');
      return;
    }
    state.customBridges.push({ id: makeId(), name, height, lat, lng, note, source: 'User saved', createdAt: nowIso() });
    $('bridgeName').value = '';
    $('bridgeHeight').value = '';
    $('bridgeLat').value = '';
    $('bridgeLng').value = '';
    $('bridgeNote').value = '';
    saveState(false);
    renderBridgeList();
    drawBridgeMarkers();
    if (state.settings.autoRecheck) recheckSafety(false);
  }

  function getBridgeDatabase() {
    return state.customBridges.map((b) => ({ ...b, lat: Number(b.lat), lng: Number(b.lng), height: Number(b.height) }));
  }

  function saveCurrentRoute() {
    const route = state.currentRoute;
    if (!route) {
      showToast('Plan a route first');
      return;
    }
    const name = $('routeNameInput').value.trim() || route.name;
    const saved = { ...route, id: makeId(), name, savedAt: nowIso() };
    state.savedRoutes.unshift(saved);
    $('routeNameInput').value = '';
    saveState(false);
    renderSavedRoutes();
  }

  function loadSavedRoute(id) {
    const route = state.savedRoutes.find((r) => r.id === id);
    if (!route) return;
    state.currentRoute = clone(route);
    saveState(true);
    drawCurrentRoute();
    recheckSafety(false);
    switchScreen('drive');
    showToast('Route loaded');
  }

  function deleteSavedRoute(id) {
    state.savedRoutes = state.savedRoutes.filter((r) => r.id !== id);
    saveState(false);
    renderSavedRoutes();
  }

  async function savePlace() {
    const name = $('placeNameInput').value.trim();
    const address = $('placeAddressInput').value.trim();
    if (!name || !address) {
      showToast('Enter place name and address');
      return;
    }
    try {
      const point = await geocode(address);
      state.places.unshift({ id: makeId(), name, address, lat: point.lat, lng: point.lng, createdAt: nowIso() });
      $('placeNameInput').value = '';
      $('placeAddressInput').value = '';
      saveState(false);
      renderPlaces();
    } catch (err) {
      showToast(err.message || 'Could not save place');
    }
  }

  function usePlace(id, target) {
    const place = state.places.find((p) => p.id === id);
    if (!place) return;
    if (target === 'start') el.startInput.value = place.name;
    else el.destInput.value = place.name;
    switchScreen('plan');
  }

  function deletePlace(id) {
    state.places = state.places.filter((p) => p.id !== id);
    saveState(false);
    renderPlaces();
  }

  function downloadPack(pack) {
    const existing = state.offlinePacks.find((p) => p.pack === pack);
    const label = pack === 'ALL' ? 'All Australia' : pack === 'current' ? 'Current route' : pack;
    const currentRouteData = pack === 'current' && state.currentRoute ? {
      routeId: state.currentRoute.id,
      routeName: state.currentRoute.name,
      geometryPoints: state.currentRoute.geometry.length
    } : null;
    const payload = {
      id: existing?.id || makeId(),
      pack,
      label,
      downloadedAt: nowIso(),
      dataType: 'lightweight route/safety pack',
      bridgeWarnings: getBridgeDatabase().length,
      route: currentRouteData,
      status: 'Starter pack saved locally. Production truck map tiles/routing graph not included yet.'
    };
    if (existing) Object.assign(existing, payload);
    else state.offlinePacks.unshift(payload);
    saveState(false);
    renderOfflinePacks();
    updateDataPill();
  }

  function renderAll() {
    renderSummary();
    renderBridgeList();
    renderSavedRoutes();
    renderPlaces();
    renderOfflinePacks();
    updateDataPill();
  }

  function renderBridgeList() {
    el.bridgeList.innerHTML = '';
    if (!state.customBridges.length) {
      el.bridgeList.innerHTML = '<p class="hint">No custom bridge warnings yet. Add known low bridges or import official data later.</p>';
      return;
    }
    state.customBridges.forEach((b) => {
      const card = document.createElement('div');
      card.className = 'list-card';
      card.innerHTML = `<strong>${escapeHtml(b.name)}</strong><p>Clearance: ${b.height || 'Unknown'} m · ${Number(b.lat).toFixed(5)}, ${Number(b.lng).toFixed(5)}</p><p>${escapeHtml(b.note || '')}</p><div class="list-actions"><button class="ghost danger" data-del-bridge="${b.id}">Delete</button></div>`;
      el.bridgeList.appendChild(card);
    });
    el.bridgeList.querySelectorAll('[data-del-bridge]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.customBridges = state.customBridges.filter((b) => b.id !== btn.dataset.delBridge);
        saveState(false);
        renderBridgeList();
        drawBridgeMarkers();
        recheckSafety(false);
      });
    });
  }

  function renderSavedRoutes() {
    el.savedRoutesList.innerHTML = '';
    if (!state.savedRoutes.length) {
      el.savedRoutesList.innerHTML = '<p class="hint">No saved routes yet.</p>';
      return;
    }
    state.savedRoutes.forEach((route) => {
      const km = (route.distanceM / 1000).toFixed(route.distanceM > 100000 ? 0 : 1);
      const card = document.createElement('div');
      card.className = 'list-card';
      card.innerHTML = `<strong>${escapeHtml(route.name)}</strong><p>${km} km · ${escapeHtml(route.mode || 'route')}</p><div class="list-actions"><button class="secondary" data-load-route="${route.id}">Load</button><button class="ghost danger" data-del-route="${route.id}">Delete</button></div>`;
      el.savedRoutesList.appendChild(card);
    });
    el.savedRoutesList.querySelectorAll('[data-load-route]').forEach((btn) => btn.addEventListener('click', () => loadSavedRoute(btn.dataset.loadRoute)));
    el.savedRoutesList.querySelectorAll('[data-del-route]').forEach((btn) => btn.addEventListener('click', () => deleteSavedRoute(btn.dataset.delRoute)));
  }

  function renderPlaces() {
    el.placesList.innerHTML = '';
    if (!state.places.length) {
      el.placesList.innerHTML = '<p class="hint">No saved depots or places yet.</p>';
      return;
    }
    state.places.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'list-card';
      card.innerHTML = `<strong>${escapeHtml(p.name)}</strong><p>${escapeHtml(p.address)} · ${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}</p><div class="list-actions"><button class="secondary" data-start-place="${p.id}">Use start</button><button class="secondary" data-dest-place="${p.id}">Use destination</button><button class="ghost danger" data-del-place="${p.id}">Delete</button></div>`;
      el.placesList.appendChild(card);
    });
    el.placesList.querySelectorAll('[data-start-place]').forEach((btn) => btn.addEventListener('click', () => usePlace(btn.dataset.startPlace, 'start')));
    el.placesList.querySelectorAll('[data-dest-place]').forEach((btn) => btn.addEventListener('click', () => usePlace(btn.dataset.destPlace, 'dest')));
    el.placesList.querySelectorAll('[data-del-place]').forEach((btn) => btn.addEventListener('click', () => deletePlace(btn.dataset.delPlace)));
  }

  function renderOfflinePacks() {
    el.offlinePacks.innerHTML = '';
    if (!state.offlinePacks.length) {
      el.offlinePacks.innerHTML = '<p class="hint">No offline packs saved yet.</p>';
      return;
    }
    state.offlinePacks.forEach((p) => {
      const date = new Date(p.downloadedAt).toLocaleString('en-AU');
      const card = document.createElement('div');
      card.className = 'list-card';
      card.innerHTML = `<strong>${escapeHtml(p.label)}</strong><p>${escapeHtml(p.dataType)} · downloaded ${escapeHtml(date)}</p><p>${escapeHtml(p.status || '')}</p>`;
      el.offlinePacks.appendChild(card);
    });
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify({ build: BUILD, exportedAt: nowIso(), state }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `aps-truck-gps-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Backup exported');
  }

  function importBackup(evt) {
    const file = evt.target.files && evt.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const imported = data.state || data;
        const merged = deepMerge(clone(defaultState), imported);
        Object.assign(state, merged);
        saveState(false);
        hydrateForm();
        renderAll();
        drawCurrentRoute();
        drawBridgeMarkers();
        showToast('Backup imported');
      } catch (err) {
        showToast('Import failed');
      }
      evt.target.value = '';
    };
    reader.readAsText(file);
  }

  function switchScreen(screen) {
    const btn = document.querySelector(`.tab[data-screen="${screen}"]`);
    if (btn) btn.click();
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.classList.add('show');
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1900);
  }

  function parseCoordinates(text) {
    const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  }

  function distancePointToRouteMeters(lat, lng, route) {
    if (!route || route.length < 2) return Infinity;
    let min = Infinity;
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1];
      const b = route[i];
      const d = distancePointToSegmentApprox(lat, lng, a[0], a[1], b[0], b[1]);
      if (d < min) min = d;
    }
    return min;
  }

  function distancePointToSegmentApprox(lat, lng, lat1, lng1, lat2, lng2) {
    const meanLat = deg2rad((lat + lat1 + lat2) / 3);
    const scaleX = 111320 * Math.cos(meanLat);
    const scaleY = 110540;
    const px = lng * scaleX;
    const py = lat * scaleY;
    const ax = lng1 * scaleX;
    const ay = lat1 * scaleY;
    const bx = lng2 * scaleX;
    const by = lat2 * scaleY;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = deg2rad(lat2 - lat1);
    const dLng = deg2rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function deg2rad(v) { return v * Math.PI / 180; }
  function roundCoord(v) { return Math.round(Number(v) * 1e6) / 1e6; }
  function round1(v) { return Math.round(Number(v) * 10) / 10; }
  function readPositive(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }
  function makeId() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[c]));
  }
})();

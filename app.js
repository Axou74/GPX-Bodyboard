/* Bodyboard GPX/CSV Viewer – Détection de vagues
 * ------------------------------------------------
 * Fonctionne en ouvrant index.html directement.
 * Dépendances : Leaflet (CDN).
 *
 * Principales étapes :
 * 1) Parsing fichier (GPX/CSV) -> points [ {lat, lon, ele, time} ... ]
 * 2) Calculs segmentaires (distance, dt, vitesse) + stats globales
 * 3) Rendu Leaflet : fond satellite + polylines colorées selon la vitesse
 * 4) Détection de vagues : segments consécutifs au-dessus d’un seuil
 * 5) Export GPX : trace complète + vagues en pistes séparées
 */

// --------- Sélecteurs UI ----------
const fileInput = document.getElementById('fileInput');
const detectBtn = document.getElementById('detectBtn');
const exportBtn = document.getElementById('exportBtn');
const fitBtn = document.getElementById('fitBtn');
const clearBtn = document.getElementById('clearBtn');

const thresholdRange = document.getElementById('thresholdRange');
const thresholdNumber = document.getElementById('thresholdNumber');
const minDurationInput = document.getElementById('minDuration');
const directionToggle = document.getElementById('directionToggle');
const directionAngleInput = document.getElementById('directionAngle');
const directionToleranceInput = document.getElementById('directionTolerance');

const statDistance = document.getElementById('stat-distance');
const statDuration = document.getElementById('stat-duration');
const statAvg = document.getElementById('stat-avg');
const statMax = document.getElementById('stat-max');
const statWaves = document.getElementById('stat-waves');
const statBest = document.getElementById('stat-best');
const autoThresholdLabel = document.getElementById('autoThresholdLabel');
const legendGradient = document.getElementById('legendGradient');
const legendMin = document.getElementById('legendMin');
const legendMax = document.getElementById('legendMax');
const wavesTableBody = document.getElementById('wavesTableBody');
const wavesEmpty = document.getElementById('wavesEmpty');
const mapStatus = document.getElementById('mapStatus');

const DEFAULT_THRESHOLD_MIN = 5;
const DEFAULT_THRESHOLD_MAX = 50;
const DEFAULT_THRESHOLD_NUMBER_MAX = 100;
const DEFAULT_DIRECTION_TOLERANCE = 45;
const DEFAULT_EMPTY_MESSAGE = 'Aucune vague détectée pour le moment.';

// ---------- Carte Leaflet ----------
let map = null;
let baseLayer = null;
let trackLayerGroup = null;
let wavesLayerGroup = null;
let directionLayerGroup = null;
let mapReady = false;

function showMapStatus(){
  if (mapStatus){
    mapStatus.hidden = false;
  }
}

function hideMapStatus(){
  if (mapStatus){
    mapStatus.hidden = true;
  }
}

initMap();
resetStatsUI();
resetWaveUI();
setEnabled(false);
initializeDirectionUI();

function initMap(){
  if (typeof L === 'undefined'){
    console.error('Leaflet introuvable : la carte sera désactivée.');
    showMapStatus();
    mapReady = false;
    return;
  }

  try {
    hideMapStatus();
    map = L.map('map', {
      preferCanvas: true, // meilleur rendu pour beaucoup de segments
      zoomControl: true
    });

    // Fond satellite ESRI (gratuit, pas de clé). Voir TOS ESRI pour usage.
    baseLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Tiles © Esri — Source: Esri, Earthstar Geographics' }
    ).addTo(map);

    trackLayerGroup = L.layerGroup().addTo(map);
    directionLayerGroup = L.layerGroup().addTo(map);
    wavesLayerGroup = L.layerGroup().addTo(map);

    mapReady = true;

    // vue par défaut (monde)
    map.setView([20, 0], 2);
  } catch (err) {
    console.error('Impossible d\'initialiser la carte Leaflet.', err);
    map = null;
    baseLayer = null;
    trackLayerGroup = null;
    directionLayerGroup = null;
    wavesLayerGroup = null;
    mapReady = false;
    showMapStatus();
  }
}

// ------------- État ---------------
let points = [];        // [{lat, lon, ele, time}]
let segments = [];      // [{a:[lat,lon], b:[lat,lon], speedKmh, distM, dtS, bearingDeg}]
let stats = null;       // {distM, durationS, avgKmh, maxKmh}
let waves = [];         // [{startIdx, endIdx, distM, durationS, maxKmh}]
let autoThreshold = null;

// ------------- Helpers ------------
const toRad = deg => deg * Math.PI / 180;
function haversineDistanceM(a, b){
  const R = 6371000; // m
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fmtDistance(m){
  if (!isFinite(m)) return '–';
  return m >= 1000 ? (m/1000).toFixed(2) + ' km' : m.toFixed(0) + ' m';
}
function fmtDuration(s){
  if (!isFinite(s)) return '–';
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const sec = Math.floor(s%60);
  return (h>0? `${h}h ` : '') + `${m}m ${sec}s`;
}
function clamp(v,min,max){return Math.max(min, Math.min(max, v));}

function normalizeBearing(deg){
  if (!Number.isFinite(deg)) return NaN;
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function angularDifference(a, b){
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  const diff = Math.abs(normalizeBearing(a) - normalizeBearing(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function toLatLon(value){
  if (!value) return null;
  if (Array.isArray(value)){
    const [lat, lon] = value;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }
  const lat = value.lat ?? value.latitude ?? null;
  const lon = value.lon ?? value.lng ?? value.longitude ?? null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function formatBearing(deg){
  if (!Number.isFinite(deg)) return '–';
  const rounded = Math.round(deg * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function destinationPoint(origin, bearingDeg, distanceM){
  const point = toLatLon(origin);
  if (!point || !Number.isFinite(distanceM) || distanceM <= 0) return null;
  const bearing = normalizeBearing(bearingDeg);
  if (!Number.isFinite(bearing)) return null;
  const R = 6371000;
  const angDist = distanceM / R;
  const lat1 = toRad(point.lat);
  const lon1 = toRad(point.lon);
  const brng = toRad(bearing);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) +
    Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1),
    Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
  );

  return {
    lat: lat2 * 180 / Math.PI,
    lon: ((lon2 * 180 / Math.PI + 540) % 360) - 180
  };
}

function bearingDegrees(a, b){
  const start = toLatLon(a);
  const end = toLatLon(b);
  if (!start || !end) return NaN;
  const lat1 = toRad(start.lat);
  const lat2 = toRad(end.lat);
  const dLon = toRad(end.lon - start.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = Math.atan2(y, x);
  return normalizeBearing(brng * 180 / Math.PI);
}

function drawArrow(layer, origin, bearingDeg, options={}){
  if (!mapReady || !layer) return;
  const start = toLatLon(origin);
  if (!start) return;
  const settings = {
    length: 200,
    headLength: undefined,
    color: '#f97316',
    weight: 3,
    opacity: 0.9,
    fillOpacity: 0.85,
    dashArray: '4 6'
  };
  Object.assign(settings, options || {});
  const length = Number.isFinite(settings.length) && settings.length > 0 ? settings.length : 200;
  const headLength = Number.isFinite(settings.headLength) && settings.headLength > 0
    ? settings.headLength
    : length * 0.25;

  const tip = destinationPoint(start, bearingDeg, length);
  if (!tip) return;
  const lineCoords = [
    [start.lat, start.lon],
    [tip.lat, tip.lon]
  ];
  const lineOptions = {
    color: settings.color,
    weight: settings.weight,
    opacity: settings.opacity,
    lineCap: 'round'
  };
  if (settings.dashArray){
    lineOptions.dashArray = settings.dashArray;
  }
  L.polyline(lineCoords, lineOptions).addTo(layer);

  const left = destinationPoint(tip, bearingDeg + 150, headLength);
  const right = destinationPoint(tip, bearingDeg - 150, headLength);
  if (left && right){
    L.polygon([
      [tip.lat, tip.lon],
      [left.lat, left.lon],
      [right.lat, right.lon]
    ], {
      color: settings.color,
      weight: settings.weight,
      opacity: settings.opacity,
      fillColor: settings.color,
      fillOpacity: settings.fillOpacity,
      lineJoin: 'round'
    }).addTo(layer);
  }
}


// Couleurs de vagues : dégradé perceptuellement plus lisible (bleu -> vert -> jaune -> rouge)
const SPEED_COLOR_STOPS = [
  {r: 59, g: 130, b: 246},  // bleu soutenu
  {r: 16, g: 185, b: 129},  // vert turquoise
  {r: 132, g: 204, b: 22},  // vert lime
  {r: 250, g: 204, b: 21},  // jaune
  {r: 249, g: 115, b: 22},  // orange
  {r: 220, g: 38,  b: 38}   // rouge
];

function lerp(a, b, t){
  return a + (b - a) * t;
}


function speedToColor(speedKmh, minKmh, maxKmh){
  if (!Number.isFinite(minKmh) || !Number.isFinite(maxKmh)){
    minKmh = Number.isFinite(speedKmh) ? speedKmh : 0;
    maxKmh = minKmh + 1;
  }
  if (!Number.isFinite(speedKmh)) speedKmh = minKmh;
  const range = Math.max(1e-3, (maxKmh - minKmh));
  const t = clamp((speedKmh - minKmh) / range, 0, 1);

  const scaled = t * (SPEED_COLOR_STOPS.length - 1);
  const idx = Math.floor(scaled);
  const frac = scaled - idx;
  const start = SPEED_COLOR_STOPS[idx];
  const end = SPEED_COLOR_STOPS[Math.min(idx + 1, SPEED_COLOR_STOPS.length - 1)];
  const r = Math.round(lerp(start.r, end.r, frac));
  const g = Math.round(lerp(start.g, end.g, frac));
  const b = Math.round(lerp(start.b, end.b, frac));
  return `rgb(${r} ${g} ${b})`;

}

// ------------- Parsing -------------
fileInput.addEventListener('change', async (e)=>{
  const file = e.target.files?.[0];
  if (!file) return;

  try{
    const text = await file.text();
    const name = file.name.toLowerCase();
    if (name.endsWith('.gpx')) {
      points = parseGPX(text);
    } else if (name.endsWith('.csv')) {
      points = parseCSV(text);
    } else {
      throw new Error('Format non supporté (utilise .gpx ou .csv).');
    }
    if (points.length < 2) throw new Error('Pas assez de points dans la trace.');

    // Calculs, rendu et UI
    computeSegmentsAndStats();
    renderTrack();
    configureThresholdControls();
    setEnabled(true);
    runWaveDetection();

  }catch(err){
    alert('Erreur au chargement: ' + err.message);
    console.error(err);
  }finally{
    // Permet de recharger le même fichier sans devoir sélectionner un autre fichier avant
    fileInput.value = '';
  }
});

function parseGPX(xmlText){
  // Support des balises : <trk><trkseg><trkpt lat lon> [<ele>] [<time>]
  const dom = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parserErr = dom.querySelector('parsererror');
  if (parserErr) throw new Error('GPX invalide.');

  const trkpts = dom.getElementsByTagName('trkpt');
  const pts = [];
  for (let i=0;i<trkpts.length;i++){
    const n = trkpts[i];
    const lat = parseFloat(n.getAttribute('lat'));
    const lon = parseFloat(n.getAttribute('lon'));
    const eleNode = n.getElementsByTagName('ele')[0];
    const timeNode = n.getElementsByTagName('time')[0];
    const ele = eleNode ? parseFloat(eleNode.textContent) : null;
    const time = timeNode ? new Date(timeNode.textContent.trim()) : null;
    if (Number.isFinite(lat) && Number.isFinite(lon)){
      pts.push({lat, lon, ele, time});
    }
  }
  return pts;
}

function parseCSV(text){
  // CSV attendu : header avec time,lat,lon[,ele]
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV trop court.');
  const header = lines[0].split(',').map(s => s.trim().toLowerCase());
  const iTime = header.indexOf('time');
  const iLat = header.indexOf('lat');
  const iLon = header.indexOf('lon');
  const iEle = header.indexOf('ele');

  if (iTime < 0 || iLat < 0 || iLon < 0) {
    throw new Error('CSV attendu avec colonnes: time,lat,lon[,ele]');
  }

  const pts = [];
  for (let i=1;i<lines.length;i++){
    if (!lines[i].trim()) continue;
    const c = lines[i].split(',').map(s=>s.trim());
    const lat = parseFloat(c[iLat]);
    const lon = parseFloat(c[iLon]);
    const ele = (iEle>=0 && c[iEle]!==undefined) ? parseFloat(c[iEle]) : null;
    const time = new Date(c[iTime].replace(' ', 'T')); // tolère "YYYY-MM-DD HH:mm:ss"
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      pts.push({lat, lon, ele, time});
    }
  }
  return pts;
}

// ---- Calculs & Stats --------------
function computeSegmentsAndStats(){
  segments = [];
  let distM = 0;
  let durationS = 0;
  let maxKmh = 0;

  for (let i=1;i<points.length;i++){
    const a = points[i-1], b = points[i];
    const d = haversineDistanceM(a, b);
    const tA = a.time?.getTime?.() ?? NaN;
    const tB = b.time?.getTime?.() ?? NaN;
    const dt = Number.isFinite(tA) && Number.isFinite(tB) ? (tB - tA)/1000 : NaN;
    const speedMS = (Number.isFinite(dt) && dt>0) ? d/dt : 0;
    const speedKmh = speedMS * 3.6;
    const bearingDeg = Number.isFinite(d) ? bearingDegrees({lat:a.lat, lon:a.lon}, {lat:b.lat, lon:b.lon}) : NaN;

    segments.push({ a:[a.lat,a.lon], b:[b.lat,b.lon], distM: d, dtS: dt, speedKmh, bearingDeg });

    if (Number.isFinite(d)) distM += d;
    if (Number.isFinite(dt) && dt>0) durationS += dt;
    if (speedKmh > maxKmh) maxKmh = speedKmh;
  }

  const avgKmh = (distM/1000) / (durationS/3600 || 1e-9);
  stats = { distM, durationS, avgKmh, maxKmh };
}

// ---- Rendu Leaflet -----------------
let trackBounds = null;

function renderTrack(){
  if (!mapReady || !trackLayerGroup || !wavesLayerGroup){
    trackBounds = null;
    return;
  }

  trackLayerGroup.clearLayers();
  wavesLayerGroup.clearLayers();
  if (directionLayerGroup) directionLayerGroup.clearLayers();

  if (segments.length === 0 || points.length === 0) {
    trackBounds = null;
    updateLegend(NaN, NaN);
    resetWaveUI();
    return;
  }

  const latlngs = points.map(p=>[p.lat,p.lon]);

  // trace de base en gris
  L.polyline(latlngs, {
    color: 'rgba(255,255,255,0.25)',
    weight: 7,
    opacity: 0.3,
    lineCap: 'round'
  }).addTo(trackLayerGroup);

  L.polyline(latlngs, {
    color: '#4b5563',
    weight: 4,
    opacity: 0.55,
    lineCap: 'round'
  }).addTo(trackLayerGroup);

  trackBounds = L.latLngBounds(latlngs);
  if (mapReady && map) {
    map.fitBounds(trackBounds, { padding: [30,30] });
  }
  updateDirectionVisual();
}

// ---- UI Stats ----------------------
function updateStatsUI(){
  if (!stats){ resetStatsUI(); return; }
  statDistance.textContent = fmtDistance(stats.distM);
  statDuration.textContent = fmtDuration(stats.durationS);
  statAvg.textContent = `${stats.avgKmh.toFixed(2)} km/h`;
  statMax.textContent = `${stats.maxKmh.toFixed(2)} km/h`;
  statWaves.textContent = segments.length ? String(waves.length) : '–';
  statBest.textContent = segments.length && waves.length ? bestWaveLabel(waves) : '–';
}

function resetStatsUI(){
  statDistance.textContent = statDuration.textContent = statAvg.textContent =
  statMax.textContent = statWaves.textContent = statBest.textContent = '–';
}

function bestWaveLabel(ws){
  // « Meilleure vague » = celle avec le pic de vitesse max (fallback : distance)
  let best = ws[0];
  for (const w of ws){
    if (w.maxKmh > best.maxKmh) best = w;
    else if (w.maxKmh === best.maxKmh && w.distM > best.distM) best = w;
  }
  return `${fmtDistance(best.distM)} • ${fmtDuration(best.durationS)} • ${best.maxKmh.toFixed(1)} km/h`;
}

function computeAutoThreshold(segs){
  const speeds = segs.map(s=>s.speedKmh).filter(v=>Number.isFinite(v) && v > 1);
  if (!speeds.length) return 15;
  speeds.sort((a,b)=>a-b);
  const idx = Math.floor(0.75 * (speeds.length - 1));
  const candidate = speeds[idx];
  return clamp(candidate, 5, 120);
}

function configureThresholdControls(){
  if (!segments.length){
    autoThreshold = null;
    thresholdRange.min = thresholdNumber.min = String(DEFAULT_THRESHOLD_MIN);
    thresholdRange.max = String(DEFAULT_THRESHOLD_MAX);
    thresholdNumber.max = String(DEFAULT_THRESHOLD_NUMBER_MAX);
    setThreshold(15);
    updateAutoThresholdLabel();
    return;
  }

  const speeds = segments.map(s=>s.speedKmh).filter(v=>Number.isFinite(v));
  if (!speeds.length){
    autoThreshold = null;
    thresholdRange.min = thresholdNumber.min = String(DEFAULT_THRESHOLD_MIN);
    thresholdRange.max = String(DEFAULT_THRESHOLD_MAX);
    thresholdNumber.max = String(DEFAULT_THRESHOLD_NUMBER_MAX);
    setThreshold(15);
    autoThresholdLabel.textContent = 'Aucune donnée de vitesse exploitable.';
    return;
  }

  speeds.sort((a,b)=>a-b);
  const minVal = Math.max(0, Math.floor(Math.min(speeds[0], 5)));
  const maxSpeed = speeds[speeds.length-1];
  const maxVal = Math.max(minVal + 5, Math.ceil(Math.max(maxSpeed, 10)));

  thresholdRange.min = thresholdNumber.min = String(minVal);
  thresholdRange.max = String(Math.max(maxVal, DEFAULT_THRESHOLD_MAX));
  thresholdNumber.max = String(Math.max(maxVal, DEFAULT_THRESHOLD_NUMBER_MAX));

  autoThreshold = computeAutoThreshold(segments);
  const applied = setThreshold(autoThreshold);
  updateAutoThresholdLabel(applied);
}

function setThreshold(value){
  const min = Number(thresholdRange.min) || 0;
  const max = Number(thresholdRange.max) || 100;
  const clampedValue = clamp(value, min, max);
  const stepped = Math.round(clampedValue * 2) / 2;
  const display = Number.isInteger(stepped) ? String(stepped) : stepped.toFixed(1);
  thresholdRange.value = display;
  thresholdNumber.value = display;
  return stepped;
}

function updateAutoThresholdLabel(current){
  if (!Number.isFinite(autoThreshold)){
    autoThresholdLabel.textContent = '';
    return;
  }
  const actual = Number.isFinite(current) ? current : parseFloat(thresholdNumber.value);
  if (Number.isFinite(actual)){
    const same = Math.abs(actual - autoThreshold) < 0.25;
    autoThresholdLabel.textContent = same
      ? `Seuil automatique suggéré : ${autoThreshold.toFixed(1)} km/h`
      : `Seuil automatique suggéré : ${autoThreshold.toFixed(1)} km/h (actuel : ${actual.toFixed(1)} km/h)`;
  } else {
    autoThresholdLabel.textContent = `Seuil automatique suggéré : ${autoThreshold.toFixed(1)} km/h`;
  }
}

function updateLegend(min, max){
  if (!Number.isFinite(min) || !Number.isFinite(max)){
    legendGradient.style.background = 'linear-gradient(to right, rgb(59 130 246), rgb(16 185 129), rgb(132 204 22), rgb(250 204 21), rgb(249 115 22), rgb(220 38 38))';
    legendMin.textContent = '';
    legendMax.textContent = '';
    return;
  }
  if (Math.abs(max - min) < 1e-3){
    const color = speedToColor(min, min, min + 1);
    legendGradient.style.background = `linear-gradient(to right, ${color}, ${color})`;
    legendMin.textContent = `${min.toFixed(1)} km/h`;
    legendMax.textContent = `${max.toFixed(1)} km/h`;
    return;
  }
  const stops = [0, 0.25, 0.5, 0.75, 1];
  const colors = stops.map(t => {
    const speed = min + (max - min) * t;
    return speedToColor(speed, min, max);
  });
  legendGradient.style.background = `linear-gradient(to right, ${colors.join(', ')})`;
  legendMin.textContent = `${min.toFixed(1)} km/h`;
  legendMax.textContent = `${max.toFixed(1)} km/h`;
}

function updateWaveTable(ws, options={}){
  const directionSettings = options.directionSettings || null;
  const filterApplied = Boolean(directionSettings?.enabled);
  const rejected = Math.max(0, options.rejectedCount || 0);
  const rawCount = options.rawCount ?? ws.length;

  wavesTableBody.innerHTML = '';

  if (!ws.length){
    wavesEmpty.style.display = 'block';
    wavesEmpty.textContent = filterApplied && rawCount > 0
      ? `Aucune vague ne respecte le sens choisi${rejected ? ` (${rejected} ignorée${rejected>1?'s':''})` : ''}.`
      : DEFAULT_EMPTY_MESSAGE;
    return;
  }

  const showDelta = filterApplied && Number.isFinite(directionSettings?.direction);
  if (filterApplied && rejected > 0){
    wavesEmpty.style.display = 'block';
    wavesEmpty.textContent = `${rejected} vague${rejected>1?'s':''} ignorée${rejected>1?'s':''} car hors tolérance.`;
  } else {
    wavesEmpty.style.display = 'none';
  }

  ws.forEach((w, idx)=>{
    const tr = document.createElement('tr');
    const avg = w.durationS > 0 ? (w.distM / w.durationS * 3.6) : NaN;
    const avgStr = Number.isFinite(avg) ? `${avg.toFixed(1)} km/h` : '–';
    const directionStr = Number.isFinite(w.directionDeg) ? `${formatBearing(w.directionDeg)}°` : '–';
    const delta = showDelta && Number.isFinite(w.directionDeg)
      ? angularDifference(w.directionDeg, directionSettings.direction)
      : NaN;
    const deltaStr = Number.isFinite(delta) ? `${formatBearing(delta)}°` : '–';
    tr.innerHTML = `
      <td>${idx+1}</td>
      <td>${fmtDistance(w.distM)}</td>
      <td>${fmtDuration(w.durationS)}</td>
      <td>${w.maxKmh.toFixed(1)} km/h</td>
      <td>${avgStr}</td>
      <td>${directionStr}</td>
      <td>${deltaStr}</td>`;
    tr.tabIndex = 0;
    if (w.bounds){
      tr.addEventListener('click', ()=>{
        map.fitBounds(w.bounds, { padding:[50,50] });
      });
      tr.addEventListener('keypress', (evt)=>{
        if (evt.key === 'Enter' || evt.key === ' '){
          evt.preventDefault();
          map.fitBounds(w.bounds, { padding:[50,50] });
        }
      });
    }
    wavesTableBody.appendChild(tr);
  });
}

function resetWaveUI(){
  wavesTableBody.innerHTML = '';
  wavesEmpty.style.display = 'block';
  wavesEmpty.textContent = DEFAULT_EMPTY_MESSAGE;
  updateLegend(NaN, NaN);
}

function enrichWave(w){
  const start = Math.max(0, w.startIdx);
  const end = Math.min(segments.length-1, w.endIdx);
  const indices = [];
  for (let i=start;i<=end;i++) indices.push(i);
  const slice = points.slice(start, end+2);
  const latlngs = slice.map(p=>[p.lat, p.lon]);
  const canUseLeaflet = mapReady && typeof L !== 'undefined';
  const bounds = canUseLeaflet && latlngs.length ? L.latLngBounds(latlngs) : null;
  const startPoint = canUseLeaflet && latlngs.length ? latlngs[0] : null;
  const midPoint = canUseLeaflet && latlngs.length ? latlngs[Math.floor(latlngs.length/2)] : null;
  let directionDeg = NaN;
  const bearingSamples = indices
    .map(idx => segments[idx]?.bearingDeg)
    .filter(val => Number.isFinite(val));
  if (bearingSamples.length){
    const sin = bearingSamples.reduce((acc,deg)=>acc + Math.sin(toRad(deg)), 0);
    const cos = bearingSamples.reduce((acc,deg)=>acc + Math.cos(toRad(deg)), 0);
    if (Math.abs(sin) > 1e-6 || Math.abs(cos) > 1e-6){
      directionDeg = normalizeBearing(Math.atan2(sin, cos) * 180 / Math.PI);
    }
  } else if (slice.length >= 2){
    const first = slice[0];
    const last = slice[slice.length - 1];
    directionDeg = bearingDegrees({lat:first.lat, lon:first.lon}, {lat:last.lat, lon:last.lon});
  }
  return { ...w, startIdx:start, endIdx:end, indices, bounds, startPoint, midPoint, directionDeg };
}

// ---- Détection des vagues ----------
detectBtn.addEventListener('click', ()=>{
  runWaveDetection(true);
});

function runWaveDetection(){
  if (!segments.length){
    waves = [];
    if (wavesLayerGroup) wavesLayerGroup.clearLayers();
    if (directionLayerGroup) directionLayerGroup.clearLayers();
    resetWaveUI();
    updateStatsUI();
    return;
  }
  const thresholdInput = parseFloat(thresholdNumber.value);
  const threshold = Number.isFinite(thresholdInput) ? thresholdInput : (autoThreshold ?? 15);
  const minDur = Math.max(0, Number(minDurationInput.value) || 0);
  const directionSettings = getDirectionSettings();
  const detected = detectWaves(segments, threshold, minDur);
  const enriched = detected.map(enrichWave);
  let filtered = enriched;
  let rejectedCount = 0;
  if (directionSettings.enabled){
    filtered = enriched.filter(w => {
      if (!Number.isFinite(w.directionDeg)) return false;
      const delta = angularDifference(w.directionDeg, directionSettings.direction);
      return Number.isFinite(delta) && delta <= directionSettings.tolerance;
    });
    rejectedCount = enriched.length - filtered.length;
  }
  waves = filtered;
  renderWaves(waves);
  updateWaveTable(waves, {
    directionSettings,
    rejectedCount,
    rawCount: enriched.length
  });
  updateStatsUI();
  updateAutoThresholdLabel(threshold);
  updateDirectionVisual(directionSettings);
}

function detectWaves(segs, thresholdKmh=15, minDurationS=2){
  const found = [];
  let cur = null;

  for (let i=0;i<segs.length;i++){
    const s = segs[i];
    const over = s.speedKmh >= thresholdKmh && Number.isFinite(s.dtS) && s.dtS>0;

    if (over){
      if (!cur){
        cur = { startIdx: Math.max(0, i-1), endIdx: i, distM: 0, durationS: 0, maxKmh: 0 };
      }
      cur.endIdx = i;
      cur.distM += (Number.isFinite(s.distM) ? s.distM : 0);
      cur.durationS += (Number.isFinite(s.dtS) ? s.dtS : 0);
      if (s.speedKmh > cur.maxKmh) cur.maxKmh = s.speedKmh;
    } else {
      if (cur){
        if (cur.durationS >= minDurationS) found.push(cur);
        cur = null;
      }
    }
  }
  if (cur && cur.durationS >= minDurationS) found.push(cur);

  // Fusionne des vagues séparées par un court relâchement sous le seuil
  const merged = [];
  for (let i=0;i<found.length;i++){
    if (!merged.length) { merged.push(found[i]); continue; }
    const prev = merged[merged.length-1];
    const gapIdx = prev.endIdx + 1;
    if (gapIdx < segs.length){
      const gap = segs[gapIdx];
      const shortGap = Number.isFinite(gap.dtS) ? gap.dtS <= 1.0 : false;
      if (shortGap){
        prev.endIdx = found[i].endIdx;
        prev.distM += (gap.distM || 0) + found[i].distM;
        prev.durationS += (gap.dtS || 0) + found[i].durationS;
        prev.maxKmh = Math.max(prev.maxKmh, found[i].maxKmh);
        continue;
      }
    }
    merged.push(found[i]);
  }
  return merged;
}

function renderWaves(wavesArr){
  if (wavesLayerGroup){
    wavesLayerGroup.clearLayers();
  }
  if (!wavesArr.length){
    updateLegend(NaN, NaN);
    return;
  }

  const speedSamples = [];
  for (const w of wavesArr){
    for (const idx of w.indices){
      const seg = segments[idx];
      if (seg && Number.isFinite(seg.speedKmh)) speedSamples.push(seg.speedKmh);
    }
  }
  const positiveSamples = speedSamples.filter(v => v > 0.5);
  const minSpeed = positiveSamples.length
    ? Math.min(...positiveSamples)
    : (speedSamples.length ? Math.min(...speedSamples) : NaN);
  const maxSpeed = speedSamples.length ? Math.max(...speedSamples) : NaN;
  updateLegend(minSpeed, maxSpeed);
  let colorMin = Number.isFinite(minSpeed) ? minSpeed : 0;
  let colorMax = Number.isFinite(maxSpeed) ? maxSpeed : colorMin + 1;
  if (Math.abs(colorMax - colorMin) < 1e-3) colorMax = colorMin + 1;

  if (!mapReady || !wavesLayerGroup){
    return;
  }

  for (const w of wavesArr){
    for (const idx of w.indices){
      const seg = segments[idx];
      if (!seg) continue;
      const coords = [seg.a, seg.b];
      L.polyline(coords, {
        color: 'rgba(255,255,255,0.9)',
        weight: 6,
        opacity: 0.75,
        lineCap: 'round'
      }).addTo(wavesLayerGroup);
      L.polyline(coords, {
        color: speedToColor(seg.speedKmh, colorMin, colorMax),
        weight: 4,
        opacity: 0.95,
        lineCap: 'round'
      }).addTo(wavesLayerGroup);
    }

    if (w.startPoint){
      L.circleMarker(w.startPoint, {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: speedToColor(w.maxKmh, colorMin, colorMax),
        fillOpacity: 0.95
      }).addTo(wavesLayerGroup)
        .bindPopup(
          `<b>Vague</b><br>
          Distance : ${fmtDistance(w.distM)}<br>
          Durée : ${fmtDuration(w.durationS)}<br>
          Vitesse max : ${w.maxKmh.toFixed(1)} km/h`
        );
    }
  }
}

function getDirectionSettings(){
  if (!directionToggle || !directionAngleInput || !directionToleranceInput){
    return { enabled:false, direction:0, tolerance:DEFAULT_DIRECTION_TOLERANCE };
  }
  const enabled = !directionToggle.disabled && Boolean(directionToggle.checked);
  let direction = parseFloat(directionAngleInput.value);
  if (!Number.isFinite(direction)) direction = 0;
  direction = normalizeBearing(direction);
  let tolerance = parseFloat(directionToleranceInput.value);
  if (!Number.isFinite(tolerance)) tolerance = DEFAULT_DIRECTION_TOLERANCE;
  tolerance = clamp(tolerance, 0, 180);
  return { enabled, direction, tolerance };
}

function updateDirectionInputsState(){
  if (!directionToggle || !directionAngleInput || !directionToleranceInput) return;
  const toggleDisabled = Boolean(directionToggle.disabled);
  const active = !toggleDisabled && directionToggle.checked;
  directionAngleInput.disabled = toggleDisabled || !active;
  directionToleranceInput.disabled = toggleDisabled || !active;
}

function updateDirectionVisual(settings){
  if (!directionLayerGroup){
    return;
  }
  directionLayerGroup.clearLayers();
  const config = settings ?? getDirectionSettings();
  if (!mapReady || !config.enabled || !map) {
    return;
  }
  const originLatLng = trackBounds ? trackBounds.getCenter() : (map ? map.getCenter() : null);
  const origin = toLatLon(originLatLng);
  if (!origin) return;
  let arrowLength = 250;
  if (trackBounds){
    const ne = trackBounds.getNorthEast();
    const sw = trackBounds.getSouthWest();
    const diag = haversineDistanceM({lat:sw.lat, lon:sw.lng}, {lat:ne.lat, lon:ne.lng});
    if (Number.isFinite(diag)){
      arrowLength = clamp(diag * 0.25, 120, 900);
    }
  }
  drawArrow(directionLayerGroup, origin, config.direction, {
    length: arrowLength,
    headLength: arrowLength * 0.28,
    color: '#f97316',
    weight: 4,
    opacity: 0.92,
    fillOpacity: 0.88,
    dashArray: '6 10'
  });
}

function initializeDirectionUI(){
  if (directionAngleInput){
    directionAngleInput.value = '0';
  }
  if (directionToleranceInput){
    directionToleranceInput.value = String(DEFAULT_DIRECTION_TOLERANCE);
  }
  if (directionToggle){
    directionToggle.checked = false;
  }
  updateDirectionInputsState();
  updateDirectionVisual();
}

// ---- Export GPX --------------------
exportBtn.addEventListener('click', ()=>{
  if (!points.length) return;
  const gpx = buildGPX(points, waves);
  const blob = new Blob([gpx], {type: 'application/gpx+xml'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `session_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.gpx`;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  a.remove();
});

// Crée un GPX avec la trace principale + une piste par vague détectée
function buildGPX(pts, wavesArr){
  const esc = s => String(s).replace(/[<&>]/g, m => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]));
  const trkpts = pts.map(p => {
    const time = p.time instanceof Date && !isNaN(p.time) ? p.time.toISOString() : null;
    const eleTag = Number.isFinite(p.ele) ? `<ele>${p.ele}</ele>` : '';
    const timeTag = time ? `<time>${time}</time>` : '';
    return `<trkpt lat="${p.lat}" lon="${p.lon}">${eleTag}${timeTag}</trkpt>`;
  }).join('\n        ');

  // Vagues en pistes dédiées (facilite le repérage sur import)
  const waveTrks = wavesArr.map((w,i)=>{
    const slice = pts.slice(w.startIdx, w.endIdx+2);
    const body = slice.map(p=>{
      const time = p.time instanceof Date && !isNaN(p.time) ? p.time.toISOString() : null;
      const eleTag = Number.isFinite(p.ele) ? `<ele>${p.ele}</ele>` : '';
      const timeTag = time ? `<time>${time}</time>` : '';
      return `<trkpt lat="${p.lat}" lon="${p.lon}">${eleTag}${timeTag}</trkpt>`;
    }).join('\n            ');
    return `
      <trk>
        <name>${esc(`Wave ${i+1} • ${fmtDistance(w.distM)} • ${w.maxKmh.toFixed(1)} km/h`)}</name>
        <trkseg>
            ${body}
        </trkseg>
      </trk>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="Bodyboard Viewer" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>Bodyboard Session</name>
    <trkseg>
        ${trkpts}
    </trkseg>
  </trk>
  ${waveTrks}
</gpx>`;
}

// ---- Divers UI ---------------------
function setEnabled(loaded){
  detectBtn.disabled = !loaded;
  exportBtn.disabled = !loaded;
  fitBtn.disabled = !loaded || !mapReady;
  clearBtn.disabled = !loaded;
  thresholdRange.disabled = !loaded;
  thresholdNumber.disabled = !loaded;
  minDurationInput.disabled = !loaded;
  if (directionToggle){
    directionToggle.disabled = !loaded;
  }
  updateDirectionInputsState();
}

thresholdRange.addEventListener('input', ()=>{
  const val = parseFloat(thresholdRange.value);
  const applied = setThreshold(val);
  updateAutoThresholdLabel(applied);
  runWaveDetection();
});

thresholdNumber.addEventListener('input', ()=>{
  if (thresholdNumber.value === '') return;
  const val = parseFloat(thresholdNumber.value);
  if (!Number.isFinite(val)) return;
  const applied = setThreshold(val);
  updateAutoThresholdLabel(applied);
  runWaveDetection();
});

thresholdNumber.addEventListener('blur', ()=>{
  if (thresholdNumber.value === ''){
    const applied = setThreshold(autoThreshold ?? 15);
    updateAutoThresholdLabel(applied);
  }
});

fitBtn.addEventListener('click', ()=>{
  if (!mapReady || !map || !trackBounds) return;
  map.fitBounds(trackBounds, { padding:[30,30] });
});
clearBtn.addEventListener('click', ()=>{
  points = []; segments = []; stats = null; waves = [];
  if (trackLayerGroup) trackLayerGroup.clearLayers();
  if (wavesLayerGroup) wavesLayerGroup.clearLayers();
  if (directionLayerGroup) directionLayerGroup.clearLayers();
  if (mapReady && map) map.setView([20,0],2);
  autoThreshold = null;
  thresholdRange.min = thresholdNumber.min = String(DEFAULT_THRESHOLD_MIN);
  thresholdRange.max = String(DEFAULT_THRESHOLD_MAX);
  thresholdNumber.max = String(DEFAULT_THRESHOLD_NUMBER_MAX);
  setThreshold(15);
  updateAutoThresholdLabel();
  resetStatsUI();
  resetWaveUI();
  setEnabled(false);
  fileInput.value = '';
  initializeDirectionUI();
});

minDurationInput.addEventListener('change', ()=>{
  runWaveDetection();
});

minDurationInput.addEventListener('input', ()=>{
  if (minDurationInput.disabled) return;
  runWaveDetection();
});

if (directionToggle){
  directionToggle.addEventListener('change', ()=>{
    if (directionToggle.disabled) return;
    updateDirectionInputsState();
    updateDirectionVisual();
    runWaveDetection();
  });
}

if (directionAngleInput){
  const normalizeAngleInput = ()=>{
    if (directionAngleInput.disabled) return;
    const settings = getDirectionSettings();
    directionAngleInput.value = formatBearing(settings.direction);
  };
  directionAngleInput.addEventListener('input', ()=>{
    if (directionAngleInput.disabled) return;
    updateDirectionVisual();
    runWaveDetection();
  });
  directionAngleInput.addEventListener('blur', ()=>{
    if (directionAngleInput.disabled) return;
    if (directionAngleInput.value === ''){
      directionAngleInput.value = formatBearing(0);
    } else {
      normalizeAngleInput();
    }
  });
}

if (directionToleranceInput){
  const normalizeToleranceInput = ()=>{
    if (directionToleranceInput.disabled) return;
    const settings = getDirectionSettings();
    directionToleranceInput.value = String(Math.round(settings.tolerance));
  };
  directionToleranceInput.addEventListener('input', ()=>{
    if (directionToleranceInput.disabled) return;
    runWaveDetection();
  });
  directionToleranceInput.addEventListener('blur', ()=>{
    if (directionToleranceInput.disabled) return;
    if (directionToleranceInput.value === ''){
      directionToleranceInput.value = String(DEFAULT_DIRECTION_TOLERANCE);
    }
    normalizeToleranceInput();
  });
}

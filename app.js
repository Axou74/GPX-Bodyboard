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

// ---------- Carte Leaflet ----------
let map = null;
let baseLayer = null;
let trackLayerGroup = null;
let wavesLayerGroup = null;
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
    wavesLayerGroup = L.layerGroup().addTo(map);

    mapReady = true;

    // vue par défaut (monde)
    map.setView([20, 0], 2);
  } catch (err) {
    console.error('Impossible d\'initialiser la carte Leaflet.', err);
    map = null;
    baseLayer = null;
    trackLayerGroup = null;
    wavesLayerGroup = null;
    mapReady = false;
    showMapStatus();
  }
}

// ------------- État ---------------
let points = [];        // [{lat, lon, ele, time}]
let segments = [];      // [{a:[lat,lon], b:[lat,lon], speedKmh, distM, dtS}]
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

// Couleur par vitesse (km/h) : palette type "blue -> red"
function speedToColor(speedKmh, minKmh, maxKmh){
  if (!Number.isFinite(minKmh) || !Number.isFinite(maxKmh)){
    minKmh = Number.isFinite(speedKmh) ? speedKmh : 0;
    maxKmh = minKmh + 1;
  }
  if (!Number.isFinite(speedKmh)) speedKmh = minKmh;
  const range = Math.max(1e-3, (maxKmh - minKmh));
  const t = clamp((speedKmh - minKmh) / range, 0, 1);
  // Interpolation via 5 stops (bleu -> vert -> jaune -> orange -> rouge)
  // On interpole en HSL pour une transition douce.
  const stops = [
    {h:205, s:70, l:45}, // bleu
    {h:100, s:55, l:55}, // vert
    {h:55,  s:90, l:60}, // jaune
    {h:25,  s:85, l:55}, // orange
    {h:355, s:75, l:48}  // rouge
  ];
  const idx = Math.floor(t * (stops.length - 1));
  const f = t * (stops.length - 1) - idx;
  const a = stops[idx], b = stops[Math.min(idx+1, stops.length-1)];
  const h = a.h + (b.h - a.h)*f;
  const s = a.s + (b.s - a.s)*f;
  const l = a.l + (b.l - a.l)*f;
  return `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`;
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

    segments.push({ a:[a.lat,a.lon], b:[b.lat,b.lon], distM: d, dtS: dt, speedKmh });

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
    legendGradient.style.background = 'linear-gradient(to right, #2b83ba, #abdda4, #ffffbf, #fdae61, #d7191c)';
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

function updateWaveTable(ws){
  wavesTableBody.innerHTML = '';
  if (!ws.length){
    wavesEmpty.style.display = 'block';
    return;
  }
  wavesEmpty.style.display = 'none';
  ws.forEach((w, idx)=>{
    const tr = document.createElement('tr');
    const avg = w.durationS > 0 ? (w.distM / w.durationS * 3.6) : NaN;
    const avgStr = Number.isFinite(avg) ? `${avg.toFixed(1)} km/h` : '–';
    tr.innerHTML = `
      <td>${idx+1}</td>
      <td>${fmtDistance(w.distM)}</td>
      <td>${fmtDuration(w.durationS)}</td>
      <td>${w.maxKmh.toFixed(1)} km/h</td>
      <td>${avgStr}</td>`;
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
  const midPoint = canUseLeaflet && latlngs.length ? latlngs[Math.floor(latlngs.length/2)] : null;
  return { ...w, startIdx:start, endIdx:end, indices, bounds, midPoint };
}

// ---- Détection des vagues ----------
detectBtn.addEventListener('click', ()=>{
  runWaveDetection(true);
});

function runWaveDetection(){
  if (!segments.length){
    waves = [];
    if (wavesLayerGroup) wavesLayerGroup.clearLayers();
    resetWaveUI();
    updateStatsUI();
    return;
  }
  const thresholdInput = parseFloat(thresholdNumber.value);
  const threshold = Number.isFinite(thresholdInput) ? thresholdInput : (autoThreshold ?? 15);
  const minDur = Math.max(0, Number(minDurationInput.value) || 0);
  waves = detectWaves(segments, threshold, minDur).map(enrichWave);
  renderWaves(waves);
  updateWaveTable(waves);
  updateStatsUI();
  updateAutoThresholdLabel(threshold);
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
  const minSpeed = speedSamples.length ? Math.min(...speedSamples) : NaN;
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

    if (w.midPoint){
      L.circleMarker(w.midPoint, {
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
});

minDurationInput.addEventListener('change', ()=>{
  runWaveDetection();
});

minDurationInput.addEventListener('input', ()=>{
  if (minDurationInput.disabled) return;
  runWaveDetection();
});

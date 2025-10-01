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

// ---------- Carte Leaflet ----------
let map, baseLayer;
let trackLayerGroup = L.layerGroup();
let wavesLayerGroup = L.layerGroup();

initMap();

function initMap(){
  map = L.map('map', {
    preferCanvas: true, // meilleur rendu pour beaucoup de segments
    zoomControl: true
  });

  // Fond satellite ESRI (gratuit, pas de clé). Voir TOS ESRI pour usage.
  baseLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Tiles © Esri — Source: Esri, Earthstar Geographics' }
  ).addTo(map);

  trackLayerGroup.addTo(map);
  wavesLayerGroup.addTo(map);

  // vue par défaut (monde)
  map.setView([20, 0], 2);
}

// ------------- État ---------------
let points = [];        // [{lat, lon, ele, time}]
let segments = [];      // [{a:[lat,lon], b:[lat,lon], speedKmh, distM, dtS}]
let stats = null;       // {distM, durationS, avgKmh, maxKmh}
let waves = [];         // [{startIdx, endIdx, distM, durationS, maxKmh}]

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
  const t = clamp((speedKmh - minKmh) / Math.max(1e-6, (maxKmh - minKmh)), 0, 1);
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
    updateStatsUI();
    setEnabled(true);

  }catch(err){
    alert('Erreur au chargement: ' + err.message);
    console.error(err);
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
  trackLayerGroup.clearLayers();
  wavesLayerGroup.clearLayers();

  if (segments.length === 0) return;

  // Détermine l’échelle couleur sur la distribution des vitesses
  const speeds = segments.map(s=>s.speedKmh).filter(v=>Number.isFinite(v));
  const minK = Math.min(...speeds, 0);
  const maxK = Math.max(...speeds, 1);
  const polylines = [];

  // On dessine segment par segment, chacun avec sa couleur
  for (const seg of segments){
    const color = speedToColor(seg.speedKmh, minK, maxK);
    const line = L.polyline([seg.a, seg.b], {
      color, weight: 4, opacity: 0.95
    });
    line.addTo(trackLayerGroup);
    polylines.push(line);
  }

  // Bounds
  const latlngs = [points[0], points[points.length-1]].map(p=>[p.lat,p.lon]);
  trackBounds = L.latLngBounds(points.map(p=>[p.lat,p.lon]));
  map.fitBounds(trackBounds, { padding: [30,30] });
}

// ---- UI Stats ----------------------
function updateStatsUI(){
  if (!stats){ resetStatsUI(); return; }
  statDistance.textContent = fmtDistance(stats.distM);
  statDuration.textContent = fmtDuration(stats.durationS);
  statAvg.textContent = `${stats.avgKmh.toFixed(2)} km/h`;
  statMax.textContent = `${stats.maxKmh.toFixed(2)} km/h`;
  statWaves.textContent = waves.length ? String(waves.length) : '–';
  statBest.textContent = waves.length ? bestWaveLabel(waves) : '–';
}

function resetStatsUI(){
  statDistance.textContent = statDuration.textContent = statAvg.textContent =
  statMax.textContent = statWaves.textContent = statBest.textContent = '–';
}

function bestWaveLabel(ws){
  // "Meilleure vague" = celle avec le pic de vitesse max (fallback : distance)
  let best = ws[0];
  for (const w of ws){
    if (w.maxKmh > best.maxKmh) best = w;
    else if (w.maxKmh === best.maxKmh && w.distM > best.distM) best = w;
  }
  return `${fmtDistance(best.distM)} • ${fmtDuration(best.durationS)} • ${best.maxKmh.toFixed(1)} km/h`;
}

// ---- Détection des vagues ----------
detectBtn.addEventListener('click', ()=>{
  const threshold = Number(thresholdNumber.value) || 15;
  const minDur = Math.max(0, Number(minDurationInput.value) || 0);
  waves = detectWaves(segments, threshold, minDur);
  renderWaves(waves);
  updateStatsUI();
});

function detectWaves(segs, thresholdKmh=15, minDurationS=2){
  const found = [];
  let cur = null;

  for (let i=0;i<segs.length;i++){
    const s = segs[i];
    const over = s.speedKmh >= thresholdKmh && Number.isFinite(s.dtS) && s.dtS>0;

    if (over){
      if (!cur){
        cur = { startIdx: i-1 >= 0 ? i-1 : 0, endIdx: i, distM: 0, durationS: 0, maxKmh: 0 };
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

  // Fusionne des vagues séparées par 1 segment court sous le seuil (atténue bruit)
  const merged = [];
  for (let i=0;i<found.length;i++){
    if (!merged.length) { merged.push(found[i]); continue; }
    const prev = merged[merged.length-1];
    const gapIdx = prev.endIdx + 1; // segment qui sépare
    if (gapIdx < segs.length){
      const gap = segs[gapIdx];
      const shortGap = Number.isFinite(gap.dtS) ? gap.dtS <= 1.0 : false;
      if (shortGap){
        // fusion
        prev.endIdx = found[i].endIdx;
        prev.distM += found[i].distM + (gap.distM||0);
        prev.durationS += found[i].durationS + (gap.dtS||0);
        prev.maxKmh = Math.max(prev.maxKmh, found[i].maxKmh);
        continue;
      }
    }
    merged.push(found[i]);
  }
  return merged;
}

function renderWaves(wavesArr){
  wavesLayerGroup.clearLayers();
  if (!wavesArr.length) return;

  for (const w of wavesArr){
    // récupère les points de startIdx -> endIdx+1
    const pts = points.slice(w.startIdx, w.endIdx+2).map(p=>[p.lat,p.lon]);

    // polyligne de la vague (accent)
    L.polyline(pts, {
      color:'#ffffff', weight:6, opacity:0.8
    }).addTo(wavesLayerGroup);
    L.polyline(pts, {
      color:'#d7191c', weight:3.5, opacity:0.9
    }).addTo(wavesLayerGroup);

    // popup résumé
    const mid = pts[Math.floor(pts.length/2)];
    L.circleMarker(mid, {
      radius: 6, color:'#d7191c', fill:true, fillOpacity:0.9
    }).addTo(wavesLayerGroup)
      .bindPopup(
        `<b>Vague</b><br>
        Distance: ${fmtDistance(w.distM)}<br>
        Durée: ${fmtDuration(w.durationS)}<br>
        Vitesse max: ${w.maxKmh.toFixed(1)} km/h`
      );
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
  fitBtn.disabled = !loaded;
  clearBtn.disabled = !loaded;
}

thresholdRange.addEventListener('input', ()=>{
  thresholdNumber.value = thresholdRange.value;
});
thresholdNumber.addEventListener('input', ()=>{
  thresholdRange.value = thresholdNumber.value;
});

fitBtn.addEventListener('click', ()=>{
  if (trackBounds) map.fitBounds(trackBounds, { padding:[30,30] });
});
clearBtn.addEventListener('click', ()=>{
  points = []; segments = []; stats = null; waves = [];
  trackLayerGroup.clearLayers(); wavesLayerGroup.clearLayers();
  map.setView([20,0],2);
  resetStatsUI(); setEnabled(false);
});

// ---------- Auto-détection: recalcul instantané si seuil change (optionnel) ----
for (const el of [thresholdRange, thresholdNumber, minDurationInput]){
  el.addEventListener('change', ()=>{
    if (!segments.length) return;
    waves = detectWaves(segments, Number(thresholdNumber.value)||15, Number(minDurationInput.value)||0);
    renderWaves(waves);
    updateStatsUI();
  });
}

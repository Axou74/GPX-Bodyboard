/* Bodyboard GPX/CSV Viewer – Détection de vagues v2
 * -------------------------------------------------
 * Refonte de la détection + coloration.
 * Conserve : parsing, stats, Leaflet, table et export GPX.
 *
 * Changelog (v2) :
 * - Détection adaptative par fenêtre locale (médiane + k·σ)
 * - Fin de vague par chute relative depuis le pic (grâce temporelle)
 * - Stabilité de la direction (écart-type angulaire max)
 * - Coloration : vitesse moyenne, accélération ou dégradé interne début→pic→fin
 * - Badge vague coloré ; popup avec sparkline SVG vitesse
 *
 * La base de l’app (UI, parsing, rendu Leaflet) est héritée de ta version initiale:contentReference[oaicite:5]{index=5}:contentReference[oaicite:6]{index=6}.
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

const useAdaptiveToggle = document.getElementById('useAdaptive');
const winSecondsInput = document.getElementById('winSeconds');
const kSigmaInput = document.getElementById('kSigma');
const dropPctInput = document.getElementById('dropPct');
const endGraceInput = document.getElementById('endGrace');

const directionToggle = document.getElementById('directionToggle');
const directionAngleInput = document.getElementById('directionAngle');
const directionToleranceInput = document.getElementById('directionTolerance');
const dirStdMaxInput = document.getElementById('dirStdMax');

const colorModeSelect = document.getElementById('colorMode');

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

// ---------- Constantes ----------
const DEFAULT_THRESHOLD_MIN = 5;
const DEFAULT_THRESHOLD_MAX = 50;
const DEFAULT_THRESHOLD_NUMBER_MAX = 100;
const DEFAULT_DIRECTION_TOLERANCE = 45;
const DEFAULT_EMPTY_MESSAGE = 'Aucune vague détectée pour le moment.';

const COLOR_MODE = {
  AVG: 'avg',
  ACCEL: 'accel',
  INTRA: 'intra'
};

// ---------- Carte Leaflet ----------
let map = null;
let baseLayer = null;
let trackLayerGroup = null;
let wavesLayerGroup = null;
let directionLayerGroup = null;
let mapReady = false;

function showMapStatus(){ if (mapStatus){ mapStatus.hidden = false; } }
function hideMapStatus(){ if (mapStatus){ mapStatus.hidden = true; } }

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
    map = L.map('map', { preferCanvas: true, zoomControl: true });
    baseLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Tiles © Esri — Source: Esri, Earthstar Geographics' }
    ).addTo(map);

    trackLayerGroup = L.layerGroup().addTo(map);
    directionLayerGroup = L.layerGroup().addTo(map);
    wavesLayerGroup = L.layerGroup().addTo(map);

    mapReady = true;
    map.setView([20, 0], 2);
  } catch (err) {
    console.error('Impossible d\'initialiser la carte Leaflet.', err);
    mapReady = false; map = null;
    showMapStatus();
  }
}

// ------------- État ---------------
let points = [];        // [{lat, lon, ele, time}]
let segments = [];      // [{a:[lat,lon], b:[lat,lon], speedKmh, distM, dtS, bearingDeg, accelKmhS}]
let stats = null;       // {distM, durationS, avgKmh, maxKmh}
let waves = [];         // [{... enrichi ...}]
let autoThreshold = null;

// ------------- Helpers géo/temps ------------
const toRad = d => d * Math.PI / 180;
function haversineDistanceM(a, b){
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function clamp(v,min,max){return Math.max(min, Math.min(max, v));}
function fmtDistance(m){ if (!isFinite(m)) return '–'; return m>=1000 ? (m/1000).toFixed(2)+' km' : m.toFixed(0)+' m'; }
function fmtDuration(s){
  if (!isFinite(s)) return '–';
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=Math.floor(s%60);
  return (h>0?`${h}h `:'')+`${m}m ${sec}s`;
}
function fmtTime(date){
  if (!(date instanceof Date) || isNaN(date)) return '–';
  return date.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}
function normalizeBearing(deg){ if (!Number.isFinite(deg)) return NaN; const w=deg%360; return w<0?w+360:w; }
function angularDifference(a,b){
  if (!Number.isFinite(a)||!Number.isFinite(b)) return NaN;
  const diff = Math.abs(normalizeBearing(a)-normalizeBearing(b))%360;
  return diff>180?360-diff:diff;
}
function bearingDegrees(a,b){
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const dLon=toRad(b.lon-a.lon);
  const y=Math.sin(dLon)*Math.cos(lat2);
  const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  return normalizeBearing(Math.atan2(y,x)*180/Math.PI);
}
function toLatLon(v){
  if (!v) return null;
  if (Array.isArray(v)){ const [lat,lon]=v; if (!Number.isFinite(lat)||!Number.isFinite(lon)) return null; return {lat,lon}; }
  const lat=v.lat??v.latitude??null, lon=v.lon??v.lng??v.longitude??null;
  if (!Number.isFinite(lat)||!Number.isFinite(lon)) return null;
  return {lat,lon};
}
function destinationPoint(origin, bearingDeg, distanceM){
  const p = toLatLon(origin); if (!p||!Number.isFinite(distanceM)||distanceM<=0) return null;
  const R=6371000, ang=distanceM/R, lat1=toRad(p.lat), lon1=toRad(p.lon), brng=toRad(normalizeBearing(bearingDeg));
  const lat2=Math.asin(Math.sin(lat1)*Math.cos(ang)+Math.cos(lat1)*Math.sin(ang)*Math.Cos?Math.Cos(brng):Math.cos(brng));
  const lon2=lon1+Math.atan2(Math.sin(brng)*Math.sin(ang)*Math.cos(lat1), Math.cos(ang)-Math.sin(lat1)*Math.sin(lat2));
  return { lat: lat2*180/Math.PI, lon: ((lon2*180/Math.PI+540)%360)-180 };
}
function circularStdDeg(samples){
  const vals = samples.filter(Number.isFinite);
  if (!vals.length) return NaN;
  const sin = vals.reduce((a,d)=>a+Math.sin(toRad(d)),0);
  const cos = vals.reduce((a,d)=>a+Math.cos(toRad(d)),0);
  const R = Math.sqrt(sin*sin+cos*cos)/vals.length;
  // std angulaire approx : sqrt(-2 ln R) en radians
  return Math.sqrt(Math.max(0, -2*Math.log(Math.max(R,1e-9))))*180/Math.PI;
}

// Couleurs (dégradé perceptuel de ta v1):contentReference[oaicite:7]{index=7}
const SPEED_COLOR_STOPS = [
  {r:59,g:130,b:246}, {r:16,g:185,b:129}, {r:132,g:204,b:22},
  {r:250,g:204,b:21}, {r:249,g:115,b:22}, {r:220,g:38,b:38}
];
const lerp = (a,b,t)=>a+(b-a)*t;
function speedToColor(speedKmh, minKmh, maxKmh){
  if (!Number.isFinite(minKmh)||!Number.isFinite(maxKmh)){
    minKmh = Number.isFinite(speedKmh)?speedKmh:0; maxKmh=minKmh+1;
  }
  if (!Number.isFinite(speedKmh)) speedKmh=minKmh;
  const range=Math.max(1e-3,(maxKmh-minKmh));
  const t=clamp((speedKmh-minKmh)/range,0,1);
  const scaled=t*(SPEED_COLOR_STOPS.length-1);
  const idx=Math.floor(scaled), frac=scaled-idx;
  const s=SPEED_COLOR_STOPS[idx], e=SPEED_COLOR_STOPS[Math.min(idx+1,SPEED_COLOR_STOPS.length-1)];
  const r=Math.round(lerp(s.r,e.r,frac)), g=Math.round(lerp(s.g,e.g,frac)), b=Math.round(lerp(s.b,e.b,frac));
  return `rgb(${r} ${g} ${b})`;
}
const GREEN='rgb(16 185 129)', RED='rgb(220 38 38)', BLUE='rgb(59 130 246)';

// ------------- Parsing -------------
fileInput.addEventListener('change', async (e)=>{
  const file=e.target.files?.[0]; if (!file) return;
  try{
    const text=await file.text(); const name=file.name.toLowerCase();
    if (name.endsWith('.gpx')) points=parseGPX(text);
    else if (name.endsWith('.csv')) points=parseCSV(text);
    else throw new Error('Format non supporté (utilise .gpx ou .csv).');

    if (points.length<2) throw new Error('Pas assez de points dans la trace.');

    computeSegmentsAndStats();
    renderTrack();
    configureThresholdControls();
    setEnabled(true);
    runWaveDetection();
  }catch(err){
    alert('Erreur au chargement: '+err.message);
    console.error(err);
  }finally{ fileInput.value=''; }
});

function parseGPX(xmlText){
  const dom=new DOMParser().parseFromString(xmlText,'application/xml');
  const parserErr=dom.querySelector('parsererror'); if (parserErr) throw new Error('GPX invalide.');
  const trkpts=dom.getElementsByTagName('trkpt'); const pts=[];
  for (let i=0;i<trkpts.length;i++){
    const n=trkpts[i]; const lat=parseFloat(n.getAttribute('lat')); const lon=parseFloat(n.getAttribute('lon'));
    const eleNode=n.getElementsByTagName('ele')[0]; const timeNode=n.getElementsByTagName('time')[0];
    const ele=eleNode?parseFloat(eleNode.textContent):null; const time=timeNode?new Date(timeNode.textContent.trim()):null;
    if (Number.isFinite(lat)&&Number.isFinite(lon)) pts.push({lat,lon,ele,time});
  }
  return pts;
}
function parseCSV(text){
  const lines=text.trim().split(/\r?\n/); if (lines.length<2) throw new Error('CSV trop court.');
  const header=lines[0].split(',').map(s=>s.trim().toLowerCase());
  const iTime=header.indexOf('time'), iLat=header.indexOf('lat'), iLon=header.indexOf('lon'), iEle=header.indexOf('ele');
  if (iTime<0||iLat<0||iLon<0) throw new Error('CSV attendu avec colonnes: time,lat,lon[,ele]');
  const pts=[];
  for (let i=1;i<lines.length;i++){
    if (!lines[i].trim()) continue;
    const c=lines[i].split(',').map(s=>s.trim());
    const lat=parseFloat(c[iLat]), lon=parseFloat(c[iLon]), ele=(iEle>=0&&c[iEle]!==undefined)?parseFloat(c[iEle]):null;
    const time=new Date((c[iTime]||'').replace(' ','T'));
    if (Number.isFinite(lat)&&Number.isFinite(lon)) pts.push({lat,lon,ele,time});
  }
  return pts;
}

// ---- Calculs & Stats --------------
function computeSegmentsAndStats(){
  segments=[]; let distM=0, durationS=0, maxKmh=0;
  for (let i=1;i<points.length;i++){
    const a=points[i-1], b=points[i];
    const d=haversineDistanceM(a,b);
    const tA=a.time?.getTime?.() ?? NaN, tB=b.time?.getTime?.() ?? NaN;
    const dt=Number.isFinite(tA)&&Number.isFinite(tB)?(tB-tA)/1000:NaN;
    const speedMS=(Number.isFinite(dt)&&dt>0)?d/dt:0;
    const speedKmh=speedMS*3.6;
    const bearingDeg=Number.isFinite(d)?bearingDegrees({lat:a.lat,lon:a.lon},{lat:b.lat,lon:b.lon}):NaN;

    let accelKmhS=0;
    if (i>1){
      const prev=segments[i-2];
      if (prev && Number.isFinite(prev.dtS) && prev.dtS>0){
        accelKmhS = (speedKmh - prev.speedKmh) / prev.dtS;
      }
    }
    segments.push({ a:[a.lat,a.lon], b:[b.lat,b.lon], distM:d, dtS:dt, speedKmh, bearingDeg, accelKmhS });

    if (Number.isFinite(d)) distM+=d;
    if (Number.isFinite(dt)&&dt>0) durationS+=dt;
    if (speedKmh>maxKmh) maxKmh=speedKmh;
  }
  const avgKmh = (distM/1000) / (durationS/3600 || 1e-9);
  stats = { distM, durationS, avgKmh, maxKmh };
}

// ---- Rendu Leaflet -----------------
let trackBounds=null;
function renderTrack(){
  if (!mapReady||!trackLayerGroup||!wavesLayerGroup){ trackBounds=null; return; }
  trackLayerGroup.clearLayers(); wavesLayerGroup.clearLayers();
  if (directionLayerGroup) directionLayerGroup.clearLayers();
  if (segments.length===0 || points.length===0){
    trackBounds=null; updateLegend(NaN,NaN); resetWaveUI(); return;
  }
  const latlngs=points.map(p=>[p.lat,p.lon]);

  // Halo blanc puis trait gris (hérité de ta v1):contentReference[oaicite:8]{index=8}
  L.polyline(latlngs,{color:'rgba(255,255,255,0.25)',weight:7,opacity:0.3,lineCap:'round'}).addTo(trackLayerGroup);
  L.polyline(latlngs,{color:'#4b5563',weight:4,opacity:0.55,lineCap:'round'}).addTo(trackLayerGroup);

  trackBounds=L.latLngBounds(latlngs);
  if (mapReady&&map) map.fitBounds(trackBounds,{padding:[30,30]});
  updateDirectionVisual();
}

// ---- UI Stats ----------------------
function updateStatsUI(){
  if (!stats){ resetStatsUI(); return; }
  statDistance.textContent=fmtDistance(stats.distM);
  statDuration.textContent=fmtDuration(stats.durationS);
  statAvg.textContent=`${stats.avgKmh.toFixed(2)} km/h`;
  statMax.textContent=`${stats.maxKmh.toFixed(2)} km/h`;
  statWaves.textContent=segments.length?String(waves.length):'–';
  statBest.textContent=segments.length&&waves.length?bestWaveLabel(waves):'–';
}
function resetStatsUI(){
  statDistance.textContent=statDuration.textContent=statAvg.textContent=
  statMax.textContent=statWaves.textContent=statBest.textContent='–';
}
function bestWaveLabel(ws){
  let best=ws[0]; for (const w of ws){
    if (w.maxKmh>best.maxKmh) best=w;
    else if (w.maxKmh===best.maxKmh && w.distM>best.distM) best=w;
  }
  return `${fmtDistance(best.distM)} • ${fmtDuration(best.durationS)} • ${best.maxKmh.toFixed(1)} km/h`;
}

// ---- Légende -----------------------
function updateLegend(min,max){
  if (!Number.isFinite(min)||!Number.isFinite(max)){
    legendGradient.style.background='linear-gradient(to right, rgb(59 130 246), rgb(16 185 129), rgb(132 204 22), rgb(250 204 21), rgb(249 115 22), rgb(220 38 38))';
    legendMin.textContent=''; legendMax.textContent=''; return;
  }
  if (Math.abs(max-min)<1e-3){
    const color=speedToColor(min,min,min+1);
    legendGradient.style.background=`linear-gradient(to right, ${color}, ${color})`;
    legendMin.textContent=`${min.toFixed(1)} km/h`; legendMax.textContent=`${max.toFixed(1)} km/h`; return;
  }
  const stops=[0,0.25,0.5,0.75,1];
  const colors=stops.map(t=>speedToColor(min+(max-min)*t,min,max));
  legendGradient.style.background=`linear-gradient(to right, ${colors.join(', ')})`;
  legendMin.textContent=`${min.toFixed(1)} km/h`; legendMax.textContent=`${max.toFixed(1)} km/h`;
}

// ---- Contrôles seuil ----
function computeAutoThreshold(segs){
  const speeds=segs.map(s=>s.speedKmh).filter(v=>Number.isFinite(v)&&v>1);
  if (!speeds.length) return 15;
  speeds.sort((a,b)=>a-b);
  const idx=Math.floor(0.75*(speeds.length-1));
  const candidate=speeds[idx];
  return clamp(candidate,5,120);
}
function configureThresholdControls(){
  if (!segments.length){
    autoThreshold=null;
    thresholdRange.min=thresholdNumber.min=String(DEFAULT_THRESHOLD_MIN);
    thresholdRange.max=String(DEFAULT_THRESHOLD_MAX);
    thresholdNumber.max=String(DEFAULT_THRESHOLD_NUMBER_MAX);
    setThreshold(15);
    updateAutoThresholdLabel();
    return;
  }
  const speeds=segments.map(s=>s.speedKmh).filter(Number.isFinite);
  if (!speeds.length){
    autoThreshold=null;
    thresholdRange.min=thresholdNumber.min=String(DEFAULT_THRESHOLD_MIN);
    thresholdRange.max=String(DEFAULT_THRESHOLD_MAX);
    thresholdNumber.max=String(DEFAULT_THRESHOLD_NUMBER_MAX);
    setThreshold(15);
    autoThresholdLabel.textContent='Aucune donnée de vitesse exploitable.';
    return;
  }
  speeds.sort((a,b)=>a-b);
  const minVal=Math.max(0,Math.floor(Math.min(speeds[0],5)));
  const maxSpeed=speeds[speeds.length-1];
  const maxVal=Math.max(minVal+5,Math.ceil(Math.max(maxSpeed,10)));
  thresholdRange.min=thresholdNumber.min=String(minVal);
  thresholdRange.max=String(Math.max(maxVal,DEFAULT_THRESHOLD_MAX));
  thresholdNumber.max=String(Math.max(maxVal,DEFAULT_THRESHOLD_NUMBER_MAX));
  autoThreshold=computeAutoThreshold(segments);
  const applied=setThreshold(autoThreshold);
  updateAutoThresholdLabel(applied);
}
function setThreshold(value){
  const min=Number(thresholdRange.min)||0, max=Number(thresholdRange.max)||100;
  const clamped=clamp(value,min,max);
  const stepped=Math.round(clamped*2)/2;
  const display=Number.isInteger(stepped)?String(stepped):stepped.toFixed(1);
  thresholdRange.value=display; thresholdNumber.value=display; return stepped;
}
function updateAutoThresholdLabel(current){
  if (!Number.isFinite(autoThreshold)){ autoThresholdLabel.textContent=''; return; }
  const actual=Number.isFinite(current)?current:parseFloat(thresholdNumber.value);
  if (Number.isFinite(actual)){
    const same=Math.abs(actual-autoThreshold)<0.25;
    autoThresholdLabel.textContent = same
      ? `Seuil automatique suggéré : ${autoThreshold.toFixed(1)} km/h`
      : `Seuil automatique suggéré : ${autoThreshold.toFixed(1)} km/h (actuel : ${actual.toFixed(1)} km/h)`;
  } else autoThresholdLabel.textContent=`Seuil automatique suggéré : ${autoThreshold.toFixed(1)} km/h`;
}

// ---- Tableau vagues ----------------
function waveTypeLabel(w){
  if (w.durationS<4) return 'courte';
  if (w.avgKmh>=25) return 'rapide';
  if (w.distM>=80) return 'longue';
  return 'standard';
}
function updateWaveTable(ws, options={}){
  const directionSettings=options.directionSettings||null;
  const filterApplied=Boolean(directionSettings?.enabled);
  const rejected=Math.max(0,options.rejectedCount||0);
  const rawCount=options.rawCount ?? ws.length;

  wavesTableBody.innerHTML='';
  if (!ws.length){
    wavesEmpty.style.display='block';
    wavesEmpty.textContent = filterApplied && rawCount>0
      ? `Aucune vague ne respecte le sens choisi${rejected?` (${rejected} ignorée${rejected>1?'s':''})`:''}.`
      : DEFAULT_EMPTY_MESSAGE;
    return;
  }
  const showDelta=filterApplied && Number.isFinite(directionSettings?.direction);
  if (filterApplied && rejected>0){
    wavesEmpty.style.display='block';
    wavesEmpty.textContent=`${rejected} vague${rejected>1?'s':''} ignorée${rejected>1?'s':''} car hors tolérance.`;
  } else wavesEmpty.style.display='none';

  ws.forEach((w,idx)=>{
    const tr=document.createElement('tr');
    const avg=Number.isFinite(w.avgKmh)?w.avgKmh:(w.durationS>0?(w.distM/w.durationS*3.6):NaN);
    const avgStr=Number.isFinite(avg)?`${avg.toFixed(1)} km/h`:'–';
    const directionStr=Number.isFinite(w.directionDeg)?`${Math.round(w.directionDeg*10)/10}°`:'–';
    const delta=showDelta && Number.isFinite(w.directionDeg)? angularDifference(w.directionDeg,directionSettings.direction):NaN;
    const deltaStr=Number.isFinite(delta)?`${Math.round(delta*10)/10}°`:'–';
    tr.innerHTML=`
      <td>${idx+1}</td>
      <td>${fmtTime(w.startTime)}</td>
      <td>${fmtDistance(w.distM)}</td>
      <td>${fmtDuration(w.durationS)}</td>
      <td>${w.maxKmh.toFixed(1)} km/h</td>
      <td>${avgStr}</td>
      <td>${directionStr}</td>
      <td>${deltaStr}</td>
      <td>${waveTypeLabel(w)}</td>`;
    tr.tabIndex=0;
    if (w.bounds){
      tr.addEventListener('click', ()=>{ map.fitBounds(w.bounds,{padding:[50,50]}); });
      tr.addEventListener('keypress', (evt)=>{ if (evt.key==='Enter'||evt.key===' '){ evt.preventDefault(); map.fitBounds(w.bounds,{padding:[50,50]}); } });
    }
    wavesTableBody.appendChild(tr);
  });
}
function resetWaveUI(){
  wavesTableBody.innerHTML='';
  wavesEmpty.style.display='block';
  wavesEmpty.textContent=DEFAULT_EMPTY_MESSAGE;
  updateLegend(NaN,NaN);
}

// ---- Enrichissement d’une vague ----
function enrichWave(w){
  const overIdx = Array.isArray(w.segmentIndices)?[...new Set(w.segmentIndices)]:[];
  overIdx.sort((a,b)=>a-b);
  const hasOver=overIdx.length>0;
  const start = hasOver?Math.max(0,overIdx[0]):Math.max(0,w.startIdx);
  const endCandidate=hasOver?overIdx[overIdx.length-1]:w.endIdx;
  const end=Math.min(segments.length-1,endCandidate);

  const indices=[]; for (let i=start;i<=end;i++) indices.push(i);
  const slice=points.slice(start,end+2);
  const latlngs=slice.map(p=>[p.lat,p.lon]);

  const startSource=points[start] ?? slice[0] ?? null;
  const canLeaf = mapReady && typeof L!=='undefined';
  const bounds = canLeaf && latlngs.length ? L.latLngBounds(latlngs) : null;
  const startPoint = canLeaf && startSource ? [startSource.lat,startSource.lon] : null;
  const midPoint = canLeaf && latlngs.length ? latlngs[Math.floor(latlngs.length/2)] : null;

  // direction moyenne (circular mean)
  let directionDeg=NaN;
  const bearingSamples = indices.map(i=>segments[i]?.bearingDeg).filter(Number.isFinite);
  if (bearingSamples.length){
    const sin=bearingSamples.reduce((a,d)=>a+Math.sin(toRad(d)),0);
    const cos=bearingSamples.reduce((a,d)=>a+Math.cos(toRad(d)),0);
    if (Math.abs(sin)>1e-6||Math.abs(cos)>1e-6){
      directionDeg=normalizeBearing(Math.atan2(sin,cos)*180/Math.PI);
    }
  } else if (slice.length>=2){
    const first=slice[0], last=slice[slice.length-1];
    directionDeg=bearingDegrees({lat:first.lat,lon:first.lon},{lat:last.lat,lon:last.lon});
  }

  const avgKmh = w.durationS>0 ? (w.distM/w.durationS*3.6) : NaN;

  // Pic (index et valeur)
  let peakIdx = indices[0], peakVal = -Infinity;
  indices.forEach(i=>{ const v=segments[i]?.speedKmh ?? -Infinity; if (v>peakVal){ peakVal=v; peakIdx=i; } });

  // sparkline data (vitesse)
  const speeds = indices.map(i=>segments[i]?.speedKmh ?? 0);
  return {
    ...w, startIdx:start, endIdx:end, indices,
    bounds, startPoint, midPoint, directionDeg, avgKmh, startTime:(startSource?.time instanceof Date && !isNaN(startSource.time))?startSource.time:null,
    peakIdx, peakVal, speeds
  };
}

// ---- Détection des vagues v2 ----
detectBtn.addEventListener('click', ()=> runWaveDetection(true));

function computeLocalStats(winSec){
  // renvoie un tableau localStats[i] = {median, std} centré approximativement autour du segment i
  const localStats = new Array(segments.length).fill(null);
  if (!segments.length || winSec<=0) return localStats;

  let left=0; let sum=0; let sumSq=0; let timeSpan=0;
  const speeds = segments.map(s=>s.speedKmh||0);
  // Utiliser un buffer croissant en temps jusqu’à winSec (méthode glissante)
  for (let right=0; right<segments.length; right++){
    const dtR = Number.isFinite(segments[right].dtS)?segments[right].dtS:0;
    timeSpan += dtR;

    // ajuster la fenêtre pour ne pas dépasser winSec
    while (timeSpan > winSec && left<right){
      const dtL = Number.isFinite(segments[left].dtS)?segments[left].dtS:0;
      timeSpan -= dtL;
      left++;
    }
    const slice = speeds.slice(left, right+1).filter(Number.isFinite);
    if (slice.length){
      const sorted=[...slice].sort((a,b)=>a-b);
      const mid=Math.floor(sorted.length/2);
      const median = sorted.length%2 ? sorted[mid] : 0.5*(sorted[mid-1]+sorted[mid]);
      const mean = sorted.reduce((a,v)=>a+v,0)/sorted.length;
      const variance = sorted.reduce((a,v)=>a+(v-mean)*(v-mean),0)/Math.max(1,(sorted.length-1));
      const std = Math.sqrt(variance);
      localStats[right] = { median, std };
    } else {
      localStats[right] = { median: 0, std: 0 };
    }
  }
  return localStats;
}

function detectWavesV2(options){
  const {
    baseThresholdKmh=15, minDurationS=2,
    useAdaptive=true, winSec=8, kSigma=0.8,
    dropPct=35, endGraceS=1,
    dirStdMaxDeg=25
  } = options;

  const found=[];
  const local = useAdaptive ? computeLocalStats(winSec) : null;

  let cur=null;
  let timeOver=0;         // temps cumulé sur la vague
  let timeUnderPeak=0;    // grâce de fin quand on est sous le critère de fin

  for (let i=0;i<segments.length;i++){
    const s=segments[i];
    const dt = Number.isFinite(s.dtS) && s.dtS>0 ? s.dtS : 0;

    // seuil courant (adaptatif ou fixe)
    let thr = baseThresholdKmh;
    if (useAdaptive && local && local[i]){
      const {median,std} = local[i];
      thr = Math.max(baseThresholdKmh, median + kSigma*std);
    }

    const over = (s.speedKmh >= thr) && dt>0;

    if (over){
      if (!cur){
        cur = {
          startIdx:i, endIdx:i,
          distM:0, durationS:0, maxKmh:0,
          segmentIndices:[], bearings:[], ended:false,
          peak:0
        };
        timeOver=0; timeUnderPeak=0;
      }
      cur.endIdx=i;
      cur.segmentIndices.push(i);
      cur.distM += (Number.isFinite(s.distM)?s.distM:0);
      cur.durationS += dt;
      timeOver += dt;
      if (s.speedKmh>cur.maxKmh){ cur.maxKmh=s.speedKmh; cur.peak = s.speedKmh; }
      if (Number.isFinite(s.bearingDeg)) cur.bearings.push(s.bearingDeg);

      // tant qu'on est au-dessus du seuil, reset la grâce de fin
      timeUnderPeak=0;
    } else if (cur){
      // critère de fin : chute relative vs pic
      const v = s.speedKmh||0;
      const drop = cur.peak>0 ? (1 - v/cur.peak)*100 : 100;
      const below = drop >= dropPct;
      if (below){
        timeUnderPeak += dt;
        if (timeUnderPeak >= endGraceS){
          // on valide la vague si durée suffisante
          if (cur.durationS >= minDurationS && cur.segmentIndices.length){
            found.push(cur);
          }
          cur=null; timeOver=0; timeUnderPeak=0;
        }
      } else {
        // pas assez de drop → on continue la vague
        cur.endIdx=i;
        cur.segmentIndices.push(i);
        cur.distM += (Number.isFinite(s.distM)?s.distM:0);
        cur.durationS += dt;
        if (s.speedKmh>cur.maxKmh){ cur.maxKmh=s.speedKmh; cur.peak = s.speedKmh; }
        if (Number.isFinite(s.bearingDeg)) cur.bearings.push(s.bearingDeg);
        timeUnderPeak=0;
      }
    }
  }
  // fin de trace
  if (cur && cur.durationS>=minDurationS && cur.segmentIndices.length){
    found.push(cur);
  }

  // filtre de stabilité de direction (écart-type angulaire max)
  const stable = found.filter(w=>{
    const std = circularStdDeg(w.bearings||[]);
    return !Number.isFinite(dirStdMaxDeg) || isNaN(std) || std<=dirStdMaxDeg;
  });

  return stable;
}

// ---- Rendu des vagues -------------
function renderWaves(wavesArr){
  if (wavesLayerGroup) wavesLayerGroup.clearLayers();
  if (!wavesArr.length){ updateLegend(NaN,NaN); return; }

  const mode = (colorModeSelect?.value)||COLOR_MODE.AVG;

  // Échelles pour vitesse/accélération
  const avgSamples = wavesArr.map(w=>Number.isFinite(w.avgKmh)?w.avgKmh:NaN).filter(Number.isFinite);
  const minAvg = avgSamples.length?Math.min(...avgSamples):NaN;
  const maxAvg = avgSamples.length?Math.max(...avgSamples):NaN;

  // Pour accélération : prendre tous les segments des vagues
  let minAcc=0, maxAcc=0;
  if (mode===COLOR_MODE.ACCEL){
    const allAcc=[];
    wavesArr.forEach(w=>w.indices.forEach(i=>{
      const a=segments[i]?.accelKmhS; if (Number.isFinite(a)) allAcc.push(a);
    }));
    if (allAcc.length){
      minAcc=Math.min(...allAcc); maxAcc=Math.max(...allAcc);
    }
  }

  // Légende (vitesse pour AVG/INTRA, rien pour ACCEL)
  if (mode===COLOR_MODE.ACCEL){
    updateLegend(NaN,NaN);
  } else {
    let cmin=Number.isFinite(minAvg)?minAvg:0;
    let cmax=Number.isFinite(maxAvg)?maxAvg:(cmin+1);
    if (Math.abs(cmax-cmin)<1e-3) cmax=cmin+1;
    updateLegend(cmin,cmax);
  }

  if (!mapReady||!wavesLayerGroup) return;

  wavesArr.forEach((w, waveIdx)=>{
    const idxSource = (w.segmentIndices && w.segmentIndices.length)? w.segmentIndices : w.indices;

    // Couleur dominante (pour badge & start marker)
    let waveColor = GREEN;
    if (mode===COLOR_MODE.AVG && Number.isFinite(w.avgKmh) && Number.isFinite(minAvg) && Number.isFinite(maxAvg)){
      waveColor = speedToColor(w.avgKmh, minAvg, maxAvg);
    } else if (mode===COLOR_MODE.INTRA){
      waveColor = RED; // pic représentatif
    } else if (mode===COLOR_MODE.ACCEL){
      waveColor = 'rgb(250 204 21)'; // jaune neutre
    }

    // Tracé
    for (let idxI=0; idxI<idxSource.length; idxI++){
      const i = idxSource[idxI];
      const seg = segments[i]; if (!seg) continue;
      const coords=[seg.a, seg.b];

      // Couleur segment selon mode
      let segColor = waveColor;
      if (mode===COLOR_MODE.ACCEL && Number.isFinite(seg.accelKmhS)){
        // map accélération à 0..1 avec tanh pour limiter l’effet des outliers
        const range = Math.max(1e-6, (maxAcc - minAcc));
        const t = clamp((seg.accelKmhS - minAcc)/range, 0, 1);
        segColor = speedToColor(t, 0, 1); // réutilise palette perceptuelle
      } else if (mode===COLOR_MODE.INTRA){
        // dégradé interne début→pic→fin
        const rel = idxSource.length<=1 ? 0.5 : idxI/(idxSource.length-1);
        const peakRel = (w.peakIdx - idxSource[0]) / Math.max(1,(idxSource.length-1));
        if (rel<=peakRel){
          const t = peakRel>0 ? rel/peakRel : 1;
          // GREEN -> RED
          segColor = speedToColor(t, 0, 1); // palette approx ; visuel cohérent
        } else {
          const t = (rel-peakRel)/Math.max(1e-6,(1-peakRel));
          // RED -> BLUE (inverser palette par commodité)
          // Construire manuellement : interpoler entre rouge et bleu
          const r = Math.round(lerp(220,59,t));
          const g = Math.round(lerp(38,130,t));
          const b = Math.round(lerp(38,246,t));
          segColor = `rgb(${r} ${g} ${b})`;
        }
      } else if (mode===COLOR_MODE.AVG && Number.isFinite(w.avgKmh) && Number.isFinite(minAvg) && Number.isFinite(maxAvg)){
        segColor = speedToColor(w.avgKmh, minAvg, maxAvg);
      }

      // Halo + trait coloré
      L.polyline(coords,{color:'rgba(255,255,255,0.9)',weight:6,opacity:0.75,lineCap:'round'}).addTo(wavesLayerGroup);
      L.polyline(coords,{color:segColor,weight:4,opacity:0.95,lineCap:'round'}).addTo(wavesLayerGroup);
    }

    // Marqueurs + popup
    if (w.startPoint){
      L.circleMarker(w.startPoint,{
        radius:6,color:'#ffffff',weight:2,fillColor:waveColor,fillOpacity:0.95
      }).addTo(wavesLayerGroup)
        .bindPopup(buildWavePopupHTML(w, waveIdx+1));
    }
    if (w.midPoint){
      const marker=L.marker(w.midPoint,{
        icon:L.divIcon({ className:'wave-label leaflet-div-icon', html:`<span>${waveIdx+1}</span>` }),
        interactive:false, keyboard:false
      });
      marker.addTo(wavesLayerGroup);
    }
  });
}

function buildWavePopupHTML(w, num){
  const spark = sparklineSVG(w.speeds || []);
  const avgStr = Number.isFinite(w.avgKmh)?w.avgKmh.toFixed(1):'–';
  return `
    <div>
      <b>Vague #${num}</b><br/>
      Début : ${fmtTime(w.startTime)}<br/>
      Distance : ${fmtDistance(w.distM)}<br/>
      Durée : ${fmtDuration(w.durationS)}<br/>
      Vitesse max : ${w.maxKmh.toFixed(1)} km/h<br/>
      Vitesse moy. : ${avgStr} km/h
      <div style="margin-top:.35rem">${spark}</div>
    </div>
  `;
}
function sparklineSVG(values){
  if (!values.length) return '';
  const w=160, h=40, pad=4;
  const min=Math.min(...values), max=Math.max(...values);
  const rng=Math.max(1e-6, max-min);
  const pts = values.map((v,i)=>{
    const x = pad + (w-2*pad) * (i/(Math.max(1,values.length-1)));
    const y = h - pad - (h-2*pad) * ((v-min)/rng);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `
  <svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="vitesse">
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8" />
  </svg>`;
}

// ---- Direction UI ------------------
function getDirectionSettings(){
  if (!directionToggle || !directionAngleInput || !directionToleranceInput){
    return { enabled:false, direction:0, tolerance:DEFAULT_DIRECTION_TOLERANCE, stdMax:25 };
  }
  const enabled = !directionToggle.disabled && Boolean(directionToggle.checked);
  let direction=parseFloat(directionAngleInput.value); if (!Number.isFinite(direction)) direction=0; direction=normalizeBearing(direction);
  let tolerance=parseFloat(directionToleranceInput.value); if (!Number.isFinite(tolerance)) tolerance=DEFAULT_DIRECTION_TOLERANCE; tolerance=clamp(tolerance,0,180);
  let stdMax=parseFloat(dirStdMaxInput.value); if (!Number.isFinite(stdMax)) stdMax=25; stdMax=clamp(stdMax,0,180);
  return { enabled, direction, tolerance, stdMax };
}
function updateDirectionInputsState(){
  if (!directionToggle || !directionAngleInput || !directionToleranceInput || !dirStdMaxInput) return;
  const toggleDisabled=Boolean(directionToggle.disabled);
  const active=!toggleDisabled && directionToggle.checked;
  directionAngleInput.disabled = toggleDisabled || !active;
  directionToleranceInput.disabled = toggleDisabled || !active;
  dirStdMaxInput.disabled = toggleDisabled || !active;
}
function updateDirectionVisual(){ if (!directionLayerGroup){ return; } directionLayerGroup.clearLayers(); }
function initializeDirectionUI(){
  if (directionAngleInput) directionAngleInput.value='0';
  if (directionToleranceInput) directionToleranceInput.value=String(DEFAULT_DIRECTION_TOLERANCE);
  if (dirStdMaxInput) dirStdMaxInput.value='25';
  if (directionToggle) directionToggle.checked=false;
  updateDirectionInputsState(); updateDirectionVisual();
}

// ---- Export GPX --------------------
exportBtn.addEventListener('click', ()=>{
  if (!points.length) return;
  const gpx=buildGPX(points,waves);
  const blob=new Blob([gpx],{type:'application/gpx+xml'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url;
  a.download=`session_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.gpx`;
  document.body.appendChild(a); a.click(); URL.revokeObjectURL(url); a.remove();
});
function buildGPX(pts, wavesArr){
  const esc=s=>String(s).replace(/[<&>]/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]));
  const trkpts=pts.map(p=>{
    const time=p.time instanceof Date && !isNaN(p.time)?p.time.toISOString():null;
    const eleTag=Number.isFinite(p.ele)?`<ele>${p.ele}</ele>`:'';
    const timeTag=time?`<time>${time}</time>`:'';
    return `<trkpt lat="${p.lat}" lon="${p.lon}">${eleTag}${timeTag}</trkpt>`;
  }).join('\n        ');
  const waveTrks = wavesArr.map((w,i)=>{
    const slice=pts.slice(w.startIdx,w.endIdx+2);
    const body=slice.map(p=>{
      const time=p.time instanceof Date && !isNaN(p.time)?p.time.toISOString():null;
      const eleTag=Number.isFinite(p.ele)?`<ele>${p.ele}</ele>`:'';
      const timeTag=time?`<time>${time}</time>`:'';
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
<gpx creator="Bodyboard Viewer v2" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><time>${new Date().toISOString()}</time></metadata>
  <trk><name>Bodyboard Session</name><trkseg>
        ${trkpts}
  </trkseg></trk>
  ${waveTrks}
</gpx>`;
}

// ---- Divers UI ---------------------
function setEnabled(loaded){
  detectBtn.disabled=!loaded; exportBtn.disabled=!loaded; fitBtn.disabled=!loaded || !mapReady; clearBtn.disabled=!loaded;
  thresholdRange.disabled=!loaded; thresholdNumber.disabled=!loaded; minDurationInput.disabled=!loaded;
  if (directionToggle){ directionToggle.disabled=!loaded; }
  if (useAdaptiveToggle) useAdaptiveToggle.disabled=!loaded;
  if (winSecondsInput) winSecondsInput.disabled=!loaded;
  if (kSigmaInput) kSigmaInput.disabled=!loaded;
  if (dropPctInput) dropPctInput.disabled=!loaded;
  if (endGraceInput) endGraceInput.disabled=!loaded;
  if (colorModeSelect) colorModeSelect.disabled=!loaded;
  updateDirectionInputsState();
}

// Events seuil
thresholdRange.addEventListener('input', ()=>{ const val=parseFloat(thresholdRange.value); const applied=setThreshold(val); updateAutoThresholdLabel(applied); runWaveDetection(); });
thresholdNumber.addEventListener('input', ()=>{ if (thresholdNumber.value==='') return; const val=parseFloat(thresholdNumber.value); if (!Number.isFinite(val)) return; const applied=setThreshold(val); updateAutoThresholdLabel(applied); runWaveDetection(); });
thresholdNumber.addEventListener('blur', ()=>{ if (thresholdNumber.value===''){ const applied=setThreshold(autoThreshold ?? 15); updateAutoThresholdLabel(applied);} });

fitBtn.addEventListener('click', ()=>{ if (!mapReady||!map||!trackBounds) return; map.fitBounds(trackBounds,{padding:[30,30]}); });
clearBtn.addEventListener('click', ()=>{
  points=[]; segments=[]; stats=null; waves=[];
  if (trackLayerGroup) trackLayerGroup.clearLayers();
  if (wavesLayerGroup) wavesLayerGroup.clearLayers();
  if (directionLayerGroup) directionLayerGroup.clearLayers();
  if (mapReady&&map) map.setView([20,0],2);
  autoThreshold=null;
  thresholdRange.min=thresholdNumber.min=String(DEFAULT_THRESHOLD_MIN);
  thresholdRange.max=String(DEFAULT_THRESHOLD_MAX);
  thresholdNumber.max=String(DEFAULT_THRESHOLD_NUMBER_MAX);
  setThreshold(15); updateAutoThresholdLabel();
  resetStatsUI(); resetWaveUI(); setEnabled(false); fileInput.value=''; initializeDirectionUI();
});

// Events détecteurs v2
[minDurationInput,useAdaptiveToggle,winSecondsInput,kSigmaInput,dropPctInput,endGraceInput,colorModeSelect].forEach(el=>{
  if (!el) return;
  el.addEventListener('change', ()=>runWaveDetection());
  el.addEventListener('input', ()=>runWaveDetection());
});

// Direction
if (directionToggle){
  directionToggle.addEventListener('change', ()=>{ if (directionToggle.disabled) return; updateDirectionInputsState(); updateDirectionVisual(); runWaveDetection(); });
}
if (directionAngleInput){
  const normalizeAngleInput = ()=>{ if (directionAngleInput.disabled) return; const settings=getDirectionSettings(); directionAngleInput.value = String(Math.round(settings.direction*10)/10); };
  directionAngleInput.addEventListener('input', ()=>{ if (directionAngleInput.disabled) return; updateDirectionVisual(); runWaveDetection(); });
  directionAngleInput.addEventListener('blur', ()=>{ if (directionAngleInput.disabled) return; if (directionAngleInput.value===''){ directionAngleInput.value='0'; } else { normalizeAngleInput(); } });
}
if (directionToleranceInput){
  const normalizeToleranceInput=()=>{ if (directionToleranceInput.disabled) return; const settings=getDirectionSettings(); directionToleranceInput.value=String(Math.round(settings.tolerance)); };
  directionToleranceInput.addEventListener('input', ()=>{ if (directionToleranceInput.disabled) return; runWaveDetection(); });
  directionToleranceInput.addEventListener('blur', ()=>{ if (directionToleranceInput.disabled) return; if (directionToleranceInput.value===''){ directionToleranceInput.value=String(DEFAULT_DIRECTION_TOLERANCE);} normalizeToleranceInput(); });
}
if (dirStdMaxInput){
  dirStdMaxInput.addEventListener('input', ()=>{ if (dirStdMaxInput.disabled) return; runWaveDetection(); });
  dirStdMaxInput.addEventListener('blur', ()=>{ if (dirStdMaxInput.disabled) return; if (dirStdMaxInput.value===''){ dirStdMaxInput.value='25'; } });
}

// ---- Cœur : runWaveDetection -------
function runWaveDetection(){
  if (!segments.length){
    waves=[]; if (wavesLayerGroup) wavesLayerGroup.clearLayers(); if (directionLayerGroup) directionLayerGroup.clearLayers();
    resetWaveUI(); updateStatsUI(); return;
  }

  const thresholdInput=parseFloat(thresholdNumber.value);
  const threshold=Number.isFinite(thresholdInput)?thresholdInput:(autoThreshold ?? 15);
  const minDur=Math.max(0, Number(minDurationInput.value) || 0);

  const useAdaptive = Boolean(useAdaptiveToggle?.checked);
  const winSec = Math.max(1, parseFloat(winSecondsInput?.value)||8);
  const kSigma = Math.max(0, parseFloat(kSigmaInput?.value)||0.8);
  const dropPct = clamp(parseFloat(dropPctInput?.value)||35, 0, 100);
  const endGraceS = Math.max(0, parseFloat(endGraceInput?.value)||1);

  const directionSettings=getDirectionSettings();

  const detected = detectWavesV2({
    baseThresholdKmh: threshold,
    minDurationS: minDur,
    useAdaptive, winSec, kSigma,
    dropPct, endGraceS,
    dirStdMaxDeg: directionSettings.stdMax
  });

  const enriched = detected.map(enrichWave);

  // Filtre de sens (optionnel)
  let filtered=enriched; let rejectedCount=0;
  if (directionSettings.enabled){
    filtered=enriched.filter(w=>{
      if (!Number.isFinite(w.directionDeg)) return false;
      const delta=angularDifference(w.directionDeg,directionSettings.direction);
      return Number.isFinite(delta) && delta<=directionSettings.tolerance;
    });
    rejectedCount=enriched.length-filtered.length;
  }

  waves=filtered;
  renderWaves(waves);
  updateWaveTable(waves,{directionSettings,rejectedCount,rawCount:enriched.length});
  updateStatsUI();
  updateAutoThresholdLabel(threshold);
  updateDirectionVisual(directionSettings);
}

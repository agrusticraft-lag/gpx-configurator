import { put } from '@vercel/blob';
import * as THREE from 'three';

const GRID = 256;
const SIZE = 6.0;
const DEM_TYPE = 'COP30';

// ─────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

function latLonDist(a, b, c, d){
  const R = 6371000;
  const r = x => x * Math.PI / 180;

  const dLa = r(c - a);
  const dLo = r(d - b);

  const x =
    Math.sin(dLa / 2) ** 2 +
    Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLo / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function parseGPXServer(txt){
  const pts = [];

  const trkptRegex = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
  let match;

  while ((match = trkptRegex.exec(txt)) !== null) {
    const attrs = match[1];
    const inside = match[2];

    const latMatch = attrs.match(/lat="([^"]+)"/);
    const lonMatch = attrs.match(/lon="([^"]+)"/);

    if(!latMatch || !lonMatch) continue;

    const lat = parseFloat(latMatch[1]);
    const lon = parseFloat(lonMatch[1]);

    const eleMatch = inside.match(/<ele[^>]*>([^<]+)<\/ele>/);
    const ele = eleMatch ? parseFloat(eleMatch[1]) : 0;

    if(Number.isFinite(lat) && Number.isFinite(lon)){
      pts.push({
        lat,
        lon,
        ele: Number.isFinite(ele) ? ele : 0
      });
    }
  }

  return pts;
}

function gpxStats(pts){
  let dist = 0;
  let dp = 0;
  let dm = 0;

  for(let i = 1; i < pts.length; i++){
    dist += latLonDist(
      pts[i - 1].lat,
      pts[i - 1].lon,
      pts[i].lat,
      pts[i].lon
    );

    const de = pts[i].ele - pts[i - 1].ele;

    if(de > 0) dp += de;
    else dm -= de;
  }

  return {
    distKm: dist / 1000,
    dPlus: Math.round(dp),
    dMinus: Math.round(dm)
  };
}

function resample(pts, n){
  if(pts.length <= n) return [...pts];

  const step = (pts.length - 1) / (n - 1);

  return Array.from({ length: n }, (_, i) => {
    return pts[Math.round(i * step)];
  });
}

function computeBBox(pts, m){
  const lats = pts.map(p => p.lat);
  const lons = pts.map(p => p.lon);

  let mnLa = Math.min(...lats);
  let mxLa = Math.max(...lats);
  let mnLo = Math.min(...lons);
  let mxLo = Math.max(...lons);

  const dLa = Math.max(1e-6, mxLa - mnLa);
  const dLo = Math.max(1e-6, mxLo - mnLo);

  const dMax = Math.max(dLa, dLo);
  const midLa = (mnLa + mxLa) / 2;
  const midLo = (mnLo + mxLo) / 2;

  return {
    minLat: midLa - dMax * (0.5 + m),
    maxLat: midLa + dMax * (0.5 + m),
    minLon: midLo - dMax * (0.5 + m),
    maxLon: midLo + dMax * (0.5 + m),
  };
}

function smoothGrid(g, passes = 2){
  const H = g.length;
  const W = g[0].length;

  let cur = g.map(r => r.slice());

  for(let p = 0; p < passes; p++){
    const nx = cur.map(r => r.slice());

    for(let y = 1; y < H - 1; y++){
      for(let x = 1; x < W - 1; x++){
        let s = 0;
        let c = 0;

        for(let oy = -1; oy <= 1; oy++){
          for(let ox = -1; ox <= 1; ox++){
            s += cur[y + oy][x + ox];
            c++;
          }
        }

        nx[y][x] = s / c;
      }
    }

    cur = nx;
  }

  return cur;
}

// ─────────────────────────────────────────────
// OpenTopography DEM
// ─────────────────────────────────────────────
async function loadHeightmapServer(bbox){
  const apiKey = process.env.OPENTOPO_API_KEY;

  if(!apiKey){
    throw new Error('Clé OpenTopography manquante côté serveur.');
  }

  const url =
    `https://portal.opentopography.org/API/globaldem` +
    `?demtype=${DEM_TYPE}` +
    `&south=${bbox.minLat}` +
    `&north=${bbox.maxLat}` +
    `&west=${bbox.minLon}` +
    `&east=${bbox.maxLon}` +
    `&outputFormat=AAIGrid` +
    `&API_Key=${apiKey}`;

  const resp = await fetch(url);

  if(!resp.ok){
    throw new Error(`OpenTopography HTTP ${resp.status}: ${await resp.text()}`);
  }

  const text = await resp.text();

  if(text.trim().startsWith('<')){
    throw new Error('OpenTopography a retourné du HTML.');
  }

  const aai = parseAAIGrid(text);
  const heightsRaw = resampleAAIGridToGrid(aai, bbox, GRID);

  let minE = Infinity;
  let maxE = -Infinity;

  for(const row of heightsRaw){
    for(const v of row){
      if(Number.isFinite(v)){
        minE = Math.min(minE, v);
        maxE = Math.max(maxE, v);
      }
    }
  }

  const range = maxE - minE || 1;

  const normalized = heightsRaw.map(row =>
    row.map(v => clamp((v - minE) / range, 0, 1))
  );

  return {
    heights: smoothGrid(normalized, 1),
    minEle: minE,
    maxEle: maxE,
    eleRange: range,
    mode: `opentopography-${DEM_TYPE.toLowerCase()}`
  };
}

function parseAAIGrid(text){
  const lines = text.trim().split(/\r?\n/);

  const header = {};
  let dataStart = 0;

  for(let i = 0; i < lines.length; i++){
    const line = lines[i].trim();
    const parts = line.split(/\s+/);
    const key = parts[0].toLowerCase();

    if([
      'ncols',
      'nrows',
      'xllcorner',
      'yllcorner',
      'xllcenter',
      'yllcenter',
      'cellsize',
      'nodata_value'
    ].includes(key)){
      header[key] = Number(parts[1]);
      dataStart = i + 1;
    } else {
      break;
    }
  }

  const ncols = header.ncols;
  const nrows = header.nrows;
  const cellsize = header.cellsize;
  const noData = header.nodata_value ?? -9999;

  const xll = header.xllcorner ?? header.xllcenter;
  const yll = header.yllcorner ?? header.yllcenter;

  if(!ncols || !nrows || !cellsize || !Number.isFinite(xll) || !Number.isFinite(yll)){
    throw new Error('AAIGrid invalide : header incomplet.');
  }

  const values = lines
    .slice(dataStart)
    .join(' ')
    .trim()
    .split(/\s+/)
    .map(Number);

  if(values.length < ncols * nrows){
    throw new Error(`AAIGrid incomplet : ${values.length} valeurs pour ${ncols * nrows} attendues.`);
  }

  const grid = [];

  for(let row = 0; row < nrows; row++){
    grid[row] = [];

    for(let col = 0; col < ncols; col++){
      const v = values[row * ncols + col];
      grid[row][col] = v === noData ? NaN : v;
    }
  }

  return {
    ncols,
    nrows,
    cellsize,
    noData,
    xll,
    yll,
    grid
  };
}

function resampleAAIGridToGrid(aai, bbox, targetSize){
  const out = [];

  const west = aai.xll;
  const south = aai.yll;
  const east = west + aai.cellsize * (aai.ncols - 1);
  const north = south + aai.cellsize * (aai.nrows - 1);

  for(let gy = 0; gy < targetSize; gy++){
    out[gy] = [];

    const lat =
      bbox.minLat +
      (bbox.maxLat - bbox.minLat) * gy / (targetSize - 1);

    for(let gx = 0; gx < targetSize; gx++){
      const lon =
        bbox.minLon +
        (bbox.maxLon - bbox.minLon) * gx / (targetSize - 1);

      const fx = (lon - west) / (east - west) * (aai.ncols - 1);

      const fyFromSouth =
        (lat - south) / (north - south) * (aai.nrows - 1);

      const fy = (aai.nrows - 1) - fyFromSouth;

      out[gy][gx] = sampleAAIGridBilinear(aai, fx, fy);
    }
  }

  return out;
}

function sampleAAIGridBilinear(aai, fx, fy){
  fx = clamp(fx, 0, aai.ncols - 1);
  fy = clamp(fy, 0, aai.nrows - 1);

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(aai.ncols - 1, x0 + 1);
  const y1 = Math.min(aai.nrows - 1, y0 + 1);

  const tx = fx - x0;
  const ty = fy - y0;

  const v00 = aai.grid[y0][x0];
  const v10 = aai.grid[y0][x1];
  const v01 = aai.grid[y1][x0];
  const v11 = aai.grid[y1][x1];

  const vals = [v00, v10, v01, v11].filter(Number.isFinite);

  if(vals.length === 0) return 0;

  const safe00 = Number.isFinite(v00) ? v00 : vals[0];
  const safe10 = Number.isFinite(v10) ? v10 : vals[0];
  const safe01 = Number.isFinite(v01) ? v01 : vals[0];
  const safe11 = Number.isFinite(v11) ? v11 : vals[0];

  return lerp(
    lerp(safe00, safe10, tx),
    lerp(safe01, safe11, tx),
    ty
  );
}

// ─────────────────────────────────────────────
// Fallback IDW
// ─────────────────────────────────────────────
function buildFallbackHeightmap(pts, bbox){
  const norm = pts.map(p => ({
    nx: (p.lon - bbox.minLon) / (bbox.maxLon - bbox.minLon || 1),
    ny: (p.lat - bbox.minLat) / (bbox.maxLat - bbox.minLat || 1),
    ele: p.ele
  }));

  const minE = Math.min(...pts.map(p => p.ele));
  const maxE = Math.max(...pts.map(p => p.ele));
  const range = Math.max(1, maxE - minE);

  const grid = Array.from({ length: GRID }, (_, gy) =>
    Array.from({ length: GRID }, (_, gx) => {
      const nx = gx / (GRID - 1);
      const ny = 1 - gy / (GRID - 1);

      let wh = 0;
      let wt = 0;

      for(const p of norm){
        const d2 = (nx - p.nx) ** 2 + (ny - p.ny) ** 2;
        const w = 1 / (d2 + 0.0002);

        wh += w * (p.ele - minE) / range;
        wt += w;
      }

      return wh / wt;
    })
  );

  return {
    heights: smoothGrid(grid, 4),
    minEle: minE,
    maxEle: maxE,
    eleRange: range,
    mode: 'fallback-idw'
  };
}

function sampleH(heightmapCache, nx, ny){
  if(!heightmapCache?.heights) return 0;

  const gxf = clamp(nx, 0, 1) * (GRID - 1);
  const gyf = clamp(ny, 0, 1) * (GRID - 1);

  const x0 = Math.floor(gxf);
  const x1 = Math.min(GRID - 1, x0 + 1);

  const y0 = Math.floor(gyf);
  const y1 = Math.min(GRID - 1, y0 + 1);

  const r0 = heightmapCache.heights[y0];
  const r1 = heightmapCache.heights[y1];

  if(!r0 || !r1) return 0;

  return lerp(
    lerp(r0[x0], r0[x1], gxf - x0),
    lerp(r1[x0], r1[x1], gxf - x0),
    gyf - y0
  );
}

function getRealScaleElevationHeight(heightmapCache, gpxBBox){
  if(!heightmapCache || !gpxBBox) return 1.8;

  const eleRangeM = heightmapCache.eleRange || 1;

  const widthM = latLonDist(
    (gpxBBox.minLat + gpxBBox.maxLat) / 2,
    gpxBBox.minLon,
    (gpxBBox.minLat + gpxBBox.maxLat) / 2,
    gpxBBox.maxLon
  );

  const heightM = latLonDist(
    gpxBBox.minLat,
    (gpxBBox.minLon + gpxBBox.maxLon) / 2,
    gpxBBox.maxLat,
    (gpxBBox.minLon + gpxBBox.maxLon) / 2
  );

  const realSizeM = Math.max(widthM, heightM);
  const worldUnitPerMeter = SIZE / realSizeM;

  return eleRangeM * worldUnitPerMeter;
}

// ─────────────────────────────────────────────
// Geometry STL
// ─────────────────────────────────────────────
function buildSolidTerrainGeometry(hm, elevH, baseY){
  const verts = [];
  const idx = [];

  for(let gy = 0; gy < GRID; gy++){
    for(let gx = 0; gx < GRID; gx++){
      const x = (gx / (GRID - 1) - 0.5) * SIZE;
      const z = (0.5 - gy / (GRID - 1)) * SIZE;
      const hNorm = hm[gy][gx];
      const y = hNorm * elevH;

      verts.push(x, y, z);
    }
  }

  const bottomOffset = GRID * GRID;

  for(let gy = 0; gy < GRID; gy++){
    for(let gx = 0; gx < GRID; gx++){
      const x = (gx / (GRID - 1) - 0.5) * SIZE;
      const z = (0.5 - gy / (GRID - 1)) * SIZE;

      verts.push(x, baseY, z);
    }
  }

  for(let gy = 0; gy < GRID - 1; gy++){
    for(let gx = 0; gx < GRID - 1; gx++){
      const a = gy * GRID + gx;
      const b = a + 1;
      const c = a + GRID;
      const d = c + 1;

      idx.push(a, b, c, b, d, c);

      const ab = bottomOffset + a;
      const bb = bottomOffset + b;
      const cb = bottomOffset + c;
      const db = bottomOffset + d;

      idx.push(ab, cb, bb, bb, cb, db);
    }
  }

  function addSide(topA, topB){
    const botA = bottomOffset + topA;
    const botB = bottomOffset + topB;

    idx.push(topA, botA, topB, topB, botA, botB);
  }

  for(let gx = 0; gx < GRID - 1; gx++){
    addSide(gx, gx + 1);
    addSide((GRID - 1) * GRID + gx + 1, (GRID - 1) * GRID + gx);
  }

  for(let gy = 0; gy < GRID - 1; gy++){
    addSide((gy + 1) * GRID, gy * GRID);
    addSide(gy * GRID + GRID - 1, (gy + 1) * GRID + GRID - 1);
  }

  const g = new THREE.BufferGeometry();

  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.normalizeNormals();
  g.computeBoundingSphere();

  return g;
}

function createRaisedPathGeometry(normalizedPath, heightmapCache, elevH, options){
  if(!normalizedPath || normalizedPath.length < 2){
    return new THREE.BufferGeometry();
  }

  const traceW = Number(options.traceW ?? 0.07);
  const traceH = Number(options.traceH ?? 0.09);

  const rawPts = normalizedPath.map(p => ({
    nx: p.nx,
    ny: p.ny,
    x: (p.nx - 0.5) * SIZE,
    z: (0.5 - p.ny) * SIZE
  }));

  const step = Math.max(1, Math.floor(rawPts.length / 500));
  const reduced = rawPts.filter((_, i) => i % step === 0);

  if(reduced[reduced.length - 1] !== rawPts[rawPts.length - 1]){
    reduced.push(rawPts[rawPts.length - 1]);
  }

  const verts = [];
  const idx = [];

  const halfW = traceW / 2;
  const samples = 7;
  const visualOffset = 0.002;

  for(let i = 0; i < reduced.length; i++){
    const p = reduced[i];

    const prev = reduced[Math.max(0, i - 1)];
    const next = reduced[Math.min(reduced.length - 1, i + 1)];

    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;

    const nxWorld = -dz / len;
    const nzWorld = dx / len;

    const nxMap = nxWorld / SIZE;
    const nyMap = -nzWorld / SIZE;

    let maxGround = -Infinity;

    for(let s = 0; s < samples; s++){
      const t = (s / (samples - 1) - 0.5) * traceW;

      const sx = p.nx + nxMap * t;
      const sy = p.ny + nyMap * t;

      const h = sampleH(heightmapCache, sx, sy) * elevH;

      if(h > maxGround) maxGround = h;
    }

    const bottom = maxGround + visualOffset;
    const top = bottom + traceH;

    verts.push(
      p.x + nxWorld * halfW, bottom, p.z + nzWorld * halfW,
      p.x - nxWorld * halfW, bottom, p.z - nzWorld * halfW,
      p.x + nxWorld * halfW, top,    p.z + nzWorld * halfW,
      p.x - nxWorld * halfW, top,    p.z - nzWorld * halfW
    );
  }

  for(let i = 0; i < reduced.length - 1; i++){
    const a = i * 4;
    const b = (i + 1) * 4;

    idx.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);
    idx.push(a + 0, a + 2, b + 0, b + 0, a + 2, b + 2);
    idx.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
    idx.push(a + 0, b + 0, a + 1, a + 1, b + 0, b + 1);
  }

  idx.push(0, 1, 2, 2, 1, 3);

  const e = (reduced.length - 1) * 4;
  idx.push(e + 0, e + 2, e + 1, e + 1, e + 2, e + 3);

  const g = new THREE.BufferGeometry();

  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();

  return g;
}

function collectTrianglesFromGeometry(geo){
  const tris = [];
  const pos = geo.attributes.position;
  const ix = geo.index;

  const mk = i => new THREE.Vector3(
    pos.getX(i),
    pos.getY(i),
    pos.getZ(i)
  );

  if(ix){
    for(let i = 0; i < ix.count; i += 3){
      tris.push([
        mk(ix.getX(i)),
        mk(ix.getX(i + 1)),
        mk(ix.getX(i + 2))
      ]);
    }
  } else {
    for(let i = 0; i < pos.count; i += 3){
      tris.push([
        mk(i),
        mk(i + 1),
        mk(i + 2)
      ]);
    }
  }

  geo.dispose();

  return tris;
}

function createSTLBlobFromTriangles(tris, filename, currentSizeMm){
  const scale = currentSizeMm / SIZE;

  const buf = new ArrayBuffer(80 + 4 + tris.length * 50);
  const dv = new DataView(buf);

  const hdr = `Relief3D — ${filename}`;

  for(let i = 0; i < 80; i++){
    dv.setUint8(i, i < hdr.length ? hdr.charCodeAt(i) : 0);
  }

  dv.setUint32(80, tris.length, true);

  let off = 84;
  const nv = new THREE.Vector3();

  for(const [a, b, c] of tris){
    nv.crossVectors(
      new THREE.Vector3().subVectors(b, a),
      new THREE.Vector3().subVectors(c, a)
    ).normalize();

    for(const v of [nv, a, b, c]){
      dv.setFloat32(off, v.x * scale, true); off += 4;
      dv.setFloat32(off, v.y * scale, true); off += 4;
      dv.setFloat32(off, v.z * scale, true); off += 4;
    }

    dv.setUint16(off, 0, true);
    off += 2;
  }

  return new Blob([buf], {
    type: 'application/octet-stream'
  });
}

// ─────────────────────────────────────────────
// Upload Vercel Blob
// ─────────────────────────────────────────────
async function uploadSTLServer(stlBlob, filename){
  const safeFilename = filename
    .replace(/\s+/g, '-')
    .replace(/[^\w.\-]/g, '')
    .toLowerCase();

  const pathname = `orders/${Date.now()}-${safeFilename}`;

  const result = await put(pathname, stlBlob, {
    access: 'public',
    contentType: 'application/octet-stream'
  });

  return result.url;
}

// ─────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    if(req.method !== 'POST'){
      return res.status(405).json({
        error: 'Méthode non autorisée'
      });
    }

    const { gpxText, filename, options } = req.body || {};

    if(!gpxText){
      return res.status(400).json({
        error: 'Aucun GPX reçu'
      });
    }

    if(!options){
      return res.status(400).json({
        error: 'Aucune option reçue'
      });
    }

    if(gpxText.length > 8_000_000){
      return res.status(413).json({
        error: 'Fichier GPX trop lourd'
      });
    }

    const pts = parseGPXServer(gpxText);

    if(pts.length < 10){
      return res.status(400).json({
        error: 'GPX invalide ou trop court'
      });
    }

    const currentSizeMm = Number(options.sizeMm || 150);
    const elevScale = Number(options.elevScale || 2);
    const baseThick = Number(options.baseThick || 0.5);
    const margin = clamp(Number(options.margin ?? 0.2), 0.05, 0.60);

    if(![150, 200].includes(currentSizeMm)){
      return res.status(400).json({
        error: 'Taille modèle non autorisée'
      });
    }

    const r500 = resample(pts, 500);
    const bbox = computeBBox(r500, margin);

    let heightmapCache;

    try {
      heightmapCache = await loadHeightmapServer(bbox);
    } catch(err) {
      console.warn('OpenTopography fallback IDW:', err.message);
      heightmapCache = buildFallbackHeightmap(r500, bbox);
    }

    const normalizedPath = r500.map(p => ({
      nx: clamp((p.lon - bbox.minLon) / (bbox.maxLon - bbox.minLon || 1), 0, 1),
      ny: clamp((p.lat - bbox.minLat) / (bbox.maxLat - bbox.minLat || 1), 0, 1)
    }));

    const elevH = getRealScaleElevationHeight(heightmapCache, bbox) * elevScale;
    const baseY = -baseThick;
    const hm = heightmapCache.heights;

    const safeName = String(options.txt1 || 'relief3d')
      .replace(/\s+/g, '-')
      .replace(/[^\w\-]/g, '')
      .toLowerCase()
      .slice(0, 80);

    const terrainFilename = `terrain-${safeName}-${currentSizeMm}mm.stl`;
    const terrainGeo = buildSolidTerrainGeometry(hm, elevH, baseY);
    const terrainTris = collectTrianglesFromGeometry(terrainGeo);
    const terrainBlob = createSTLBlobFromTriangles(
      terrainTris,
      terrainFilename,
      currentSizeMm
    );

    const terrainUrl = await uploadSTLServer(terrainBlob, terrainFilename);

    let traceUrl = '';

    if(normalizedPath && normalizedPath.length > 1){
      const traceFilename = `trace-gpx-${safeName}-${currentSizeMm}mm.stl`;

      const traceGeo = createRaisedPathGeometry(
        normalizedPath,
        heightmapCache,
        elevH,
        options
      );

      const traceTris = collectTrianglesFromGeometry(traceGeo);
      const traceBlob = createSTLBlobFromTriangles(
        traceTris,
        traceFilename,
        currentSizeMm
      );

      traceUrl = await uploadSTLServer(traceBlob, traceFilename);
    }

    const stats = gpxStats(pts);

    return res.status(200).json({
      ok: true,
      terrainUrl,
      traceUrl,
      source: heightmapCache.mode,
      minEle: heightmapCache.minEle,
      maxEle: heightmapCache.maxEle,
      distanceKm: Number(stats.distKm.toFixed(1)),
      dPlus: stats.dPlus,
      dMinus: stats.dMinus
    });

  } catch(err) {
    console.error(err);

    return res.status(500).json({
      error: err.message || 'Erreur génération STL serveur'
    });
  }
}

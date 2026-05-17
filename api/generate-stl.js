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

  const trkptRegex =
    /<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;

  let match;

  while ((match = trkptRegex.exec(txt)) !== null) {
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    const inside = match[3];

    const eleMatch = inside.match(/<ele>([^<]+)<\/ele>/);
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

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Méthode non autorisée' });
    }

    const { gpxText, filename, options } = req.body || {};

    if (!gpxText) {
      return res.status(400).json({ error: 'Aucun GPX reçu' });
    }

    if (!options) {
      return res.status(400).json({ error: 'Aucune option reçue' });
    }

    if (gpxText.length > 8_000_000) {
      return res.status(413).json({ error: 'Fichier GPX trop lourd' });
    }

    const pts = parseGPXServer(gpxText);

    if (pts.length < 10) {
      return res.status(400).json({ error: 'GPX invalide ou trop court' });
    }

    const stats = gpxStats(pts);

    return res.status(200).json({
      ok: true,
      message: 'GPX parsé côté serveur',
      filename,
      pointCount: pts.length,
      distanceKm: Number(stats.distKm.toFixed(1)),
      dPlus: stats.dPlus,
      dMinus: stats.dMinus,
      options
    });

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: err.message || 'Erreur serveur'
    });
  }
}

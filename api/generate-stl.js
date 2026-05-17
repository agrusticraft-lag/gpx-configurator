
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

    return res.status(200).json({
      ok: true,
      message: 'API generate-stl fonctionne',
      filename,
      gpxLength: gpxText.length,
      options
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Erreur serveur'
    });
  }
}

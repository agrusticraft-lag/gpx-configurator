
import { put } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);

    const filename = `relief3d-${Date.now()}.stl`;

    const blob = await put(filename, buffer, {
      access: 'public',
      contentType: 'model/stl'
    });

    return res.status(200).json({
      url: blob.url
    });

  } catch (error) {
    console.error('Erreur upload STL:', error);

    return res.status(500).json({
      error: 'Erreur upload STL'
    });
  }
}

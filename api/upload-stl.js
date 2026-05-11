import { handleUpload } from '@vercel/blob/client';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({
      error: 'BLOB_READ_WRITE_TOKEN manquant dans Vercel Environment Variables'
    });
  }

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,

      // Important : on force l’utilisation du bon token
      token: process.env.BLOB_READ_WRITE_TOKEN,

      onBeforeGenerateToken: async (pathname) => {
        return {
          allowedContentTypes: [
            'application/octet-stream',
            'application/sla',
            'model/stl'
          ],
          maximumSizeInBytes: 200 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            pathname
          })
        };
      },

      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log('STL upload terminé:', blob.url, tokenPayload);
      }
    });

    return res.status(200).json(jsonResponse);

  } catch (error) {
    console.error('Erreur handleUpload STL:', error);

    return res.status(400).json({
      error: error.message || 'Erreur upload STL'
    });
  }
}

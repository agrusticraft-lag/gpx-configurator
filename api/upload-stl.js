import { handleUpload } from '@vercel/blob/client';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;

    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        return {
          allowedContentTypes: [
            'application/octet-stream',
            'application/sla',
            'model/stl'
          ],
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
    return res.status(500).json({
      error: error.message || 'Erreur upload STL'
    });
  }
}

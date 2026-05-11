import { handleUpload } from '@vercel/blob/client';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,

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

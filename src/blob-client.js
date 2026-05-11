import { upload } from '@vercel/blob/client';

window.uploadVercelBlob = upload;
window.vercelBlobClientReady = true;

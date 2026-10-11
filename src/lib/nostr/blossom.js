// Photo upload to a Blossom media server (BUD-01/02), authorised with a
// kind 24242 event. Images are downscaled in the browser first.
import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import { bytesToHex } from '../btc/bytes.js';
import { sign } from './account.js';
import { settings } from '../settings.js';

async function shrink(file, max = 1600) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

export async function uploadImage(file) {
  const blob = await shrink(file);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = bytesToHex(sha256(bytes));
  const auth = sign({
    kind: 24242,
    content: 'Upload listing photo',
    tags: [['t', 'upload'], ['x', hash], ['expiration', String(Math.floor(Date.now() / 1000) + 600)]],
  });
  const server = settings.get().blossom.replace(/\/+$/, '');
  const r = await fetch(server + '/upload', {
    method: 'PUT',
    headers: { Authorization: 'Nostr ' + base64.encode(new TextEncoder().encode(JSON.stringify(auth))), 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  if (!r.ok) throw new Error(`Upload failed (${r.status}): ${r.headers.get('x-reason') || (await r.text()).slice(0, 200)}`);
  const desc = await r.json();
  return desc.url;
}

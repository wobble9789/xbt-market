// Notifications for saved searches. With the XBT Market service, the browser
// gets a push subscription and the service checks the relays for new listings
// every few minutes, so notifications arrive with the app closed. Without it,
// the app notifies while it is open (see SavedSearchWatcher in ui/searches.jsx).
//
// The service only gets the push address of this device and the saved
// searches that notify, not who the user is.

import { api, apiEnabled } from './api.js';
import { settings } from './settings.js';

export const pushSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const notificationsAllowed = () => typeof Notification !== 'undefined' && Notification.permission === 'granted';
export const notificationsBlocked = () => typeof Notification !== 'undefined' && Notification.permission === 'denied';

const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

// The service worker registration, or null (development has none).
async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  return navigator.serviceWorker.ready;
}

// Asks for permission (call from a tap) and subscribes this device.
export async function enableNotifications() {
  if (typeof Notification === 'undefined') throw new Error('This browser cannot show notifications');
  const p = await Notification.requestPermission();
  if (p !== 'granted') throw new Error('Notifications were not allowed');
  return true;
}

async function pushSubscription() {
  const reg = await registration();
  if (!reg?.pushManager) return null;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  const { publicKey } = await api('/api/push/key');
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(publicKey) });
}

// Tells the service which saved searches notify on this device. An empty list
// removes the device there.
export async function syncPush(searches) {
  if (!apiEnabled() || !pushSupported() || !notificationsAllowed()) return false;
  const sub = await pushSubscription();
  if (!sub) return false;
  const list = searches.filter((s) => s.notify).map((s) => ({ id: s.id, name: s.name, query: s.query, since: s.seen || s.at || 0 }));
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), searches: list, lang: settings.get().lang } });
  return true;
}

// Shows a notification now (the app is open, or in the background).
export async function showNotification(title, { body, tag, url }) {
  if (!notificationsAllowed()) return false;
  const reg = await registration().catch(() => null);
  const data = { url };
  if (reg?.showNotification) await reg.showNotification(title, { body, tag, icon: './icon-192.png', badge: './icon-192.png', data });
  else new Notification(title, { body, tag, icon: './icon-192.png', data }).onclick = () => { window.focus(); location.hash = url.replace(/^\.?\/?/, ''); };
  return true;
}

# Nearby Reminders (PWA)

A location-triggered reminder app: save a place and a message ("I left my guitar here"), set a trigger radius, and get a notification when you're back within that distance.

No backend, no build step — plain HTML/CSS/JS. Map and address search use OpenStreetMap/Leaflet and the free Nominatim geocoder.

## Files

- `index.html` — UI: reminder list, add-reminder form, map
- `style.css` — styling
- `app.js` — all logic: storage, geolocation watch, distance calc, notification trigger, address search
- `sw.js` — service worker: offline app-shell caching + shows the system notification
- `manifest.json` — PWA manifest (name, icons, standalone display)
- `icons/` — app icons

## Running it

Geolocation, notifications, and service workers all require **HTTPS** (or `localhost`) — this won't work over plain `http://` on a phone. Easiest options, all free:

- **GitHub Pages**: push this folder to a repo, enable Pages, done.
- **Netlify / Vercel**: drag-and-drop the folder in their dashboard, or `netlify deploy` / `vercel`.
- **Local test on desktop only**: `python3 -m http.server 8000` then open `http://localhost:8000` (localhost is exempt from the HTTPS requirement, but this won't let you test real movement).

Once hosted, open the URL on your phone.

### Installing

- **Android (Chrome)**: open the site, tap the menu, "Add to Home screen" / "Install app".
- **iOS (Safari)**: open the site, tap Share, "Add to Home Screen". You must do this — Safari in a regular tab has weaker notification support than an installed home-screen app.

## How the trigger logic works

While the app is open, `app.js` calls `navigator.geolocation.watchPosition()` and compares your position against every saved reminder using the haversine formula. Each reminder is "armed" until you come within its radius, at which point it fires once and disarms; it re-arms automatically once you've moved 1.5x the radius away, so revisiting the same spot later fires it again.

Notifications are shown via the service worker's `showNotification()` so they get a real title/body, vibration pattern, and appear on the lock screen like a native app notification.

## Important limitation — please read

There is currently no web API for OS-level geofencing. Native apps can register a geofence with iOS/Android and get woken up by the OS even after being fully closed, using low-power cell/Wi-Fi monitoring. Installed web apps cannot do this.

Practical effect:

- **App open (foreground) or recently backgrounded**: works well, checks continuously.
- **App closed for a while, especially on iOS**: the browser/OS may have fully suspended it, so no location checks are happening. Reopening the app re-checks your position immediately, but it won't have alerted you while it was closed.

If you need it to reliably wake up and alert you even after the app has been killed for hours or days, that requires wrapping this same code as a native app (e.g. via Capacitor) and using a native background-geolocation plugin — happy to help with that path later if this isn't enough in practice.

## Adjusting things

- Default radius: change the `value="1"` on the range input in `index.html`, or the min/max/step attributes.
- Exit re-arm buffer: `EXIT_BUFFER_MULTIPLIER` in `app.js` (currently 1.5x the radius).
- Map default view: `initMap()` in `app.js`.

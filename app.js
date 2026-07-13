// Nearby Reminders — strict PWA implementation.
//
// Everything runs client-side: reminders live in localStorage, distance
// checks run in the page against navigator.geolocation.watchPosition, and
// notifications are shown through the service worker registration so they
// look/sound/vibrate like a normal system notification.
//
// KNOWN LIMITATION (see README): this only reliably fires while the app is
// open in the foreground or a recent background tab/app-switcher entry.
// There is no web API for OS-level geofencing, so a fully closed/killed app
// will not wake up on its own — reopening it re-checks immediately.

const STORAGE_KEY = "nearby-reminders/v1";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const EXIT_BUFFER_MULTIPLIER = 1.5; // must leave 1.5x the radius before re-arming

let reminders = loadReminders();
let map, pinMarker, radiusCircle;
let selectedLatLng = null;
let watchId = null;
let swRegistration = null;

// ---------- persistence ----------

function loadReminders() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveReminders() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(reminders));
}

// ---------- geo math ----------

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- map setup ----------

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  map.on("click", (e) => setSelectedLocation(e.latlng.lat, e.latlng.lng));

  // best-effort recenter on the user's current position without
  // forcing a permission prompt on load if it's not already granted
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "geolocation" }).then((status) => {
      if (status.state === "granted") {
        navigator.geolocation.getCurrentPosition((pos) => {
          map.setView([pos.coords.latitude, pos.coords.longitude], 14);
        });
      }
    }).catch(() => {});
  }
}

function setSelectedLocation(lat, lng) {
  selectedLatLng = { lat, lng };
  const radiusKm = parseFloat(document.getElementById("radiusInput").value);

  if (!pinMarker) {
    pinMarker = L.marker([lat, lng], { draggable: true }).addTo(map);
    pinMarker.on("dragend", () => {
      const p = pinMarker.getLatLng();
      selectedLatLng = { lat: p.lat, lng: p.lng };
      radiusCircle.setLatLng(p);
    });
  } else {
    pinMarker.setLatLng([lat, lng]);
  }

  if (!radiusCircle) {
    radiusCircle = L.circle([lat, lng], {
      radius: radiusKm * 1000,
      color: "#2563eb",
      fillOpacity: 0.15
    }).addTo(map);
  } else {
    radiusCircle.setLatLng([lat, lng]);
  }

  map.setView([lat, lng], Math.max(map.getZoom(), 14));
  document.getElementById("saveBtn").disabled = !document.getElementById("messageInput").value.trim();
}

// ---------- address search (Nominatim / OpenStreetMap) ----------

async function searchAddress(query) {
  const resultsEl = document.getElementById("searchResults");
  if (!query.trim()) {
    resultsEl.classList.add("hidden");
    return;
  }
  const url = `${NOMINATIM_URL}?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await res.json();
    resultsEl.innerHTML = "";
    if (!data.length) {
      resultsEl.classList.add("hidden");
      return;
    }
    data.forEach((place) => {
      const li = document.createElement("li");
      li.textContent = place.display_name;
      li.addEventListener("click", () => {
        setSelectedLocation(parseFloat(place.lat), parseFloat(place.lon));
        document.getElementById("addressInput").value = place.display_name;
        resultsEl.classList.add("hidden");
      });
      resultsEl.appendChild(li);
    });
    resultsEl.classList.remove("hidden");
  } catch (err) {
    console.error("Address search failed", err);
  }
}

let searchDebounce;
document.getElementById("searchBtn").addEventListener("click", () => {
  searchAddress(document.getElementById("addressInput").value);
});
document.getElementById("addressInput").addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => searchAddress(e.target.value), 500);
});

// ---------- radius slider ----------

const radiusInput = document.getElementById("radiusInput");
radiusInput.addEventListener("input", () => {
  document.getElementById("radiusValue").textContent = parseFloat(radiusInput.value).toFixed(1);
  if (radiusCircle) radiusCircle.setRadius(parseFloat(radiusInput.value) * 1000);
});

document.getElementById("messageInput").addEventListener("input", (e) => {
  document.getElementById("saveBtn").disabled = !(e.target.value.trim() && selectedLatLng);
});

// ---------- save / delete reminders ----------

document.getElementById("saveBtn").addEventListener("click", () => {
  const message = document.getElementById("messageInput").value.trim();
  if (!message || !selectedLatLng) return;

  reminders.push({
    id: crypto.randomUUID(),
    message,
    lat: selectedLatLng.lat,
    lng: selectedLatLng.lng,
    radiusKm: parseFloat(radiusInput.value),
    createdAt: Date.now(),
    armed: true // true = will fire next time we're within radius
  });
  saveReminders();
  renderReminders();

  document.getElementById("messageInput").value = "";
  document.getElementById("addressInput").value = "";
  document.getElementById("saveBtn").disabled = true;
});

function deleteReminder(id) {
  reminders = reminders.filter((r) => r.id !== id);
  saveReminders();
  renderReminders();
}

// ---------- rendering ----------

function renderReminders(currentPos) {
  const list = document.getElementById("reminderList");
  const empty = document.getElementById("emptyState");
  list.querySelectorAll(".reminder-card").forEach((el) => el.remove());

  if (reminders.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  reminders
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .forEach((r) => {
      const card = document.createElement("div");
      card.className = "reminder-card";

      let distanceText = "distance unknown (location off)";
      if (currentPos) {
        const d = haversineKm(currentPos.lat, currentPos.lng, r.lat, r.lng);
        distanceText = d < 1 ? `${Math.round(d * 1000)} m away` : `${d.toFixed(2)} km away`;
      }

      card.innerHTML = `
        <div class="info">
          <p class="msg">${escapeHtml(r.message)}</p>
          <p class="meta">radius ${r.radiusKm} km</p>
          <p class="distance">${distanceText}</p>
        </div>
        <button class="remove" aria-label="Delete reminder">&times;</button>
      `;
      card.querySelector(".remove").addEventListener("click", () => deleteReminder(r.id));
      list.appendChild(card);
    });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- geolocation watch + trigger logic ----------

function setStatusPill(on) {
  const pill = document.getElementById("statusPill");
  pill.textContent = on ? "location on" : "location off";
  pill.className = on ? "pill pill-on" : "pill pill-off";
}

function handlePosition(pos) {
  const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  setStatusPill(true);

  let changed = false;
  reminders.forEach((r) => {
    const d = haversineKm(here.lat, here.lng, r.lat, r.lng);
    if (r.armed && d <= r.radiusKm) {
      // Only disarm if the notification could actually be shown.
      // Previously this disarmed unconditionally, so a silent permission
      // failure permanently "consumed" the trigger until you left the
      // zone by 1.5x the radius.
      if (fireReminder(r, d)) {
        r.armed = false;
        changed = true;
      }
    } else if (!r.armed && d > r.radiusKm * EXIT_BUFFER_MULTIPLIER) {
      // left the zone with margin — re-arm so it can trigger again next visit
      r.armed = true;
      changed = true;
    }
  });
  if (changed) saveReminders();

  renderReminders(here);
}

function handlePositionError(err) {
  console.warn("Geolocation error", err);
  setStatusPill(false);
}

function fireReminder(reminder, distanceKm) {
  const title = "You're nearby";
  const body = `${reminder.message} (${distanceKm < 1 ? Math.round(distanceKm * 1000) + " m" : distanceKm.toFixed(2) + " km"} away)`;

  // Without granted notification permission, registration.showNotification()
  // rejects (silently, inside the SW's waitUntil) and `new Notification()`
  // throws on Android. Bail out early, surface the problem, and report
  // failure so the caller keeps the reminder armed.
  if (!("Notification" in window) || Notification.permission !== "granted") {
    console.warn("Reminder triggered but notification permission is", Notification.permission);
    showPermissionBanner();
    return false;
  }

  // Prefer the registration directly — it works whether or not this page
  // is controlled yet (first load before clients.claim()).
  if (swRegistration) {
    swRegistration
      .showNotification(title, {
        body,
        tag: reminder.id,
        vibrate: [200, 100, 200, 100, 200],
        icon: "icons/icon-192.png",
        badge: "icons/icon-192.png",
        requireInteraction: true,
        data: { reminderId: reminder.id }
      })
      .catch((err) => console.error("showNotification failed", err));
    return true;
  }

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "SHOW_REMINDER_NOTIFICATION",
      payload: { title, body, tag: reminder.id, reminderId: reminder.id }
    });
    return true;
  }

  // Last resort for desktop browsers; on Android this constructor throws.
  try {
    new Notification(title, { body });
    return true;
  } catch (err) {
    console.error("Could not display notification", err);
    return false;
  }
}

function startWatching() {
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(handlePosition, handlePositionError, {
    enableHighAccuracy: true,
    maximumAge: 10000,
    timeout: 20000
  });
}

function showPermissionBanner() {
  const banner = document.getElementById("permissionBanner");
  banner.classList.remove("hidden");
  const geoMissing = !geoGranted;
  const notifMissing = !("Notification" in window) || Notification.permission !== "granted";
  const btn = document.getElementById("enableLocationBtn");
  if (notifMissing && !geoMissing) {
    btn.textContent = "Enable notifications";
  } else if (geoMissing && notifMissing) {
    btn.textContent = "Enable location & notifications";
  } else {
    btn.textContent = "Enable location";
  }
}

let geoGranted = false;

async function enablePermissions() {
  // Must be called from a user gesture so the browser will show the prompts.
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
  if ("Notification" in window && Notification.permission === "denied") {
    alert("Notifications are blocked for this app. Enable them in your browser/app settings or reminders can't alert you.");
  }
  navigator.geolocation.getCurrentPosition(
    () => {
      geoGranted = true;
      if (!("Notification" in window) || Notification.permission === "granted") {
        document.getElementById("permissionBanner").classList.add("hidden");
      }
      startWatching();
    },
    (err) => {
      console.warn("Permission denied or error", err);
      handlePositionError(err);
    },
    { enableHighAccuracy: true }
  );
}

document.getElementById("enableLocationBtn").addEventListener("click", enablePermissions);

// ---------- service worker ----------

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    swRegistration = await navigator.serviceWorker.register("sw.js");
  } catch (err) {
    console.error("Service worker registration failed", err);
  }
}

// ---------- init ----------

function init() {
  initMap();
  renderReminders();
  registerServiceWorker();

  const notifGranted = "Notification" in window && Notification.permission === "granted";

  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "geolocation" }).then((status) => {
      geoGranted = status.state === "granted";
      if (geoGranted) {
        startWatching();
      }
      // KEY FIX: even when geolocation is already granted, we still need
      // the banner if notification permission hasn't been granted yet —
      // this was the path where reminders triggered but nothing appeared.
      if (!geoGranted || !notifGranted) {
        showPermissionBanner();
      }
    }).catch(() => {
      showPermissionBanner();
    });
  } else {
    showPermissionBanner();
  }
}

init();

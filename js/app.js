const STORAGE_KEY = 'timetracker.entries.v2';
const STANDARD_DAY_HOURS = 8;

const DAY_NAMES = ['Niedziela', 'Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota'];
const DAY_NAMES_SHORT = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'Sb'];

function loadEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    const legacy = localStorage.getItem('timetracker.entries.v1');
    if (legacy) return JSON.parse(legacy);
    return [];
  } catch (e) {
    console.error('Nie udało się wczytać danych', e);
    return [];
  }
}

function saveEntries(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  if (window.onEntriesSaved) window.onEntriesSaved();
}

let entries = loadEntries();

// ---------- Settings (employment start date, etc.) ----------

const SETTINGS_KEY = 'timetracker.settings.v1';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  if (window.onEntriesSaved) window.onEntriesSaved();
}

let settings = loadSettings();

function isWeekday(dateStr) {
  const day = new Date(dateStr + 'T00:00:00').getDay();
  return day >= 1 && day <= 5;
}

function dayOfWeekName(dateStr, short) {
  const day = new Date(dateStr + 'T00:00:00').getDay();
  return short ? DAY_NAMES_SHORT[day] : DAY_NAMES[day];
}

function dateRangeDays(startStr, endStr) {
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  return Math.round((end - start) / 86400000) + 1;
}

function entryEndDate(entry) {
  return (entry.type === 'trip' || entry.type === 'leave') ? (entry.endDate || entry.date) : entry.date;
}

// Counts Mon-Fri dates in an inclusive date range.
function countWeekdaysInRange(startStr, endStr) {
  let count = 0;
  const cur = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  while (cur <= end) {
    const day = cur.getDay();
    if (day >= 1 && day <= 5) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ---------- Polish public holidays (for the monthly norm) ----------

function easterSunday(year) {
  // Meeus/Jones/Butcher Gregorian algorithm.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

const polishHolidayCache = {};

function polishHolidaysForYear(year) {
  if (polishHolidayCache[year]) return polishHolidayCache[year];
  const easter = easterSunday(year);
  const plusDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  const dates = [
    new Date(year, 0, 1),   // Nowy Rok
    new Date(year, 0, 6),   // Trzech Króli
    plusDays(easter, 1),    // Poniedziałek Wielkanocny
    new Date(year, 4, 1),   // Święto Pracy
    new Date(year, 4, 3),   // Święto Konstytucji 3 Maja
    plusDays(easter, 49),   // Zielone Świątki
    plusDays(easter, 60),   // Boże Ciało
    new Date(year, 7, 15),  // Wniebowzięcie NMP
    new Date(year, 10, 1),  // Wszystkich Świętych
    new Date(year, 10, 11), // Święto Niepodległości
    new Date(year, 11, 25), // Boże Narodzenie (1. dzień)
    new Date(year, 11, 26), // Boże Narodzenie (2. dzień)
  ];
  const set = new Set(dates.map(toIsoDate));
  polishHolidayCache[year] = set;
  return set;
}

function isPolishHoliday(dateStr) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  return polishHolidaysForYear(year).has(dateStr);
}

// Business days for the monthly norm: Mon-Fri, excluding Polish public holidays.
function countNormWeekdaysInRange(startStr, endStr) {
  let count = 0;
  const cur = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  while (cur <= end) {
    const day = cur.getDay();
    const iso = toIsoDate(cur);
    if (day >= 1 && day <= 5 && !isPolishHoliday(iso)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Hours worked between two "HH:MM" times. Crossing midnight (end <= start) is
// treated as a night shift ending the next day.
function hoursBetween(startTime, endTime, breakMinutes) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let minutes = (eh * 60 + em) - (sh * 60 + sm);
  if (minutes <= 0) minutes += 24 * 60;
  minutes -= breakMinutes || 0;
  return Math.max(0, minutes) / 60;
}

function formatTimeRange(entry) {
  let label = `${entry.startTime}–${entry.endTime}`;
  if (entry.breakMinutes) label += ` (przerwa ${entry.breakMinutes} min)`;
  return label;
}

// Returns { standard, overtime, tripDays, tripAllowance, dietaAmount } for one entry.
function computeEntry(entry) {
  if (entry.type === 'leave') {
    return { standard: 0, overtime: -entry.hours, tripDays: 0, tripAllowance: 0, dietaAmount: 0 };
  }
  if (entry.type === 'trip') {
    const days = dateRangeDays(entry.date, entryEndDate(entry));
    const allowance = days * (entry.dailyAllowance || 0);
    return { standard: 0, overtime: 0, tripDays: days, tripAllowance: allowance, dietaAmount: allowance };
  }
  const dietaAmount = entry.hasDieta ? (entry.dailyAllowance || 0) : 0;
  if (isWeekday(entry.date)) {
    const standard = Math.min(entry.hours, STANDARD_DAY_HOURS);
    const overtime = Math.max(0, entry.hours - STANDARD_DAY_HOURS);
    return { standard, overtime, tripDays: 0, tripAllowance: 0, dietaAmount };
  }
  return { standard: 0, overtime: entry.hours, tripDays: 0, tripAllowance: 0, dietaAmount };
}

// True if an entry (possibly a multi-day trip) overlaps [from, to]. Empty from/to = unbounded.
function entryOverlapsRange(entry, from, to) {
  const start = entry.date;
  const end = entryEndDate(entry);
  if (from && end < from) return false;
  if (to && start > to) return false;
  return true;
}

function summarize(list) {
  let earned = 0, used = 0, tripDays = 0, tripAllowance = 0, workedHours = 0, dietaDays = 0, dietaSum = 0;
  for (const entry of list) {
    const r = computeEntry(entry);
    if (entry.type === 'leave') {
      used += entry.hours;
    } else if (entry.type === 'trip') {
      tripDays += r.tripDays;
      tripAllowance += r.tripAllowance;
      dietaDays += r.tripDays;
      dietaSum += r.dietaAmount;
    } else {
      workedHours += entry.hours;
      if (r.overtime > 0) earned += r.overtime;
      if (entry.hasDieta) {
        dietaDays += 1;
        dietaSum += r.dietaAmount;
      }
    }
  }
  return { earned, used, balance: earned - used, tripDays, tripAllowance, workedHours, dietaDays, dietaSum };
}

function formatHours(h) {
  const sign = h < 0 ? '-' : '';
  return sign + Math.abs(h).toFixed(2) + ' h';
}

function formatMoney(v) {
  return v.toFixed(2) + ' zł';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ---------- Geolocation (GPS + free reverse geocoding, no API key) ----------

function getCurrentPosition(timeoutMs) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy });
      },
      () => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
    );
  });
}

// Uses OpenStreetMap's free Nominatim reverse geocoder (no API key required).
async function reverseGeocode(lat, lon, timeoutMs) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16`,
      { signal: controller.signal, headers: { Accept: 'application/json' } }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name || null;
  } catch (e) {
    return null;
  }
}

// Best-effort: gets GPS coords and a readable address. Never throws, never
// blocks the UI for long — returns null fields on denial/timeout/offline.
async function captureLocation() {
  const coords = await getCurrentPosition(8000);
  if (!coords) return { coords: null, address: null };
  const address = await reverseGeocode(coords.lat, coords.lon, 5000);
  return { coords, address };
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function googleMapsPointUrl(coords) {
  return `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lon}`;
}

function googleMapsRouteUrl(from, to, waypoint) {
  let url = `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lon}&destination=${to.lat},${to.lon}`;
  if (waypoint) url += `&waypoints=${waypoint.lat},${waypoint.lon}`;
  return url;
}

// ---------- Tabs ----------

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
  const tab = btn.dataset.tab;
  document.getElementById('panel-entries').style.display = tab === 'entries' ? '' : 'none';
  document.getElementById('panel-report').style.display = tab === 'report' ? '' : 'none';
  if (tab === 'report') renderReportSummary();
});

// ---------- Work clock (Start / Przerwa / Stop using the device's real clock) ----------

const CLOCK_STORAGE_KEY = 'timetracker.activeSession.v1';

function loadActiveSession() {
  try {
    const raw = localStorage.getItem(CLOCK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveActiveSession(session) {
  if (session) localStorage.setItem(CLOCK_STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(CLOCK_STORAGE_KEY);
}

let activeSession = loadActiveSession();
let clockLocationChoice = (activeSession && activeSession.location) || 'office';
let clockTickHandle = null;

const clockLocationToggle = document.getElementById('clockLocationToggle');
const clockStatusEl = document.getElementById('clockStatus');
const clockElapsedEl = document.getElementById('clockElapsed');
const clockButtonsEl = document.getElementById('clockButtons');
const clockCancelBtn = document.getElementById('clockCancelBtn');
const clockDietaToggle = document.getElementById('clockDietaToggle');
const clockDietaAmountRow = document.getElementById('clockDietaAmountRow');
const clockDailyAllowanceInput = document.getElementById('clockDailyAllowance');

let clockDietaChoice = false;

clockLocationToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.type-btn');
  if (!btn || activeSession) return;
  clockLocationChoice = btn.dataset.loc;
  clockLocationToggle.querySelectorAll('.type-btn').forEach((b) => b.classList.toggle('active', b === btn));
  clockDietaToggle.style.display = clockLocationChoice === 'trip' ? 'block' : 'none';
  if (clockLocationChoice !== 'trip') {
    clockDietaChoice = false;
    clockDietaToggle.classList.remove('active');
    clockDietaAmountRow.style.display = 'none';
  }
});

clockDietaToggle.addEventListener('click', () => {
  if (activeSession) return;
  clockDietaChoice = !clockDietaChoice;
  clockDietaToggle.classList.toggle('active', clockDietaChoice);
  clockDietaAmountRow.style.display = clockDietaChoice ? 'block' : 'none';
});

function fmtHMS(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function activeBreak(session) {
  return session.breaks.find((b) => !b.end) || null;
}

function totalBreakMs(session, now) {
  let total = 0;
  for (const b of session.breaks) {
    total += (b.end ? new Date(b.end) : now) - new Date(b.start);
  }
  return total;
}

function startClockTick() {
  if (clockTickHandle) return;
  clockTickHandle = setInterval(renderClock, 1000);
}

function stopClockTick() {
  if (clockTickHandle) { clearInterval(clockTickHandle); clockTickHandle = null; }
}

function renderClock() {
  if (!activeSession) {
    clockStatusEl.textContent = 'Nie rozpoczęto pracy';
    clockElapsedEl.style.display = 'none';
    clockCancelBtn.style.display = 'none';
    clockLocationToggle.querySelectorAll('.type-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.loc === clockLocationChoice);
      b.disabled = false;
    });
    clockDietaToggle.style.display = clockLocationChoice === 'trip' ? 'block' : 'none';
    clockDietaToggle.disabled = false;
    clockButtonsEl.innerHTML = '<button type="button" id="clockStartBtn" class="clock-btn-start">▶ Start pracy</button>';
    document.getElementById('clockStartBtn').addEventListener('click', () => clockStart(clockLocationChoice));
    stopClockTick();
    return;
  }

  clockLocationToggle.querySelectorAll('.type-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.loc === activeSession.location);
    b.disabled = true;
  });
  clockDietaToggle.style.display = activeSession.location === 'trip' ? 'block' : 'none';
  clockDietaToggle.classList.toggle('active', !!activeSession.hasDieta);
  clockDietaAmountRow.style.display = activeSession.hasDieta ? 'block' : 'none';
  clockDietaToggle.disabled = true;
  clockDailyAllowanceInput.disabled = true;
  clockCancelBtn.style.display = 'block';

  const now = new Date();
  const started = new Date(activeSession.startedAt);
  const onBreak = activeBreak(activeSession);

  if (onBreak) {
    const breakStarted = new Date(onBreak.start);
    clockStatusEl.textContent = `Przerwa od ${pad2(breakStarted.getHours())}:${pad2(breakStarted.getMinutes())}`;
    clockElapsedEl.textContent = fmtHMS(now - breakStarted);
  } else {
    const locLabel = activeSession.location === 'trip' ? 'w delegacji' : 'w firmie';
    const netMs = (now - started) - totalBreakMs(activeSession, now);
    clockStatusEl.textContent = `Pracujesz (${locLabel}) od ${pad2(started.getHours())}:${pad2(started.getMinutes())}`;
    clockElapsedEl.textContent = fmtHMS(netMs);
  }
  clockElapsedEl.style.display = 'block';

  clockButtonsEl.innerHTML = onBreak
    ? '<button type="button" id="clockResumeBtn" class="clock-btn-resume">▶ Wznów</button><button type="button" id="clockStopBtn" class="clock-btn-stop">⏹ Zakończ</button>'
    : '<button type="button" id="clockBreakBtn" class="clock-btn-break">⏸ Przerwa</button><button type="button" id="clockStopBtn" class="clock-btn-stop">⏹ Zakończ</button>';

  const resumeBtn = document.getElementById('clockResumeBtn');
  if (resumeBtn) resumeBtn.addEventListener('click', clockBreakToggle);
  const breakBtn = document.getElementById('clockBreakBtn');
  if (breakBtn) breakBtn.addEventListener('click', clockBreakToggle);
  document.getElementById('clockStopBtn').addEventListener('click', clockStop);

  startClockTick();
}

function clockStart(location) {
  if (activeSession) return;
  const now = new Date();
  const hasDieta = location === 'trip' && clockDietaChoice;
  const dailyAllowance = hasDieta ? (parseFloat(clockDailyAllowanceInput.value) || 0) : 0;
  activeSession = { startedAt: now.toISOString(), location, hasDieta, dailyAllowance, breaks: [], startCoords: null, startAddress: null };
  saveActiveSession(activeSession);
  renderClock();
  showToast(`Rozpoczęto pracę (${location === 'trip' ? 'teren' : 'firma'}) o ${pad2(now.getHours())}:${pad2(now.getMinutes())}`);
  captureLocation().then(({ coords, address }) => {
    if (!activeSession || activeSession.startedAt !== now.toISOString()) return;
    activeSession.startCoords = coords;
    activeSession.startAddress = address;
    saveActiveSession(activeSession);
  });
}

function clockBreakToggle() {
  if (!activeSession) return;
  const b = activeBreak(activeSession);
  if (b) {
    b.end = new Date().toISOString();
  } else {
    activeSession.breaks.push({ start: new Date().toISOString(), end: null });
  }
  saveActiveSession(activeSession);
  renderClock();
}

function clockStop() {
  if (!activeSession) return;
  const now = new Date();
  const b = activeBreak(activeSession);
  if (b) b.end = now.toISOString();

  const started = new Date(activeSession.startedAt);
  const breakMinutes = Math.round(totalBreakMs(activeSession, now) / 60000);
  const hours = Math.max(0, (now - started) / 3600000 - breakMinutes / 60);

  if (hours <= 0 && !confirm('Sesja trwała 0 minut po odjęciu przerw. Zapisać mimo to jako wpis 0h? (Anuluj = odrzuć sesję bez zapisu)')) {
    activeSession = null;
    saveActiveSession(null);
    renderClock();
    return;
  }

  const session = activeSession;
  const entry = {
    id: Date.now(),
    type: 'work',
    date: toIsoDate(started),
    startTime: `${pad2(started.getHours())}:${pad2(started.getMinutes())}`,
    endTime: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    breakMinutes,
    hours,
    location: session.location,
    hasDieta: !!session.hasDieta,
    dailyAllowance: session.dailyAllowance || 0,
    startCoords: session.startCoords,
    startAddress: session.startAddress,
    note: '',
  };

  activeSession = null;
  saveActiveSession(null);
  clockDietaChoice = false;
  clockDietaToggle.classList.remove('active');
  clockDietaAmountRow.style.display = 'none';
  clockDailyAllowanceInput.value = '';
  renderClock();

  entries.push(entry);
  saveEntries(entries);
  refresh();
  showToast(`Zapisano dzień pracy: ${hours.toFixed(2)} h`);

  captureLocation().then(({ coords, address }) => {
    if (!coords) return;
    entry.endCoords = coords;
    entry.endAddress = address;
    saveEntries(entries);
    refresh();
  });
}

function clockCancel() {
  if (!activeSession) return;
  if (!confirm('Na pewno anulować bieżącą sesję pracy? Zarejestrowany czas nie zostanie zapisany.')) return;
  activeSession = null;
  saveActiveSession(null);
  clockDietaChoice = false;
  clockDietaToggle.classList.remove('active');
  clockDietaAmountRow.style.display = 'none';
  clockDailyAllowanceInput.value = '';
  renderClock();
}

clockCancelBtn.addEventListener('click', clockCancel);

// ---------- Entry form ----------

const typeButtons = document.getElementById('typeButtons');
const dateLabel = document.getElementById('dateLabel');
const endDateRow = document.getElementById('endDateRow');
const workTimeRow = document.getElementById('workTimeRow');
const breakRow = document.getElementById('breakRow');
const computedHoursEl = document.getElementById('computedHours');
const hoursLeaveRow = document.getElementById('hoursLeaveRow');
const computedLeaveHoursEl = document.getElementById('computedLeaveHours');
const dietaToggle = document.getElementById('dietaToggle');
const dietaAmountRow = document.getElementById('dietaAmountRow');
const workDailyAllowanceInput = document.getElementById('workDailyAllowance');
const manualLocationRow = document.getElementById('manualLocationRow');
const startLocationTextInput = document.getElementById('startLocationText');
const destinationLocationTextInput = document.getElementById('destinationLocationText');
const endLocationTextInput = document.getElementById('endLocationText');
const startLocationGpsBtn = document.getElementById('startLocationGpsBtn');
const destinationLocationGpsBtn = document.getElementById('destinationLocationGpsBtn');
const endLocationGpsBtn = document.getElementById('endLocationGpsBtn');
const manualLocationStatus = document.getElementById('manualLocationStatus');
const travelTimeRow = document.getElementById('travelTimeRow');
const travelMinutesInput = document.getElementById('travelMinutes');
const startTimeInput = document.getElementById('startTime');
const endTimeInput = document.getElementById('endTime');
const breakMinutesInput = document.getElementById('breakMinutes');
const dateInput = document.getElementById('date');
const endDateInput = document.getElementById('endDate');
const hoursLeavePerDayInput = document.getElementById('hoursLeavePerDay');
const noteInput = document.getElementById('note');
const entryForm = document.getElementById('entryForm');
const formTitleEl = document.getElementById('formTitle');
const submitEntryBtn = document.getElementById('submitEntryBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');

let formKind = 'office'; // 'office' | 'trip' | 'leave' — mirrors the type buttons
let formDieta = false;
let manualStartCoords = null; // set only when the GPS button (not manual typing) captured a point
let manualDestinationCoords = null;
let manualEndCoords = null;
let editingId = null; // id of the entry currently being edited, or null when adding a new one
let pendingNormFillTag = false; // set right before the norm-fill button pre-fills the leave form

typeButtons.addEventListener('click', (e) => {
  const btn = e.target.closest('.type-btn');
  if (!btn) return;
  formKind = btn.dataset.type;
  pendingNormFillTag = false;
  typeButtons.querySelectorAll('.type-btn').forEach((b) => b.classList.toggle('active', b === btn));
  updateFormFields();
});

dietaToggle.addEventListener('click', () => {
  formDieta = !formDieta;
  dietaToggle.classList.toggle('active', formDieta);
  dietaAmountRow.style.display = formDieta ? 'flex' : 'none';
});

function updateFormFields() {
  const kind = formKind;
  const isWork = kind === 'office' || kind === 'trip';
  workTimeRow.style.display = isWork ? 'flex' : 'none';
  breakRow.style.display = isWork ? 'flex' : 'none';
  dietaToggle.style.display = kind === 'trip' ? 'block' : 'none';
  manualLocationRow.style.display = kind === 'trip' ? 'flex' : 'none';
  travelTimeRow.style.display = kind === 'trip' ? 'flex' : 'none';
  if (kind !== 'trip') {
    formDieta = false;
    dietaToggle.classList.remove('active');
    dietaAmountRow.style.display = 'none';
  }
  hoursLeaveRow.style.display = kind === 'leave' ? 'flex' : 'none';
  endDateRow.style.display = kind === 'leave' ? 'flex' : 'none';
  dateLabel.textContent = kind === 'leave' ? 'Data (od)' : 'Data';
  manualLocationStatus.textContent = '';
  updateComputedHoursPreview();
  updateComputedLeavePreview();
}

function updateComputedHoursPreview() {
  const isWork = formKind === 'office' || formKind === 'trip';
  if (!isWork || !startTimeInput.value || !endTimeInput.value) {
    computedHoursEl.style.display = 'none';
    return;
  }
  const breakMinutes = parseFloat(breakMinutesInput.value) || 0;
  const hours = hoursBetween(startTimeInput.value, endTimeInput.value, breakMinutes);
  computedHoursEl.textContent = `Przepracowane: ${hours.toFixed(2)} h`;
  computedHoursEl.style.display = 'block';
}

function updateComputedLeavePreview() {
  if (formKind !== 'leave' || !dateInput.value) {
    computedLeaveHoursEl.style.display = 'none';
    return;
  }
  const endDate = endDateInput.value || dateInput.value;
  if (endDate < dateInput.value) {
    computedLeaveHoursEl.style.display = 'none';
    return;
  }
  const perDay = parseFloat(hoursLeavePerDayInput.value) || 0;
  const weekdays = countWeekdaysInRange(dateInput.value, endDate);
  const total = weekdays * perDay;
  computedLeaveHoursEl.textContent = weekdays === 0
    ? 'Wybrany zakres nie zawiera dni roboczych (pon–pt).'
    : `Zostanie odjęte z banku nadgodzin: ${total.toFixed(2)} h (${weekdays} dzień/dni roboczych × ${perDay.toFixed(2)} h)`;
  computedLeaveHoursEl.style.display = 'block';
}

[startTimeInput, endTimeInput, breakMinutesInput].forEach((input) => {
  input.addEventListener('input', updateComputedHoursPreview);
});
[dateInput, endDateInput, hoursLeavePerDayInput].forEach((input) => {
  input.addEventListener('input', updateComputedLeavePreview);
});

async function useGpsForField(textInput, coordsSetter, btn) {
  const originalLabel = btn.textContent;
  btn.textContent = '…';
  btn.disabled = true;
  const result = await captureLocation();
  btn.textContent = originalLabel;
  btn.disabled = false;
  if (!result.coords) {
    manualLocationStatus.textContent = 'Nie udało się pobrać lokalizacji (brak zgody lub sygnału GPS).';
    return;
  }
  coordsSetter(result.coords);
  if (result.address) {
    textInput.value = result.address;
    manualLocationStatus.textContent = `Ustawiono: ${result.address}`;
  } else if (!navigator.onLine) {
    textInput.value = `${result.coords.lat.toFixed(5)}, ${result.coords.lon.toFixed(5)}`;
    manualLocationStatus.textContent = 'Brak internetu — zapisano współrzędne, adres uzupełni się automatycznie po powrocie zasięgu.';
  } else {
    textInput.value = `${result.coords.lat.toFixed(5)}, ${result.coords.lon.toFixed(5)}`;
    manualLocationStatus.textContent = 'Zapisano współrzędne.';
  }
}

startLocationGpsBtn.addEventListener('click', () => useGpsForField(startLocationTextInput, (c) => { manualStartCoords = c; }, startLocationGpsBtn));
destinationLocationGpsBtn.addEventListener('click', () => useGpsForField(destinationLocationTextInput, (c) => { manualDestinationCoords = c; }, destinationLocationGpsBtn));
endLocationGpsBtn.addEventListener('click', () => useGpsForField(endLocationTextInput, (c) => { manualEndCoords = c; }, endLocationGpsBtn));

// ---------- Address autocomplete (search-as-you-type via Nominatim) ----------

function debounce(fn, ms) {
  let handle;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  };
}

let autocompleteAbortController = null;

// Uses OpenStreetMap's free Nominatim forward geocoder (no API key required).
async function forwardGeocode(query) {
  try {
    if (autocompleteAbortController) autocompleteAbortController.abort();
    autocompleteAbortController = new AbortController();
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=pl&q=${encodeURIComponent(query)}`,
      { signal: autocompleteAbortController.signal, headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.map((d) => ({ label: d.display_name, lat: parseFloat(d.lat), lon: parseFloat(d.lon) }));
  } catch (e) {
    return [];
  }
}

// Typing directly (instead of using the GPS button) means we no longer have
// a matching coordinate pair for that text, so drop any stale coords; picking
// a suggestion below restores a coordinate pair.
function wireLocationAutocomplete(textInput, listEl, coordsSetter) {
  const runSearch = debounce(async () => {
    const query = textInput.value.trim();
    if (query.length < 3) { listEl.innerHTML = ''; listEl.style.display = 'none'; return; }
    const results = await forwardGeocode(query);
    if (textInput.value.trim() !== query || results.length === 0) {
      listEl.innerHTML = '';
      listEl.style.display = 'none';
      return;
    }
    listEl.innerHTML = results
      .map((r, i) => `<div class="autocomplete-item" data-i="${i}">${escapeHtml(shortAddress(r.label, 4))}</div>`)
      .join('');
    listEl.style.display = 'block';
    listEl.querySelectorAll('.autocomplete-item').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // runs before the input's blur handler hides the list
        const r = results[Number(item.dataset.i)];
        textInput.value = r.label;
        coordsSetter({ lat: r.lat, lon: r.lon });
        listEl.innerHTML = '';
        listEl.style.display = 'none';
      });
    });
  }, 450);

  textInput.addEventListener('input', () => {
    coordsSetter(null);
    runSearch();
  });
  textInput.addEventListener('focus', () => {
    if (listEl.innerHTML) listEl.style.display = 'block';
  });
  textInput.addEventListener('blur', () => {
    setTimeout(() => { listEl.style.display = 'none'; }, 150);
  });
}

wireLocationAutocomplete(startLocationTextInput, document.getElementById('startLocationAutocomplete'), (c) => { manualStartCoords = c; });
wireLocationAutocomplete(destinationLocationTextInput, document.getElementById('destinationLocationAutocomplete'), (c) => { manualDestinationCoords = c; });
wireLocationAutocomplete(endLocationTextInput, document.getElementById('endLocationAutocomplete'), (c) => { manualEndCoords = c; });

updateFormFields();

function setActiveTypeButton(kind) {
  typeButtons.querySelectorAll('.type-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === kind));
}

function resetForm() {
  entryForm.reset();
  editingId = null;
  pendingNormFillTag = false;
  formKind = 'office';
  formDieta = false;
  manualStartCoords = null;
  manualDestinationCoords = null;
  manualEndCoords = null;
  setActiveTypeButton('office');
  formTitleEl.textContent = 'Dodaj wpis ręcznie';
  submitEntryBtn.textContent = 'Dodaj wpis';
  cancelEditBtn.style.display = 'none';
  updateFormFields();
}

function startEditEntry(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  editingId = id;

  formKind = entry.type === 'leave' ? 'leave' : (entry.location === 'trip' ? 'trip' : 'office');
  setActiveTypeButton(formKind);
  updateFormFields();
  dateInput.value = entry.date;
  noteInput.value = entry.note || '';
  manualStartCoords = null;
  manualDestinationCoords = null;
  manualEndCoords = null;

  if (entry.type === 'work') {
    startTimeInput.value = entry.startTime || '';
    endTimeInput.value = entry.endTime || '';
    breakMinutesInput.value = entry.breakMinutes || '';
    formDieta = !!entry.hasDieta;
    dietaToggle.classList.toggle('active', formDieta);
    dietaAmountRow.style.display = formDieta ? 'flex' : 'none';
    workDailyAllowanceInput.value = entry.dailyAllowance || '';
    startLocationTextInput.value = entry.startAddress || '';
    destinationLocationTextInput.value = entry.destinationAddress || '';
    endLocationTextInput.value = entry.endAddress || '';
    travelMinutesInput.value = entry.travelMinutes || '';
  } else if (entry.type === 'leave') {
    endDateInput.value = entry.endDate || '';
    hoursLeavePerDayInput.value = entry.hoursPerDay || 8;
  }
  updateComputedHoursPreview();
  updateComputedLeavePreview();

  formTitleEl.textContent = 'Edytuj wpis';
  submitEntryBtn.textContent = 'Zapisz zmiany';
  cancelEditBtn.style.display = 'block';
  document.getElementById('formTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

cancelEditBtn.addEventListener('click', resetForm);

entryForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const kind = formKind;
  const type = kind === 'leave' ? 'leave' : 'work';
  const date = dateInput.value;
  const note = noteInput.value.trim();

  if (!date) return;

  const existing = editingId ? entries.find((x) => x.id === editingId) : null;
  const entry = { id: existing ? existing.id : Date.now(), type, date, note };

  if (type === 'work') {
    if (!startTimeInput.value || !endTimeInput.value) { alert('Podaj godzinę rozpoczęcia i zakończenia.'); return; }
    const breakMinutes = parseFloat(breakMinutesInput.value) || 0;
    const hours = hoursBetween(startTimeInput.value, endTimeInput.value, breakMinutes);
    if (hours <= 0) { alert('Godzina zakończenia musi być inna niż rozpoczęcia.'); return; }
    entry.startTime = startTimeInput.value;
    entry.endTime = endTimeInput.value;
    entry.breakMinutes = breakMinutes;
    entry.hours = hours;
    entry.location = kind === 'trip' ? 'trip' : 'office';

    if (kind === 'trip') {
      entry.hasDieta = formDieta;
      entry.dailyAllowance = formDieta ? (parseFloat(workDailyAllowanceInput.value) || 0) : 0;
      const travelMinutes = parseFloat(travelMinutesInput.value) || 0;
      if (travelMinutes > 0) entry.travelMinutes = travelMinutes;

      const startText = startLocationTextInput.value.trim();
      const destinationText = destinationLocationTextInput.value.trim();
      const endText = endLocationTextInput.value.trim();
      if (startText) {
        entry.startAddress = startText;
        if (manualStartCoords) entry.startCoords = manualStartCoords;
        else if (existing && existing.startAddress === startText && existing.startCoords) entry.startCoords = existing.startCoords;
      }
      if (destinationText) {
        entry.destinationAddress = destinationText;
        if (manualDestinationCoords) entry.destinationCoords = manualDestinationCoords;
        else if (existing && existing.destinationAddress === destinationText && existing.destinationCoords) entry.destinationCoords = existing.destinationCoords;
      }
      if (endText) {
        entry.endAddress = endText;
        if (manualEndCoords) entry.endCoords = manualEndCoords;
        else if (existing && existing.endAddress === endText && existing.endCoords) entry.endCoords = existing.endCoords;
      }
    } else if (existing) {
      // Firma entries don't show location controls, but preserve any GPS
      // data the entry already had (e.g. captured earlier via the clock).
      if (existing.startCoords) entry.startCoords = existing.startCoords;
      if (existing.startAddress) entry.startAddress = existing.startAddress;
      if (existing.destinationCoords) entry.destinationCoords = existing.destinationCoords;
      if (existing.destinationAddress) entry.destinationAddress = existing.destinationAddress;
      if (existing.endCoords) entry.endCoords = existing.endCoords;
      if (existing.endAddress) entry.endAddress = existing.endAddress;
    }
  } else if (type === 'leave') {
    const endDate = endDateInput.value || date;
    if (endDate < date) { alert('Data zakończenia nie może być wcześniejsza niż data rozpoczęcia.'); return; }
    const perDay = parseFloat(hoursLeavePerDayInput.value);
    if (isNaN(perDay) || perDay <= 0) { alert('Podaj poprawną liczbę godzin urlopu dziennie.'); return; }
    const weekdays = countWeekdaysInRange(date, endDate);
    if (weekdays === 0) { alert('Wybrany zakres dat nie zawiera dni roboczych.'); return; }
    entry.endDate = endDate;
    entry.hoursPerDay = perDay;
    entry.hours = weekdays * perDay;
    if (pendingNormFillTag || (existing && existing.fromNormFill)) entry.fromNormFill = true;
  }

  if (existing) {
    entries = entries.map((x) => (x.id === existing.id ? entry : x));
  } else {
    entries.push(entry);
  }
  saveEntries(entries);
  resetForm();
  refresh();
  showToast(existing ? 'Zapisano zmiany.' : 'Dodano wpis.');
});

// ---------- Entries list rendering ----------

function populateMonthFilter() {
  const select = document.getElementById('monthFilter');
  const months = Array.from(new Set(entries.map((e) => e.date.slice(0, 7)))).sort().reverse();
  const current = select.value;
  select.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'Wszystkie miesiące';
  select.appendChild(allOpt);
  for (const m of months) {
    const opt = document.createElement('option');
    opt.value = m;
    const [y, mo] = m.split('-');
    opt.textContent = `${mo}/${y}`;
    select.appendChild(opt);
  }
  select.value = months.includes(current) ? current : '';
}

function locationLinksHtml(entry) {
  const parts = [];
  if (entry.startAddress || entry.startCoords) {
    const label = entry.type === 'trip' ? 'Start' : 'Miejsce';
    const text = entry.startAddress || `${entry.startCoords.lat.toFixed(5)}, ${entry.startCoords.lon.toFixed(5)}`;
    const mapLink = entry.startCoords ? ` — <a class="location-link" href="${googleMapsPointUrl(entry.startCoords)}" target="_blank" rel="noopener">mapa</a>` : '';
    parts.push(`📍 ${label}: ${escapeHtml(text)}${mapLink}`);
  }
  if (entry.destinationAddress || entry.destinationCoords) {
    const text = entry.destinationAddress || `${entry.destinationCoords.lat.toFixed(5)}, ${entry.destinationCoords.lon.toFixed(5)}`;
    const mapLink = entry.destinationCoords ? ` — <a class="location-link" href="${googleMapsPointUrl(entry.destinationCoords)}" target="_blank" rel="noopener">mapa</a>` : '';
    parts.push(`📍 Cel: ${escapeHtml(text)}${mapLink}`);
  }
  if (entry.endAddress || entry.endCoords) {
    const text = entry.endAddress || `${entry.endCoords.lat.toFixed(5)}, ${entry.endCoords.lon.toFixed(5)}`;
    const mapLink = entry.endCoords ? ` — <a class="location-link" href="${googleMapsPointUrl(entry.endCoords)}" target="_blank" rel="noopener">mapa</a>` : '';
    parts.push(`📍 Koniec: ${escapeHtml(text)}${mapLink}`);
  }

  // Route link: prefer start→end with cel as a waypoint; fall back to
  // whichever pair of points is actually available.
  const points = [entry.startCoords, entry.destinationCoords, entry.endCoords].filter(Boolean);
  if (points.length >= 2) {
    const from = points[0];
    const to = points[points.length - 1];
    const waypoint = points.length === 3 ? points[1] : null;
    let km = haversineKm(points[0], points[1]);
    if (points[2]) km += haversineKm(points[1], points[2]);
    parts.push(`Odległość w linii prostej: ~${km.toFixed(1)} km — <a class="location-link" href="${googleMapsRouteUrl(from, to, waypoint)}" target="_blank" rel="noopener">trasa w Google Maps</a>`);
  }
  if (parts.length === 0) return '';
  return `<div class="entry-note">${parts.join('<br>')}</div>`;
}

function entryDetailHtml(entry) {
  const r = computeEntry(entry);
  if (entry.type === 'leave') {
    const range = entry.date === entryEndDate(entry)
      ? entry.date
      : `${entry.date} – ${entryEndDate(entry)}`;
    const perDayInfo = entry.hoursPerDay ? ` (${range === entry.date ? '' : `${countWeekdaysInRange(entry.date, entryEndDate(entry))} dzień/dni × `}${entry.hoursPerDay.toFixed(2)} h)` : '';
    return `${range} · wykorzystano <strong>${formatHours(entry.hours)}</strong> z banku nadgodzin${perDayInfo}`;
  }
  if (entry.type === 'trip') {
    const range = entry.date === entryEndDate(entry)
      ? entry.date
      : `${entry.date} – ${entryEndDate(entry)}`;
    let html = `${range} · ${r.tripDays} dzień/dni`;
    if (entry.dailyAllowance) {
      html += ` · dieta ${formatMoney(entry.dailyAllowance)}/dzień · suma <strong>${formatMoney(r.tripAllowance)}</strong>`;
    }
    if (entry.destination) html += `<br>Cel: ${escapeHtml(entry.destination)}`;
    return html + locationLinksHtml(entry);
  }
  const overtimeHtml = r.overtime > 0
    ? `<span class="overtime-cell">+${r.overtime.toFixed(2)} h nadgodzin</span>`
    : 'brak nadgodzin';
  const timeRange = entry.startTime && entry.endTime ? `${formatTimeRange(entry)} · ` : '';
  let html = `${timeRange}${formatHours(entry.hours)} — standard ${r.standard.toFixed(2)} h, ${overtimeHtml}`;
  if (entry.hasDieta) html += ` · <span class="dieta-cell">dieta ${formatMoney(entry.dailyAllowance || 0)}</span>`;
  if (entry.travelMinutes) html += ` · dojazd ${entry.travelMinutes} min (osobno)`;
  return html + locationLinksHtml(entry);
}

function typeBadge(type) {
  if (type === 'leave') return 'Urlop z nadgodzin';
  if (type === 'trip') return 'Delegacja';
  return 'Praca';
}

function locationBadge(entry) {
  if (entry.type !== 'work' || !entry.location) return '';
  return entry.location === 'trip'
    ? '<span class="entry-badge-location">🚗 W terenie</span>'
    : '<span class="entry-badge-location">🏢 W firmie</span>';
}

function normFillBadge(entry) {
  if (entry.type !== 'leave' || !entry.fromNormFill) return '';
  return '<span class="entry-badge-normfill">🏦 Uzupełnienie normy</span>';
}

function renderEntriesList() {
  const container = document.getElementById('entriesList');
  const emptyState = document.getElementById('emptyState');
  const monthFilter = document.getElementById('monthFilter').value;

  const filtered = entries
    .filter((e) => !monthFilter || e.date.startsWith(monthFilter))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  container.innerHTML = '';
  emptyState.style.display = filtered.length === 0 ? 'block' : 'none';

  for (const entry of filtered) {
    const card = document.createElement('div');
    card.className = `entry-card type-${entry.type}`;
    const dayName = dayOfWeekName(entry.date);
    card.innerHTML = `
      <div class="entry-card-top">
        <span class="entry-date">${entry.date} · ${dayName}</span>
        <span class="entry-card-actions">
          <button class="edit-btn" data-id="${entry.id}" title="Edytuj">✏️</button>
          <button class="delete-btn" data-id="${entry.id}" title="Usuń">✕</button>
        </span>
      </div>
      <span class="entry-badge">${typeBadge(entry.type)}</span>${locationBadge(entry)}${normFillBadge(entry)}
      <div class="entry-detail">${entryDetailHtml(entry)}</div>
      ${entry.note ? `<div class="entry-note">${escapeHtml(entry.note)}</div>` : ''}
    `;
    container.appendChild(card);
  }

  container.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => startEditEntry(Number(btn.dataset.id)));
  });

  container.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;
      const label = `${typeBadge(entry.type)} · ${entry.date}`;
      if (!confirm(`Usunąć wpis?\n${label}\n\nTej operacji nie można cofnąć.`)) return;
      entries = entries.filter((e) => e.id !== id);
      saveEntries(entries);
      if (editingId === id) resetForm();
      refresh();
    });
  });
}

function renderSummary() {
  const monthFilter = document.getElementById('monthFilter').value;
  const scoped = entries.filter((e) => !monthFilter || e.date.startsWith(monthFilter));
  const s = summarize(scoped);

  document.getElementById('sumOvertimeEarned').textContent = formatHours(s.earned);
  document.getElementById('sumOvertimeUsed').textContent = formatHours(s.used);
  document.getElementById('sumBalance').textContent = formatHours(s.balance);

  const days = Math.floor(Math.abs(s.balance) / STANDARD_DAY_HOURS);
  const rem = Math.abs(s.balance) % STANDARD_DAY_HOURS;
  const sign = s.balance < 0 ? '-' : '';
  document.getElementById('sumBalanceDays').textContent =
    `≈ ${sign}${days} dni + ${rem.toFixed(2)} h (przy ${STANDARD_DAY_HOURS}h/dzień)`;

  document.getElementById('sumTripDays').textContent = `${s.dietaDays} dni`;
  document.getElementById('sumTripAllowance').textContent = `${formatMoney(s.dietaSum)} diety`;
}

document.getElementById('monthFilter').addEventListener('change', () => {
  renderEntriesList();
  renderSummary();
  renderNormCard();
});

function refresh() {
  populateMonthFilter();
  renderEntriesList();
  renderSummary();
  renderNormCard();
}

// ---------- Settings UI ----------

const settingsToggleBtn = document.getElementById('settingsToggleBtn');
const settingsPanel = document.getElementById('settingsPanel');
const employmentStartDateInput = document.getElementById('employmentStartDate');
const settingsSavedNote = document.getElementById('settingsSavedNote');
const fullNameInput = document.getElementById('fullName');

if (settings.employmentStartDate) employmentStartDateInput.value = settings.employmentStartDate;
if (settings.fullName) fullNameInput.value = settings.fullName;

settingsToggleBtn.addEventListener('click', () => {
  const showing = settingsPanel.style.display !== 'none';
  settingsPanel.style.display = showing ? 'none' : 'flex';
});

employmentStartDateInput.addEventListener('change', () => {
  settings.employmentStartDate = employmentStartDateInput.value || null;
  saveSettings(settings);
  settingsSavedNote.textContent = settings.employmentStartDate
    ? `Zapisano. Dni przed ${formatDatePl(settings.employmentStartDate)} nie liczą się do normy.`
    : 'Zapisano (brak ograniczenia).';
  renderNormCard();
});

fullNameInput.addEventListener('change', () => {
  settings.fullName = fullNameInput.value.trim() || null;
  saveSettings(settings);
});

// ---------- Monthly norm ----------

// Caps a month's evaluation range at today when it's the current (still
// running) month, so an unfinished month never shows a false deficit for
// days that haven't happened yet. Returns null for a month entirely in the
// future.
function monthEffectiveEnd(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const naturalLast = `${monthStr}-${pad2(new Date(y, m, 0).getDate())}`;
  const todayStr = toIsoDate(new Date());
  const todayMonth = todayStr.slice(0, 7);
  if (monthStr > todayMonth) return null;
  if (monthStr === todayMonth) return todayStr < naturalLast ? todayStr : naturalLast;
  return naturalLast;
}

// Core norm math for an explicit [rangeFirst, rangeLast] calendar range.
// The norm (required hours) side is clipped to start no earlier than the
// configured employment start date and end no later than today; the
// "covered" side (actual work/leave) always uses the real calendar range.
function computeNormForRange(rangeFirst, rangeLast) {
  let normFirst = rangeFirst;
  if (settings.employmentStartDate && settings.employmentStartDate > normFirst) normFirst = settings.employmentStartDate;
  const todayStr = toIsoDate(new Date());
  const normLast = rangeLast > todayStr ? todayStr : rangeLast;

  let normDays = 0;
  if (normFirst <= normLast) normDays = countNormWeekdaysInRange(normFirst, normLast);
  const normHours = normDays * STANDARD_DAY_HOURS;

  let standardWorked = 0;
  let leaveUsedInMonth = 0;
  for (const entry of entries) {
    if (entry.type === 'work' && entry.date >= rangeFirst && entry.date <= rangeLast) {
      standardWorked += computeEntry(entry).standard;
    } else if (entry.type === 'leave') {
      const end = entryEndDate(entry);
      if (entry.date <= rangeLast && end >= rangeFirst) {
        const overlapStart = entry.date > rangeFirst ? entry.date : rangeFirst;
        const overlapEnd = end < rangeLast ? end : rangeLast;
        const weekdaysInOverlap = countWeekdaysInRange(overlapStart, overlapEnd);
        leaveUsedInMonth += weekdaysInOverlap * (entry.hoursPerDay || 0);
      }
    }
  }
  const covered = standardWorked + leaveUsedInMonth;
  return { normDays, normHours, standardWorked, leaveUsedInMonth, covered, diff: covered - normHours };
}

function computeMonthlyNorm(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const naturalFirst = `${monthStr}-01`;
  const naturalLast = `${monthStr}-${pad2(new Date(y, m, 0).getDate())}`;
  const r = computeNormForRange(naturalFirst, naturalLast);
  const startsThisMonth = !!(settings.employmentStartDate && settings.employmentStartDate.slice(0, 7) === monthStr);
  return { monthStr, ...r, startsThisMonth };
}

// All "YYYY-MM" months from startMonthStr to endMonthStr, inclusive.
function monthsBetween(startMonthStr, endMonthStr) {
  const result = [];
  let [y, m] = startMonthStr.split('-').map(Number);
  const [ey, em] = endMonthStr.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    result.push(`${y}-${pad2(m)}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return result;
}

// Every month touched by a work entry, or by a leave entry's date range
// (multi-day leave can span a month boundary). Legacy multi-day "trip"
// entries are deliberately excluded — they don't count toward the norm.
function distinctMonthsWithData() {
  const months = new Set();
  for (const entry of entries) {
    if (entry.type === 'work') {
      months.add(entry.date.slice(0, 7));
    } else if (entry.type === 'leave') {
      for (const mo of monthsBetween(entry.date.slice(0, 7), entryEndDate(entry).slice(0, 7))) months.add(mo);
    }
  }
  return Array.from(months).sort();
}

function computeAggregateNorm() {
  const months = distinctMonthsWithData();
  if (months.length === 0) return null;
  let normDays = 0, normHours = 0, standardWorked = 0, leaveUsedInMonth = 0;
  for (const mo of months) {
    const n = computeMonthlyNorm(mo);
    normDays += n.normDays;
    normHours += n.normHours;
    standardWorked += n.standardWorked;
    leaveUsedInMonth += n.leaveUsedInMonth;
  }
  const covered = standardWorked + leaveUsedInMonth;
  const firstMonth = months[0];
  return {
    months,
    firstMonth,
    lastMonth: months[months.length - 1],
    normDays, normHours, standardWorked, leaveUsedInMonth, covered,
    diff: covered - normHours,
    startsThisMonth: !!(settings.employmentStartDate && settings.employmentStartDate.slice(0, 7) === firstMonth),
  };
}

const MONTH_NAMES_PL = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];

function formatDatePl(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTH_NAMES_PL[m - 1]} ${y}`;
}

function lastWeekdayOnOrBefore(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return toIsoDate(d);
}

function lastWeekdayOfMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return lastWeekdayOnOrBefore(`${monthStr}-${pad2(new Date(y, m, 0).getDate())}`);
}

// Walks backward from endDateStr counting weekdays until weekdayCount are
// included (endDateStr itself counts as one), returning the start date.
// endDateStr must already be a weekday.
function findStartDateForWeekdayCount(endDateStr, weekdayCount) {
  const d = new Date(endDateStr + 'T00:00:00');
  let remaining = weekdayCount;
  while (remaining > 1) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() >= 1 && d.getDay() <= 5) remaining--;
  }
  return toIsoDate(d);
}

function formatMonthLabel(monthStr) {
  const [y, m] = monthStr.split('-');
  return `${m}/${y}`;
}

function renderNormCard() {
  const monthFilter = document.getElementById('monthFilter').value;
  const normCard = document.getElementById('normCard');
  const fillBtn = document.getElementById('normFillBtn');
  const titleEl = document.getElementById('normTitle');

  let n, anchorDate;
  if (monthFilter) {
    n = computeMonthlyNorm(monthFilter);
    titleEl.textContent = `Norma miesięczna — ${formatMonthLabel(monthFilter)}`;
    anchorDate = monthEffectiveEnd(monthFilter);
  } else {
    n = computeAggregateNorm();
    if (!n) { normCard.style.display = 'none'; return; }
    titleEl.textContent = n.firstMonth === n.lastMonth
      ? `Norma za cały okres — ${formatMonthLabel(n.firstMonth)}`
      : `Norma za cały okres — ${formatMonthLabel(n.firstMonth)} – ${formatMonthLabel(n.lastMonth)} (${n.months.length} mies.)`;
    anchorDate = monthEffectiveEnd(n.lastMonth);
  }
  if (anchorDate) anchorDate = lastWeekdayOnOrBefore(anchorDate);
  normCard.style.display = 'block';

  const annotationEl = document.getElementById('normAnnotation');
  if (n.startsThisMonth && settings.employmentStartDate) {
    annotationEl.textContent = `ℹ️ Praca od ${formatDatePl(settings.employmentStartDate)} — wcześniejsze dni nie liczą się do normy.`;
    annotationEl.style.display = 'block';
  } else {
    annotationEl.style.display = 'none';
  }

  document.getElementById('normHours').textContent = `${formatHours(n.normHours)}${n.normDays !== undefined ? ` (${n.normDays} dni)` : ''}`;
  document.getElementById('normWorked').textContent = formatHours(n.standardWorked);
  document.getElementById('normLeave').textContent = formatHours(n.leaveUsedInMonth);

  const progressFill = document.getElementById('normProgressFill');
  const pct = n.normHours > 0 ? Math.min(100, Math.max(0, (n.covered / n.normHours) * 100)) : (n.covered > 0 ? 100 : 0);
  progressFill.style.width = `${pct}%`;
  progressFill.className = 'norm-progress-fill' + (n.diff < -0.01 ? ' deficit' : (n.diff > 0.01 ? ' surplus' : ''));

  const statusEl = document.getElementById('normStatus');
  const overallBalance = summarize(entries).balance;

  if (Math.abs(n.diff) < 0.01) {
    statusEl.textContent = '✅ Norma dokładnie wyrobiona.';
    statusEl.className = 'norm-status ok';
    fillBtn.style.display = 'none';
  } else if (n.diff > 0) {
    statusEl.textContent = `✅ Norma wyrobiona, nadwyżka ${formatHours(n.diff)} (liczy się osobno jako nadgodziny).`;
    statusEl.className = 'norm-status surplus';
    fillBtn.style.display = 'none';
  } else {
    const deficit = -n.diff;
    statusEl.textContent = `⚠️ Brakuje ${formatHours(deficit)} do normy.`;
    statusEl.className = 'norm-status deficit';
    // The hours-per-day field has step="0.25"; a value that doesn't line up
    // with that step fails silent HTML5 validation (no error, no dialog —
    // the submit event just never fires), so round down to a safe multiple.
    const fillAmount = Math.floor(Math.min(deficit, overallBalance) * 4) / 4;
    if (fillAmount >= 0.25 && anchorDate) {
      fillBtn.style.display = 'block';
      fillBtn.textContent = `Uzupełnij ${formatHours(fillAmount)} z banku nadgodzin`;
      fillBtn.dataset.deficit = fillAmount.toFixed(2);
      fillBtn.dataset.anchor = anchorDate;
    } else {
      fillBtn.style.display = 'none';
    }
  }
}

document.getElementById('normFillBtn').addEventListener('click', () => {
  const btn = document.getElementById('normFillBtn');
  const deficit = parseFloat(btn.dataset.deficit);
  const endDate = btn.dataset.anchor;
  if (!deficit || !endDate) return;

  setActiveTypeButton('leave');
  formKind = 'leave';
  pendingNormFillTag = true;
  updateFormFields();

  // "Godziny dziennie" is capped at 24h, so a large deficit has to be spread
  // over several weekdays instead of crammed into one day's field.
  const maxPerDay = STANDARD_DAY_HOURS;
  const days = Math.max(1, Math.ceil(deficit / maxPerDay));
  const perDay = Math.floor((deficit / days) * 4) / 4; // round down to a 0.25 step, never overshoots the deficit/balance
  const startDate = findStartDateForWeekdayCount(endDate, days);

  dateInput.value = startDate;
  endDateInput.value = days > 1 ? endDate : '';
  hoursLeavePerDayInput.value = perDay.toFixed(2);
  noteInput.value = 'Uzupełnienie normy z banku nadgodzin';
  updateComputedLeavePreview();
  document.getElementById('formTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast('Sprawdź datę i zatwierdź formularz, aby uzupełnić brakujące godziny.');
});

// ---------- Report tab ----------

function pad2(n) { return String(n).padStart(2, '0'); }
function toIsoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function setDefaultReportRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  document.getElementById('reportFrom').value = toIsoDate(first);
  document.getElementById('reportTo').value = toIsoDate(last);
}

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const now = new Date();
    let from, to;
    if (chip.dataset.range === 'thisMonth') {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    } else if (chip.dataset.range === 'prevMonth') {
      from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      to = new Date(now.getFullYear(), now.getMonth(), 0);
    } else if (chip.dataset.range === 'thisYear') {
      from = new Date(now.getFullYear(), 0, 1);
      to = new Date(now.getFullYear(), 11, 31);
    }
    document.getElementById('reportFrom').value = toIsoDate(from);
    document.getElementById('reportTo').value = toIsoDate(to);
    renderReportSummary();
  });
});

function getReportRange() {
  return {
    from: document.getElementById('reportFrom').value,
    to: document.getElementById('reportTo').value,
  };
}

function entriesInRange(from, to) {
  return entries
    .filter((e) => entryOverlapsRange(e, from, to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
}

function renderReportSummary() {
  const { from, to } = getReportRange();
  const scoped = entriesInRange(from, to);
  const s = summarize(scoped);

  document.getElementById('repOvertimeEarned').textContent = formatHours(s.earned);
  document.getElementById('repOvertimeUsed').textContent = formatHours(s.used);
  document.getElementById('repBalance').textContent = formatHours(s.balance);
  document.getElementById('repTripDays').textContent = `${s.dietaDays} dni`;
  document.getElementById('repTripAllowance').textContent = `${formatMoney(s.dietaSum)} diety`;
}

document.getElementById('reportFrom').addEventListener('change', renderReportSummary);
document.getElementById('reportTo').addEventListener('change', renderReportSummary);

document.getElementById('generatePdfBtn').addEventListener('click', () => {
  const { from, to } = getReportRange();
  if (!from || !to) { alert('Wybierz zakres dat od-do.'); return; }
  if (from > to) { alert('Data "od" musi być wcześniejsza niż data "do".'); return; }
  const scoped = entriesInRange(from, to);
  generatePdfReport(scoped, from, to);
});

// ---------- Export / import JSON ----------

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'nadgodziny.json';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  const header = ['Data', 'Data do', 'Dzień tygodnia', 'Typ', 'Lokalizacja', 'Start', 'Koniec', 'Przerwa (min)', 'Godziny', 'Standard (h)', 'Nadgodziny (h)', 'Dieta (zł)', 'Notatka'];
  const rows = entries
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
    .map((entry) => {
      const r = computeEntry(entry);
      return [
        entry.date,
        entryEndDate(entry) !== entry.date ? entryEndDate(entry) : '',
        dayOfWeekName(entry.date),
        typeBadge(entry.type),
        entry.type === 'work' ? (entry.location === 'trip' ? 'Teren' : 'Firma') : '',
        entry.startTime || '',
        entry.endTime || '',
        entry.breakMinutes || '',
        entry.type === 'leave' ? '' : (entry.hours || 0).toFixed(2),
        entry.type === 'leave' ? '' : r.standard.toFixed(2),
        entry.type === 'leave' ? `-${entry.hours.toFixed(2)}` : r.overtime.toFixed(2),
        entry.hasDieta ? (entry.dailyAllowance || 0).toFixed(2) : '',
        (entry.note || '').replace(/[\r\n]+/g, ' '),
      ];
    });
  const csvLines = [header, ...rows].map((cols) =>
    cols.map((v) => {
      const s = String(v);
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(';')
  );
  // Semicolon delimiter + UTF-8 BOM: Excel with a Polish locale expects ';'
  // (comma is the decimal separator) and needs the BOM to show ą/ę/ł correctly.
  const csv = '﻿' + csvLines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'nadgodziny.csv';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('importInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) throw new Error('Nieprawidłowy format');

      if (entries.length === 0) {
        entries = imported;
      } else {
        const wantsMerge = confirm(
          `Plik zawiera ${imported.length} wpis(ów), masz już ${entries.length} w aplikacji.\n\n` +
          `OK = DODAJ nowe wpisy do istniejących (zalecane).\n` +
          `Anuluj = ZASTĄP całą bazę tym plikiem (usunie obecne dane!).`
        );
        if (wantsMerge) {
          const existingIds = new Set(entries.map((x) => x.id));
          const incoming = imported.map((x) => (existingIds.has(x.id) ? { ...x, id: Date.now() + Math.floor(Math.random() * 1000) } : x));
          entries = entries.concat(incoming);
        } else {
          if (!confirm('Na pewno zastąpić WSZYSTKIE obecne wpisy zawartością tego pliku? Tej operacji nie można cofnąć.')) {
            return;
          }
          entries = imported;
        }
      }
      saveEntries(entries);
      refresh();
      showToast(`Zaimportowano ${imported.length} wpis(ów).`);
    } catch (err) {
      alert('Nie udało się zaimportować pliku: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// Native share sheet (Bluetooth / Nearby Share / dysk / e-mail…) — works
// fully offline device-to-device via Bluetooth or Nearby Share, no server
// or FTP needed to move data from the phone to a computer. Always shown
// (rather than hidden behind feature detection, which could itself fail
// silently on some browsers) — falls back to a plain download when the
// OS share sheet isn't available.
const shareBtn = document.getElementById('shareBtn');

shareBtn.addEventListener('click', async () => {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
  const filename = `nadgodziny-${toIsoDate(new Date())}.json`;
  let shared = false;
  try {
    const file = new File([blob], filename, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Dane czasu pracy', text: 'Eksport danych z Kalkulatora nadgodzin' });
      shared = true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user closed the share sheet — do nothing
  }
  if (!shared) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Udostępnianie niedostępne w tej przeglądarce — plik pobrany zamiast tego.');
  }
});

// ---------- PWA service worker ----------

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  });
  // Reload once when a new service worker takes over, so updates (new
  // features, fixes) appear automatically instead of staying stuck on an
  // old cached version.
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedForUpdate) return;
    reloadedForUpdate = true;
    location.reload();
  });
}

// ---------- NFC / URL punch handling ----------
// A cheap NFC tag can be written (with a free app like "NFC Tools") to open
// e.g. https://your-app-url/?punch=start&loc=office — tapping the phone on
// the tag then opens the app and starts/stops the clock automatically.

function handleUrlPunch() {
  const params = new URLSearchParams(location.search);
  const punch = params.get('punch');
  if (punch) {
    const loc = params.get('loc') === 'trip' ? 'trip' : 'office';
    if (punch === 'start') {
      if (activeSession) showToast('Sesja już trwa — nie rozpoczęto nowej.');
      else { clockLocationChoice = loc; clockStart(loc); }
    } else if (punch === 'stop') {
      if (activeSession) clockStop();
      else showToast('Brak aktywnej sesji do zakończenia.');
    } else if (punch === 'break') {
      if (activeSession) clockBreakToggle();
      else showToast('Brak aktywnej sesji.');
    }
    history.replaceState(null, '', location.pathname);
  }
}

// ---------- Fill in missing addresses once back online ----------
// GPS coordinates are always saved immediately (works fully offline, since
// the phone's GPS chip needs no signal or network). Turning them into a
// readable address needs internet, so entries captured offline keep only
// raw coordinates until this runs successfully.

let geocodeRetryRunning = false;

async function retryPendingGeocoding() {
  if (geocodeRetryRunning || !navigator.onLine) return;
  const pending = entries.filter(
    (e) => (e.startCoords && !e.startAddress) || (e.endCoords && !e.endAddress)
  );
  if (pending.length === 0) return;
  geocodeRetryRunning = true;
  let changed = false;
  for (const entry of pending) {
    if (entry.startCoords && !entry.startAddress) {
      const address = await reverseGeocode(entry.startCoords.lat, entry.startCoords.lon, 5000);
      if (address) { entry.startAddress = address; changed = true; }
    }
    if (entry.endCoords && !entry.endAddress) {
      const address = await reverseGeocode(entry.endCoords.lat, entry.endCoords.lon, 5000);
      if (address) { entry.endAddress = address; changed = true; }
    }
  }
  geocodeRetryRunning = false;
  if (changed) {
    saveEntries(entries);
    refresh();
  }
}

window.addEventListener('online', retryPendingGeocoding);

// ---------- Init ----------

setDefaultReportRange();
refresh();
renderClock();
handleUrlPunch();
setTimeout(retryPendingGeocoding, 2000);

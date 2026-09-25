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
}

let entries = loadEntries();

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

function googleMapsRouteUrl(from, to) {
  return `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lon}&destination=${to.lat},${to.lon}`;
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
const endLocationTextInput = document.getElementById('endLocationText');
const startLocationGpsBtn = document.getElementById('startLocationGpsBtn');
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
let manualEndCoords = null;
let editingId = null; // id of the entry currently being edited, or null when adding a new one

typeButtons.addEventListener('click', (e) => {
  const btn = e.target.closest('.type-btn');
  if (!btn) return;
  formKind = btn.dataset.type;
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
endLocationGpsBtn.addEventListener('click', () => useGpsForField(endLocationTextInput, (c) => { manualEndCoords = c; }, endLocationGpsBtn));

// Typing directly (instead of using the GPS button) means we no longer have
// a matching coordinate pair for that text, so drop any stale coords.
startLocationTextInput.addEventListener('input', () => { manualStartCoords = null; });
endLocationTextInput.addEventListener('input', () => { manualEndCoords = null; });

updateFormFields();

function setActiveTypeButton(kind) {
  typeButtons.querySelectorAll('.type-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === kind));
}

function resetForm() {
  entryForm.reset();
  editingId = null;
  formKind = 'office';
  formDieta = false;
  manualStartCoords = null;
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
      const endText = endLocationTextInput.value.trim();
      if (startText) {
        entry.startAddress = startText;
        if (manualStartCoords) entry.startCoords = manualStartCoords;
        else if (existing && existing.startAddress === startText && existing.startCoords) entry.startCoords = existing.startCoords;
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
  if (entry.endAddress || entry.endCoords) {
    const text = entry.endAddress || `${entry.endCoords.lat.toFixed(5)}, ${entry.endCoords.lon.toFixed(5)}`;
    const mapLink = entry.endCoords ? ` — <a class="location-link" href="${googleMapsPointUrl(entry.endCoords)}" target="_blank" rel="noopener">mapa</a>` : '';
    parts.push(`📍 Koniec: ${escapeHtml(text)}${mapLink}`);
  }
  if (entry.startCoords && entry.endCoords) {
    const km = haversineKm(entry.startCoords, entry.endCoords);
    parts.push(`Odległość w linii prostej: ~${km.toFixed(1)} km — <a class="location-link" href="${googleMapsRouteUrl(entry.startCoords, entry.endCoords)}" target="_blank" rel="noopener">trasa w Google Maps</a>`);
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
      <span class="entry-badge">${typeBadge(entry.type)}</span>${locationBadge(entry)}
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
});

function refresh() {
  populateMonthFilter();
  renderEntriesList();
  renderSummary();
}

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

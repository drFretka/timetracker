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
  return entry.type === 'trip' ? (entry.endDate || entry.date) : entry.date;
}

// Returns { standard, overtime, tripDays, tripAllowance } for one entry.
function computeEntry(entry) {
  if (entry.type === 'leave') {
    return { standard: 0, overtime: -entry.hours, tripDays: 0, tripAllowance: 0 };
  }
  if (entry.type === 'trip') {
    const days = dateRangeDays(entry.date, entryEndDate(entry));
    const allowance = days * (entry.dailyAllowance || 0);
    return { standard: 0, overtime: 0, tripDays: days, tripAllowance: allowance };
  }
  if (isWeekday(entry.date)) {
    const standard = Math.min(entry.hours, STANDARD_DAY_HOURS);
    const overtime = Math.max(0, entry.hours - STANDARD_DAY_HOURS);
    return { standard, overtime, tripDays: 0, tripAllowance: 0 };
  }
  return { standard: 0, overtime: entry.hours, tripDays: 0, tripAllowance: 0 };
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
  let earned = 0, used = 0, tripDays = 0, tripAllowance = 0, workedHours = 0;
  for (const entry of list) {
    const r = computeEntry(entry);
    if (entry.type === 'leave') {
      used += entry.hours;
    } else if (entry.type === 'trip') {
      tripDays += r.tripDays;
      tripAllowance += r.tripAllowance;
    } else {
      workedHours += entry.hours;
      if (r.overtime > 0) earned += r.overtime;
    }
  }
  return { earned, used, balance: earned - used, tripDays, tripAllowance, workedHours };
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

// ---------- Entry form ----------

const typeSelect = document.getElementById('type');
const dateLabel = document.getElementById('dateLabel');
const endDateRow = document.getElementById('endDateRow');
const hoursWorkedRow = document.getElementById('hoursWorkedRow');
const hoursLeaveRow = document.getElementById('hoursLeaveRow');
const destinationRow = document.getElementById('destinationRow');
const allowanceRow = document.getElementById('allowanceRow');

function updateFormFields() {
  const type = typeSelect.value;
  hoursWorkedRow.style.display = type === 'work' ? 'flex' : 'none';
  hoursLeaveRow.style.display = type === 'leave' ? 'flex' : 'none';
  endDateRow.style.display = type === 'trip' ? 'flex' : 'none';
  destinationRow.style.display = type === 'trip' ? 'flex' : 'none';
  allowanceRow.style.display = type === 'trip' ? 'flex' : 'none';
  dateLabel.textContent = type === 'trip' ? 'Data rozpoczęcia' : 'Data';
}

typeSelect.addEventListener('change', updateFormFields);
updateFormFields();

document.getElementById('entryForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const type = typeSelect.value;
  const date = document.getElementById('date').value;
  const note = document.getElementById('note').value.trim();

  if (!date) return;

  const entry = { id: Date.now(), type, date, note };

  if (type === 'work') {
    const hours = parseFloat(document.getElementById('hoursWorked').value);
    if (isNaN(hours) || hours <= 0) { alert('Podaj poprawną liczbę godzin.'); return; }
    entry.hours = hours;
  } else if (type === 'leave') {
    const hours = parseFloat(document.getElementById('hoursLeave').value);
    if (isNaN(hours) || hours <= 0) { alert('Podaj poprawną liczbę godzin.'); return; }
    entry.hours = hours;
  } else if (type === 'trip') {
    const endDate = document.getElementById('endDate').value || date;
    if (endDate < date) { alert('Data zakończenia nie może być wcześniejsza niż data rozpoczęcia.'); return; }
    const dailyAllowance = parseFloat(document.getElementById('dailyAllowance').value) || 0;
    entry.endDate = endDate;
    entry.destination = document.getElementById('destination').value.trim();
    entry.dailyAllowance = dailyAllowance;
  }

  entries.push(entry);
  saveEntries(entries);
  e.target.reset();
  updateFormFields();
  refresh();
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

function entryDetailHtml(entry) {
  const r = computeEntry(entry);
  if (entry.type === 'leave') {
    return `Wykorzystano <strong>${formatHours(entry.hours)}</strong> z banku nadgodzin`;
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
    return html;
  }
  const overtimeHtml = r.overtime > 0
    ? `<span class="overtime-cell">+${r.overtime.toFixed(2)} h nadgodzin</span>`
    : 'brak nadgodzin';
  return `${formatHours(entry.hours)} — standard ${r.standard.toFixed(2)} h, ${overtimeHtml}`;
}

function typeBadge(type) {
  if (type === 'leave') return 'Urlop z nadgodzin';
  if (type === 'trip') return 'Delegacja';
  return 'Praca';
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
        <button class="delete-btn" data-id="${entry.id}" title="Usuń">✕</button>
      </div>
      <span class="entry-badge">${typeBadge(entry.type)}</span>
      <div class="entry-detail">${entryDetailHtml(entry)}</div>
      ${entry.note ? `<div class="entry-note">${escapeHtml(entry.note)}</div>` : ''}
    `;
    container.appendChild(card);
  }

  container.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      entries = entries.filter((e) => e.id !== id);
      saveEntries(entries);
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

  document.getElementById('sumTripDays').textContent = `${s.tripDays} dni`;
  document.getElementById('sumTripAllowance').textContent = `${formatMoney(s.tripAllowance)} diety`;
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
  document.getElementById('repTripDays').textContent = `${s.tripDays} dni`;
  document.getElementById('repTripAllowance').textContent = `${formatMoney(s.tripAllowance)} diety`;
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
      entries = imported;
      saveEntries(entries);
      refresh();
    } catch (err) {
      alert('Nie udało się zaimportować pliku: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ---------- PWA service worker ----------

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  });
}

// ---------- Init ----------

setDefaultReportRange();
refresh();

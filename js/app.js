const STORAGE_KEY = 'timetracker.entries.v1';
const STANDARD_DAY_HOURS = 8;

const DAY_NAMES = ['Niedziela', 'Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota'];

function loadEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Nie udało się wczytać danych', e);
    return [];
  }
}

function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

let entries = loadEntries();

function isWeekday(dateStr) {
  const day = new Date(dateStr + 'T00:00:00').getDay();
  return day >= 1 && day <= 5;
}

function computeEntry(entry) {
  if (entry.type === 'leave') {
    return { standard: 0, overtime: -entry.hours };
  }
  if (isWeekday(entry.date)) {
    const standard = Math.min(entry.hours, STANDARD_DAY_HOURS);
    const overtime = Math.max(0, entry.hours - STANDARD_DAY_HOURS);
    return { standard, overtime };
  }
  return { standard: 0, overtime: entry.hours };
}

function formatHours(h) {
  return h.toFixed(2) + ' h';
}

function populateMonthFilter() {
  const select = document.getElementById('monthFilter');
  const months = Array.from(new Set(entries.map(e => e.date.slice(0, 7)))).sort().reverse();
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
  if (months.includes(current) || current === '') {
    select.value = current;
  }
}

function renderTable() {
  const body = document.getElementById('entriesBody');
  const emptyState = document.getElementById('emptyState');
  const monthFilter = document.getElementById('monthFilter').value;

  const filtered = entries
    .filter(e => !monthFilter || e.date.startsWith(monthFilter))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  body.innerHTML = '';

  if (filtered.length === 0) {
    emptyState.style.display = 'block';
  } else {
    emptyState.style.display = 'none';
  }

  for (const entry of filtered) {
    const { standard, overtime } = computeEntry(entry);
    const tr = document.createElement('tr');
    if (entry.type === 'leave') tr.classList.add('leave-row');

    const dayName = DAY_NAMES[new Date(entry.date + 'T00:00:00').getDay()];

    tr.innerHTML = `
      <td>${entry.date}</td>
      <td>${dayName}</td>
      <td>${entry.type === 'leave' ? 'Urlop (nadgodziny)' : 'Praca'}</td>
      <td>${formatHours(entry.hours)}</td>
      <td>${entry.type === 'leave' ? '—' : formatHours(standard)}</td>
      <td class="overtime-cell">${overtime === 0 ? '—' : (overtime > 0 ? '+' : '') + overtime.toFixed(2) + ' h'}</td>
      <td>${entry.note ? escapeHtml(entry.note) : ''}</td>
      <td><button class="delete-btn" data-id="${entry.id}" title="Usuń">✕</button></td>
    `;
    body.appendChild(tr);
  }

  body.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      entries = entries.filter(e => e.id !== id);
      saveEntries(entries);
      populateMonthFilter();
      renderTable();
      renderSummary();
    });
  });
}

function renderSummary() {
  const monthFilter = document.getElementById('monthFilter').value;
  const scoped = entries.filter(e => !monthFilter || e.date.startsWith(monthFilter));

  let earned = 0;
  let used = 0;

  for (const entry of scoped) {
    const { overtime } = computeEntry(entry);
    if (entry.type === 'leave') {
      used += entry.hours;
    } else if (overtime > 0) {
      earned += overtime;
    }
  }

  const balance = earned - used;

  document.getElementById('sumOvertimeEarned').textContent = formatHours(earned);
  document.getElementById('sumOvertimeUsed').textContent = formatHours(used);
  document.getElementById('sumBalance').textContent = formatHours(balance);

  const days = Math.floor(Math.abs(balance) / STANDARD_DAY_HOURS);
  const rem = Math.abs(balance) % STANDARD_DAY_HOURS;
  const sign = balance < 0 ? '-' : '';
  document.getElementById('sumBalanceDays').textContent =
    `≈ ${sign}${days} dni + ${rem.toFixed(2)} h (przy ${STANDARD_DAY_HOURS}h/dzień)`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function refresh() {
  populateMonthFilter();
  renderTable();
  renderSummary();
}

document.getElementById('type').addEventListener('change', (e) => {
  const isLeave = e.target.value === 'leave';
  document.getElementById('hoursWorkedRow').style.display = isLeave ? 'none' : 'flex';
  document.getElementById('hoursLeaveRow').style.display = isLeave ? 'flex' : 'none';
});

document.getElementById('entryForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const date = document.getElementById('date').value;
  const type = document.getElementById('type').value;
  const note = document.getElementById('note').value.trim();

  if (!date) return;

  let hours;
  if (type === 'leave') {
    hours = parseFloat(document.getElementById('hoursLeave').value);
  } else {
    hours = parseFloat(document.getElementById('hoursWorked').value);
  }

  if (isNaN(hours) || hours <= 0) {
    alert('Podaj poprawną liczbę godzin.');
    return;
  }

  entries.push({
    id: Date.now(),
    date,
    type,
    hours,
    note,
  });

  saveEntries(entries);
  e.target.reset();
  document.getElementById('hoursWorkedRow').style.display = 'flex';
  document.getElementById('hoursLeaveRow').style.display = 'none';
  refresh();
});

document.getElementById('monthFilter').addEventListener('change', () => {
  renderTable();
  renderSummary();
});

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

refresh();

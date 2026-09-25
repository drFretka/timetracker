// ---------- Chmura: synchronizacja danych między urządzeniami (Firebase) ----------
// Aktywuje się dopiero po uzupełnieniu js/sync-config.js prawdziwymi danymi
// z darmowego projektu Firebase. Do tego czasu ten plik nic nie robi i
// aplikacja działa dokładnie tak jak wcześniej — wyłącznie lokalnie.

const SYNC_AVAILABLE = typeof firebase !== 'undefined'
  && typeof FIREBASE_CONFIG !== 'undefined'
  && !!FIREBASE_CONFIG.apiKey
  && FIREBASE_CONFIG.apiKey !== 'WKLEJ_TUTAJ';

const syncUnavailableNote = document.getElementById('syncUnavailableNote');
const syncLoginForm = document.getElementById('syncLoginForm');
const syncEmailInput = document.getElementById('syncEmail');
const syncPasswordInput = document.getElementById('syncPassword');
const syncLoginBtn = document.getElementById('syncLoginBtn');
const syncLogoutBtn = document.getElementById('syncLogoutBtn');
const syncStatusEl = document.getElementById('syncStatus');

if (!SYNC_AVAILABLE) {
  if (syncUnavailableNote) syncUnavailableNote.style.display = 'block';
  if (syncLoginForm) syncLoginForm.style.display = 'none';
} else {
  firebase.initializeApp(FIREBASE_CONFIG);
  const auth = firebase.auth();
  const db = firebase.firestore();

  let syncUser = null;
  let applyingRemoteSync = false;
  let syncPushTimer = null;
  let unsubscribeSnapshot = null;

  function syncDocRef(uid) {
    return db.collection('users').doc(uid).collection('sync').doc('data');
  }

  // Merges two entry arrays by id: an id only on one side is kept as-is; a
  // colliding id with identical content collapses to one copy; a colliding
  // id with different content keeps both (the incoming one gets a fresh id)
  // — the same strategy already used by the JSON import merge.
  function mergeEntryArrays(local, remote) {
    const byId = new Map(local.map((e) => [e.id, e]));
    const merged = local.slice();
    for (const r of remote) {
      const existing = byId.get(r.id);
      if (!existing) {
        merged.push(r);
      } else if (JSON.stringify(existing) !== JSON.stringify(r)) {
        merged.push({ ...r, id: Date.now() + Math.floor(Math.random() * 1000) });
      }
    }
    return merged;
  }

  function applyRemoteState(data) {
    applyingRemoteSync = true;
    entries = data.entries;
    settings = data.settings || settings;
    saveEntries(entries);
    saveSettings(settings);
    refresh();
    if (employmentStartDateInput) employmentStartDateInput.value = settings.employmentStartDate || '';
    if (fullNameInput) fullNameInput.value = settings.fullName || '';
    applyingRemoteSync = false;
  }

  async function onSyncSignedIn(user) {
    syncUser = user;
    syncStatusEl.textContent = `Zalogowano jako ${user.email}. Synchronizacja aktywna.`;
    syncLoginForm.style.display = 'none';
    syncLogoutBtn.style.display = 'block';

    const ref = syncDocRef(user.uid);
    const snap = await ref.get();
    const remote = snap.exists ? snap.data() : null;

    if (remote && Array.isArray(remote.entries) && remote.entries.length > 0) {
      applyingRemoteSync = true;
      entries = mergeEntryArrays(entries, remote.entries);
      settings = { ...remote.settings, ...settings };
      saveEntries(entries);
      saveSettings(settings);
      refresh();
      if (employmentStartDateInput && settings.employmentStartDate) employmentStartDateInput.value = settings.employmentStartDate;
      if (fullNameInput && settings.fullName) fullNameInput.value = settings.fullName;
      applyingRemoteSync = false;
    }
    // Push the reconciled state back so every device converges on the same data.
    await ref.set({ entries, settings, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

    if (unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = ref.onSnapshot((docSnap) => {
      if (docSnap.metadata.hasPendingWrites) return; // echo of our own write
      const data = docSnap.data();
      if (!data || !Array.isArray(data.entries)) return;
      if (JSON.stringify(data.entries) === JSON.stringify(entries) && JSON.stringify(data.settings || {}) === JSON.stringify(settings)) return;
      applyRemoteState(data);
      showToast('Dane zsynchronizowane z innego urządzenia.');
    });
  }

  function onSyncSignedOut() {
    syncUser = null;
    if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
    syncStatusEl.textContent = 'Niezalogowano — dane tylko na tym urządzeniu.';
    syncLoginForm.style.display = 'flex';
    syncLogoutBtn.style.display = 'none';
  }

  auth.onAuthStateChanged((user) => {
    if (user) onSyncSignedIn(user);
    else onSyncSignedOut();
  });

  syncLoginBtn.addEventListener('click', async () => {
    const email = syncEmailInput.value.trim();
    const password = syncPasswordInput.value;
    if (!email || password.length < 6) {
      syncStatusEl.textContent = 'Podaj e-mail i hasło (min. 6 znaków).';
      return;
    }
    syncLoginBtn.disabled = true;
    syncLoginBtn.textContent = '…';
    try {
      try {
        await auth.signInWithEmailAndPassword(email, password);
      } catch (err) {
        if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
          await auth.createUserWithEmailAndPassword(email, password);
          showToast('Utworzono konto synchronizacji.');
        } else {
          throw err;
        }
      }
      syncPasswordInput.value = '';
    } catch (err) {
      syncStatusEl.textContent = 'Błąd logowania: ' + (err.message || err.code || 'nieznany błąd');
    } finally {
      syncLoginBtn.disabled = false;
      syncLoginBtn.textContent = 'Zaloguj / Zarejestruj';
    }
  });

  syncLogoutBtn.addEventListener('click', () => auth.signOut());

  // Pushes local changes to the cloud shortly after they happen (debounced),
  // skipped while we're in the middle of applying a remote update ourselves
  // (saveEntries()/saveSettings() call this too, which would otherwise loop).
  window.onEntriesSaved = function () {
    if (!syncUser || applyingRemoteSync) return;
    clearTimeout(syncPushTimer);
    syncPushTimer = setTimeout(() => {
      syncDocRef(syncUser.uid).set({ entries, settings, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    }, 1500);
  };
}

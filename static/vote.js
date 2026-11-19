// SmartVote – Abstimmung (Host/Beamer)
const socket = io();

// Login abgelaufen (oder anderes Gerät abgemeldet): zurück zur Anmeldung
socket.on('auth_required', () => {
    location.href = '/login?next=' + encodeURIComponent(location.pathname);
});

const DRAFT_KEY = 'smartvote_draft';
const MAX_OPTIONS = 40;

let pollCode = null;
let current = null;        // letzter Stand vom Server
let editing = false;       // Optionen einer bestehenden Abstimmung bearbeiten
let revealTimer = null;
let awaitingEdit = false;  // Änderungen abgeschickt, warten auf Bestätigung

const $ = (id) => document.getElementById(id);
const screens = {
    setup: $('setup-screen'),
    live: $('live-screen'),
    reveal: $('reveal-screen'),
    result: $('result-screen')
};

function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
    document.body.dataset.screen = name;
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function store(key, value) {
    try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch (e) { /* privat */ }
}
function load(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}

function clearSession() {
    pollCode = null;
    current = null;
    store('voteCode', null);
    store('voteToken', null);
}

// ---------- Einrichten ----------
const optionList = $('option-list');

function addOptionRow(name = '', detail = '', focus = false) {
    if (optionList.children.length >= MAX_OPTIONS) return;
    const li = document.createElement('li');
    li.className = 'option-row';
    li.innerHTML = `
        <div class="option-fields">
            <input class="setup-input opt-name" type="text" maxlength="60" placeholder="Name, z. B. Haus 1" value="${escapeHtml(name)}" autocomplete="off">
            <input class="setup-input opt-detail" type="text" maxlength="80" placeholder="optional: gebaut von …" value="${escapeHtml(detail)}" autocomplete="off">
        </div>
        <button type="button" class="option-remove" aria-label="Option entfernen" title="Entfernen">${SQ.icon('trash')}</button>`;
    li.querySelector('.option-remove').addEventListener('click', () => {
        li.remove();
        updateOptionCount();
        saveDraft();
    });
    optionList.appendChild(li);
    updateOptionCount();
    if (focus) li.querySelector('.opt-name').focus();
}

function readForm() {
    return {
        title: $('poll-title').value.trim(),
        options: [...optionList.querySelectorAll('.option-row')].map(li => ({
            name: li.querySelector('.opt-name').value.trim(),
            detail: li.querySelector('.opt-detail').value.trim()
        }))
    };
}

function fillForm(data) {
    $('poll-title').value = data.title || '';
    optionList.innerHTML = '';
    (data.options || []).forEach(o => addOptionRow(o.name, o.detail));
    while (optionList.children.length < 2) addOptionRow();
    updateOptionCount();
}

function updateOptionCount() {
    const filled = [...optionList.querySelectorAll('.opt-name')].filter(i => i.value.trim()).length;
    $('option-count').textContent = filled;
    $('add-option').hidden = optionList.children.length >= MAX_OPTIONS;
}

function saveDraft() {
    if (editing) return;   // Entwurf nicht mit den Daten einer laufenden Abstimmung überschreiben
    store(DRAFT_KEY, JSON.stringify(readForm()));
}

function loadDraft() {
    try {
        const draft = JSON.parse(load(DRAFT_KEY) || 'null');
        if (draft && Array.isArray(draft.options)) return draft;
    } catch (e) { /* kaputter Entwurf */ }
    return {
        title: 'Das schönste Lebkuchenhaus',
        options: Array.from({ length: 6 }, (_, i) => ({ name: `Haus ${i + 1}`, detail: '' }))
    };
}

function showSetupError(msg) {
    $('setup-error').textContent = msg || '';
}

function openSetup(edit) {
    editing = !!edit;
    $('cancel-edit').hidden = !editing;
    $('create-poll').innerHTML = editing
        ? `Änderungen übernehmen${SQ.icon('check')}`
        : `QR-Code anzeigen${SQ.icon('arrow-right')}`;
    fillForm(editing && current ? current : loadDraft());
    showSetupError('');
    showScreen('setup');
}

$('add-option').addEventListener('click', () => { addOptionRow('', '', true); saveDraft(); });
optionList.addEventListener('input', () => { updateOptionCount(); saveDraft(); });
$('poll-title').addEventListener('input', saveDraft);

$('quick-fill').addEventListener('click', async () => {
    const n = Math.max(2, Math.min(MAX_OPTIONS, parseInt($('quick-count').value, 10) || 2));
    const existing = readForm().options;
    const hasCustom = existing.some((o, i) => o.detail || (o.name && o.name !== `Haus ${i + 1}`));
    if (hasCustom && !await SQ.confirm(`Liste durch „Haus 1“ bis „Haus ${n}“ ersetzen? Eingetragene Erbauer bleiben erhalten.`, 'Ersetzen')) return;
    optionList.innerHTML = '';
    for (let i = 0; i < n; i++) addOptionRow(`Haus ${i + 1}`, existing[i]?.detail || '');
    saveDraft();
});

$('setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    soundManager.init();
    const data = readForm();
    data.options = data.options.filter(o => o.name);
    if (!data.title) { showSetupError('Bitte gib der Abstimmung einen Titel.'); $('poll-title').focus(); return; }
    if (data.options.length < 2) { showSetupError('Es braucht mindestens zwei Optionen.'); return; }
    const names = data.options.map(o => o.name.toLowerCase());
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) { showSetupError(`„${data.options[names.indexOf(dup)].name}“ steht doppelt in der Liste.`); return; }
    showSetupError('');
    if (editing && pollCode) {
        awaitingEdit = true;
        socket.emit('update_poll_options', { code: pollCode, ...data });
    } else {
        store(DRAFT_KEY, JSON.stringify(data));
        socket.emit('create_poll', data);
    }
});

$('cancel-edit').addEventListener('click', () => {
    editing = false;
    if (current) render(current); else openSetup(false);
});

// ---------- Live ----------
$('edit-btn').addEventListener('click', () => openSetup(true));

$('delete-btn').addEventListener('click', async () => {
    if (!await SQ.confirm('Abstimmung wirklich beenden? Alle Anmeldungen und Stimmen gehen verloren.', 'Abstimmung beenden')) return;
    if (pollCode) socket.emit('delete_poll', { code: pollCode });
    clearSession();
    openSetup(false);
});

$('open-btn').addEventListener('click', () => {
    soundManager.init();
    socket.emit('open_poll', { code: pollCode });
});

$('close-btn').addEventListener('click', async () => {
    soundManager.init();
    if (!current) return;
    const missing = current.voters.length - current.votes_cast;
    if (current.votes_cast === 0 && !await SQ.confirm('Es hat noch niemand abgestimmt. Trotzdem beenden?', 'Trotzdem beenden')) return;
    if (current.votes_cast > 0 && missing > 0 &&
        !await SQ.confirm(`${missing} ${missing === 1 ? 'Person hat' : 'Personen haben'} noch nicht abgestimmt. Trotzdem beenden?`, 'Trotzdem beenden')) return;
    socket.emit('close_poll', { code: pollCode });
});

$('new-poll-btn').addEventListener('click', () => {
    if (pollCode) socket.emit('delete_poll', { code: pollCode });
    clearSession();
    openSetup(false);
});

function renderLive(p) {
    $('live-title').textContent = p.title;
    $('live-kicker').textContent = p.state === 'open' ? 'Jetzt abstimmen!' : 'Gleich wird abgestimmt';
    $('code-display').textContent = p.code;

    const voters = p.voters.length;
    $('votes-cast').textContent = p.votes_cast;
    $('votes-label').textContent = `von ${voters} haben abgestimmt`;
    $('votes-fill').style.width = voters ? `${Math.round(p.votes_cast / voters * 100)}%` : '0';
    $('voter-count').textContent = voters;

    $('option-chips').innerHTML = p.options.map((o, i) => `
        <span class="option-chip"><span class="num">${i + 1}</span><span>${escapeHtml(o.name)}${o.detail ? `<small>${escapeHtml(o.detail)}</small>` : ''}</span></span>`).join('');

    $('voters-grid').innerHTML = p.voters.map(v =>
        `<div class="player-chip voter-chip${v.voted ? ' voted' : ''}${v.connected ? '' : ' offline'}">${escapeHtml(v.name)}</div>`).join('');

    const isOpen = p.state === 'open';
    $('open-btn').hidden = isOpen;
    $('close-btn').hidden = !isOpen;
    $('edit-btn').hidden = isOpen;
    $('footer-hint').textContent = isOpen
        ? 'Die Stimmen bleiben bis zum Schluss geheim – du siehst nur, wer schon abgestimmt hat.'
        : 'Anmelden geht schon. Abgestimmt wird, sobald du startest.';
}

// ---------- Ergebnis ----------
function renderResult(p) {
    const r = p.results;
    const winners = r.ranking.filter(row => r.winners.includes(row.index));
    $('result-title').innerHTML = escapeHtml(p.title);
    $('result-kicker').textContent = r.total_votes === 0
        ? 'Keine Stimmen abgegeben'
        : winners.length > 1 ? `Gleichstand – ${winners.length} Sieger!` : 'Und gewonnen hat';

    $('winner-row').innerHTML = winners.map(w => `
        <div class="winner-card">
            <div class="crown">${SQ.icon('crown')}</div>
            <div class="name">${escapeHtml(w.name)}</div>
            ${w.detail ? `<div class="detail">${escapeHtml(w.detail)}</div>` : ''}
            <div class="votes">${w.votes} ${w.votes === 1 ? 'Stimme' : 'Stimmen'}</div>
        </div>`).join('');

    $('total-votes').textContent = `${r.total_votes} ${r.total_votes === 1 ? 'Stimme' : 'Stimmen'}`;
    const max = Math.max(1, ...r.ranking.map(x => x.votes));
    $('ranking').innerHTML = r.ranking.map((row, i) => {
        const pct = r.total_votes ? Math.round(row.votes / r.total_votes * 100) : 0;
        return `
        <li class="rank-row${r.winners.includes(row.index) ? ' win' : ''}" style="animation-delay:${i * 0.06}s">
            <span class="place">${row.place}.</span>
            <span class="who">${escapeHtml(row.name)}${row.detail ? `<small>${escapeHtml(row.detail)}</small>` : ''}</span>
            <span class="bar"><div data-w="${row.votes / max * 100}"></div></span>
            <span class="count">${row.votes}<small>${pct}%</small></span>
        </li>`;
    }).join('');
    requestAnimationFrame(() => requestAnimationFrame(() => {
        document.querySelectorAll('#ranking .bar div').forEach(d => { d.style.width = `${d.dataset.w}%`; });
    }));
    showScreen('result');
}

function createConfetti() {
    const box = $('confetti');
    box.innerHTML = '';
    const colors = ['#8be23c', '#5fcf3a', '#ffb547', '#4f86e8', '#ffffff', '#e5484d'];
    for (let i = 0; i < 110; i++) {
        const c = document.createElement('div');
        c.className = 'confetti';
        c.style.left = `${Math.random() * 100}%`;
        c.style.backgroundColor = colors[i % colors.length];
        c.style.animationDelay = `${Math.random() * 2}s`;
        c.style.animationDuration = `${2.2 + Math.random() * 2}s`;
        box.appendChild(c);
    }
}

// Trommelwirbel 3 – 2 – 1, dann Siegerehrung
function reveal(p) {
    clearInterval(revealTimer);
    let n = 3;
    $('reveal-number').textContent = n;
    showScreen('reveal');
    soundManager.playCountdownTick?.().catch(() => {});
    revealTimer = setInterval(() => {
        n -= 1;
        if (n > 0) {
            $('reveal-number').textContent = n;
            soundManager.playCountdownTick?.().catch(() => {});
            return;
        }
        clearInterval(revealTimer);
        renderResult(p);
        if (p.results.total_votes > 0) {
            createConfetti();
            soundManager.playCelebrationSound?.().catch(() => {});
        }
    }, 1000);
}

// ---------- Server ----------
function render(p) {
    const previous = current?.state;
    current = p;
    if (p.state === 'closed') {
        // Nur beim echten Beenden mit Trommelwirbel, nach Neuladen direkt das Ergebnis
        if (previous === 'open') reveal(p);
        else if (!screens.reveal.classList.contains('active')) renderResult(p);
        return;
    }
    if (editing) return;    // Formular nicht unter den Fingern wegziehen
    renderLive(p);
    if (!screens.live.classList.contains('active')) showScreen('live');
}

socket.on('poll_created', (data) => {
    pollCode = data.code;
    store('voteCode', data.code);
    store('voteToken', data.host_token);
    editing = false;
    const url = `${location.origin}/?code=${data.code}`;
    $('join-url').textContent = url.replace(/^https?:\/\//, '');
    $('qr-code').src = `/api/qrcode?code=${encodeURIComponent(data.code)}`;
});

socket.on('poll_host_update', (data) => {
    if (!pollCode || data.code !== pollCode) {
        pollCode = data.code;
        $('join-url').textContent = `${location.host}/?code=${data.code}`;
        $('qr-code').src = `/api/qrcode?code=${encodeURIComponent(data.code)}`;
    }
    if (awaitingEdit) {
        awaitingEdit = false;
        editing = false;
        $('cancel-edit').hidden = true;
    }
    render(data);
});

socket.on('poll_error', (data) => {
    awaitingEdit = false;
    if (screens.setup.classList.contains('active')) showSetupError(data.message);
    else alert(data.message);
});

socket.on('poll_reconnect_failed', () => {
    clearSession();
    openSetup(false);
});

function resume() {
    const code = load('voteCode');
    const token = load('voteToken');
    if (code && token) socket.emit('reconnect_poll_host', { code, token });
}

let connectedOnce = false;
socket.on('connect', () => {
    // Auch nach Netzabbruch/Standby wieder als Host anmelden
    if (connectedOnce || load('voteCode')) resume();
    connectedOnce = true;
});

openSetup(false);

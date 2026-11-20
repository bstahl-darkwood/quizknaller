// SmartVote – Abstimmung (Host/Beamer)
const socket = io();

// Login abgelaufen (oder anderes Gerät abgemeldet): zurück zur Anmeldung
socket.on('auth_required', () => {
    location.href = '/login?next=' + encodeURIComponent(location.pathname);
});

const DRAFT_KEY = 'smartvote_drafts';
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

// ---------- Vorlagen ----------
// Reihenfolge = Reihenfolge der Karten. "rating": jede Person vergibt je Eintrag und Kriterium 1–4 Punkte.
const SCALE_4 = { low: 'schlecht', high: 'super gut' };
const TEMPLATES = [
    {
        id: 'rueckblick', icon: 'clapperboard', label: 'Jahresrückblick', kind: 'rating',
        title: 'Jahresrückblick', entryWord: 'Gruppe', entries: 4,
        scaleHint: '4 = super gut, 1 = schlecht. Dazu eine Freitext-Frage je Gruppe.',
        criteria: [
            { emoji: '🎯', name: 'Inhalt', question: 'Wie klar wurde, was das Produkt dieses Jahr erreicht, bewegt oder gelernt hat?', ...SCALE_4 },
            { emoji: '💡', name: 'Relevanz', question: 'Was hat das Ergebnis für eine Bedeutung für Smart Solutions?', ...SCALE_4 },
            { emoji: '🎨', name: 'Kreative Umsetzung', question: 'Wie gelungen wurde der Rückblick ohne klassische Präsentation umgesetzt?', ...SCALE_4 },
            { emoji: '🧠', name: 'Bleibt hängen', question: 'Wie gut könnt ihr euch später noch an die Kernbotschaft erinnern?', ...SCALE_4 }
        ],
        texts: [{ question: 'Was ist die Kernbotschaft?', per_entry: true }]
    },
    {
        id: 'fruehstueck', icon: 'cup', label: 'Frühstück', kind: 'rating',
        title: 'Frühstück', entryWord: 'Tisch', entries: 0,
        scaleHint: '4 = trifft voll zu, 1 = gar nicht. Bewertet wird das Frühstück als Ganzes.',
        criteria: [
            { emoji: '🥨', name: 'Wie herzhaft wir unterwegs sind', low: 'gar nicht', high: 'voll' },
            { emoji: '🍰', name: 'Wie süß wir unterwegs sind', low: 'gar nicht', high: 'voll' },
            { emoji: '🥑', name: 'Wie gesund wir tatsächlich sind', low: 'gar nicht', high: 'voll' },
            { emoji: '🌍', name: 'Wie international/unterschiedlich unser Frühstück ist', low: 'gar nicht', high: 'voll' },
            { emoji: '😄', name: 'Dass ich manche Kollegen offenbar völlig falsch eingeschätzt habe', low: 'gar nicht', high: 'voll' }
        ],
        texts: []
    },
    {
        id: 'geschenke', icon: 'gift', label: 'Geschenke', kind: 'rating',
        title: 'Geschenke', entryWord: 'Gruppe', entries: 4,
        scaleHint: 'Je Kriterium bis zu 4 Punkte.',
        criteria: [
            { emoji: '🎯', name: 'Zielgruppenverständnis', low: 'schwach', high: 'top' },
            { emoji: '💬', name: 'Klarheit der Botschaft', low: 'schwach', high: 'top' },
            { emoji: '🎨', name: 'Kreativität', low: 'schwach', high: 'top' },
            { emoji: '💡', name: 'Smart-Solutions-Bezug', low: 'schwach', high: 'top' },
            { emoji: '🎁', name: 'Umsetzung und Präsentation', low: 'schwach', high: 'top' }
        ],
        texts: []
    },
    {
        id: 'fotosession', icon: 'camera', label: 'Fotosession', kind: 'rating',
        title: 'Fotosession', entryWord: 'Gruppe', entries: 4,
        scaleHint: 'Je Kriterium 1–4 Punkte. Am Ende eine Freitext-Frage.',
        criteria: [
            { emoji: '💡', name: 'Idee', low: 'schon mal gesehen', high: 'darauf muss man erstmal kommen' },
            { emoji: '👀', name: 'Erkennbarkeit', low: 'Was soll das sein?', high: 'sofort erkannt!' },
            { emoji: '🤝', name: 'Teamwork', low: 'Einzelkämpfer', high: 'perfekte Formation' },
            { emoji: '🎨', name: 'Kreativität', low: 'solide', high: 'richtig clever' },
            { emoji: '🤩', name: 'Wow-Faktor', low: 'nett', high: 'das gehört eingerahmt' }
        ],
        texts: [{ question: 'Welches Bild gehört auf unsere Smart-Solutions-Weihnachtskarte 2026?', per_entry: false }]
    },
    {
        id: 'lebkuchen', icon: 'house', label: 'Lebkuchenhaus', kind: 'choice',
        title: 'Das schönste Lebkuchenhaus', entryWord: 'Haus', entries: 6,
        scaleHint: ''
    }
];

// ---------- Einrichten ----------
const optionList = $('option-list');
let template = TEMPLATES[0];
let editDefinition = null;  // beim Bearbeiten: Kriterien/Freitexte der laufenden Bewertung

function templateById(id) {
    return TEMPLATES.find(t => t.id === id) || null;
}

function isRating() {
    return template.kind === 'rating';
}

function addOptionRow(name = '', detail = '', focus = false) {
    if (optionList.children.length >= MAX_OPTIONS) return;
    const li = document.createElement('li');
    li.className = 'option-row';
    const word = template.entryWord;
    li.innerHTML = `
        <div class="option-fields">
            <input class="setup-input opt-name" type="text" maxlength="60" placeholder="Name, z. B. ${escapeHtml(word)} 1" value="${escapeHtml(name)}" autocomplete="off">
            <input class="setup-input opt-detail" type="text" maxlength="80" placeholder="${isRating() ? 'optional: wer dabei ist, Thema …' : 'optional: gebaut von …'}" value="${escapeHtml(detail)}" autocomplete="off">
        </div>
        <button type="button" class="option-remove" aria-label="Eintrag entfernen" title="Entfernen">${SQ.icon('trash')}</button>`;
    li.querySelector('.option-remove').addEventListener('click', () => {
        li.remove();
        updateOptionCount();
        saveDraft();
    });
    optionList.appendChild(li);
    updateOptionCount();
    if (focus) li.querySelector('.opt-name').focus();
}

function definitionOf(t) {
    return { kind: t.kind, criteria: t.criteria || [], texts: t.texts || [] };
}

function readForm() {
    const def = editDefinition || definitionOf(template);
    return {
        ...def,
        title: $('poll-title').value.trim(),
        options: [...optionList.querySelectorAll('.option-row')].map(li => ({
            name: li.querySelector('.opt-name').value.trim(),
            detail: li.querySelector('.opt-detail').value.trim()
        }))
    };
}

function renderTemplateUi(def) {
    const rating = def.kind === 'rating';
    const word = template.entryWord;
    $('options-label').textContent = rating ? 'Bewertet werden' : 'Zur Wahl stehen';
    $('options-hint').textContent = rating
        ? 'Leer lassen, wenn es nur eine Sache zu bewerten gibt (z. B. das Frühstück). Die Zeile darunter ist optional.'
        : 'Name ist Pflicht, die Zeile darunter optional – z. B. wer gebaut hat.';
    $('quick-fill-label').textContent = `${word === 'Haus' ? 'Häuser' : word === 'Gruppe' ? 'Gruppen' : word + 'e'} 1–n anlegen`;
    $('criteria-section').hidden = !rating;
    $('poll-title').placeholder = rating ? 'z. B. Jahresrückblick' : 'z. B. Das schönste Lebkuchenhaus';
    if (rating) {
        $('criteria-count').textContent = def.criteria.length;
        $('scale-hint').textContent = template.scaleHint || '';
        $('criteria-preview').innerHTML = def.criteria.map(c => `
            <li><span class="emoji">${escapeHtml(c.emoji || '•')}</span>
                <span><b>${escapeHtml(c.name)}</b>${c.question ? `<small>${escapeHtml(c.question)}</small>` : ''}
                ${c.low || c.high ? `<small class="scale">1 = ${escapeHtml(c.low)} · 4 = ${escapeHtml(c.high)}</small>` : ''}</span></li>`).join('')
            + def.texts.map(t => `
            <li class="text-q"><span class="emoji">✍️</span>
                <span><b>${escapeHtml(t.question)}</b><small>Freitext ${t.per_entry ? `je ${escapeHtml(word)}` : 'einmal am Ende'}</small></span></li>`).join('');
    }
    document.querySelectorAll('.template-card').forEach(card => {
        const on = card.dataset.id === template.id;
        card.classList.toggle('selected', on);
        card.setAttribute('aria-checked', on);
    });
}

function fillForm(data) {
    $('poll-title').value = data.title || '';
    optionList.innerHTML = '';
    (data.options || []).forEach(o => addOptionRow(o.name, o.detail));
    if (!isRating()) while (optionList.children.length < 2) addOptionRow();
    renderTemplateUi(editDefinition || definitionOf(template));
    updateOptionCount();
}

function updateOptionCount() {
    const filled = [...optionList.querySelectorAll('.opt-name')].filter(i => i.value.trim()).length;
    $('option-count').textContent = filled;
    $('add-option').hidden = optionList.children.length >= MAX_OPTIONS;
}

function loadDrafts() {
    try {
        const drafts = JSON.parse(load(DRAFT_KEY) || 'null');
        if (drafts && typeof drafts === 'object' && !Array.isArray(drafts.options)) return drafts;
    } catch (e) { /* kaputter Entwurf */ }
    return {};
}

function saveDraft() {
    if (editing) return;   // Entwurf nicht mit den Daten einer laufenden Abstimmung überschreiben
    const drafts = loadDrafts();
    const { title, options } = readForm();
    drafts[template.id] = { title, options };
    drafts.last = template.id;
    store(DRAFT_KEY, JSON.stringify(drafts));
}

function loadDraft() {
    const draft = loadDrafts()[template.id];
    if (draft && Array.isArray(draft.options)) return draft;
    return {
        title: template.title,
        options: Array.from({ length: template.entries }, (_, i) => ({ name: `${template.entryWord} ${i + 1}`, detail: '' }))
    };
}

function chooseTemplate(id) {
    const t = templateById(id);
    if (!t || editing) return;
    template = t;
    fillForm(loadDraft());
    showSetupError('');
    saveDraft();
}

function renderTemplateCards() {
    $('template-list').innerHTML = TEMPLATES.map(t => {
        const n = t.kind === 'rating' ? `${t.criteria.length} Kriterien · 1–4` : 'Eine Stimme pro Person';
        return `
        <button type="button" class="quiz-card template-card" role="radio" data-id="${t.id}" aria-checked="false">
            <div class="quiz-card-icon">${SQ.icon(t.icon)}</div>
            <h3>${escapeHtml(t.label)}</h3>
            <span>${n}</span>
        </button>`;
    }).join('');
}

$('template-list').addEventListener('click', (e) => {
    const card = e.target.closest('.template-card');
    if (card) chooseTemplate(card.dataset.id);
});

function showSetupError(msg) {
    $('setup-error').textContent = msg || '';
}

function openSetup(edit) {
    editing = !!edit;
    SQ.keepAwake(false);
    $('cancel-edit').hidden = !editing;
    $('template-heading').hidden = editing;
    $('template-list').hidden = editing;
    $('create-poll').innerHTML = editing
        ? `Änderungen übernehmen${SQ.icon('check')}`
        : `QR-Code anzeigen${SQ.icon('arrow-right')}`;
    if (editing && current) {
        // Laufende Abstimmung: Vorlage über die Art/den Titel wiederfinden, Kriterien vom Server
        template = TEMPLATES.find(t => t.kind === current.kind && t.title === current.title)
            || TEMPLATES.find(t => t.kind === current.kind) || TEMPLATES[0];
        editDefinition = { kind: current.kind, criteria: current.criteria || [], texts: current.texts || [] };
        fillForm(current);
    } else {
        editDefinition = null;
        template = templateById(loadDrafts().last) || TEMPLATES[0];
        fillForm(loadDraft());
    }
    showSetupError('');
    showScreen('setup');
}

$('add-option').addEventListener('click', () => { addOptionRow('', '', true); saveDraft(); });
optionList.addEventListener('input', () => { updateOptionCount(); saveDraft(); });
$('poll-title').addEventListener('input', saveDraft);

$('quick-fill').addEventListener('click', async () => {
    const word = template.entryWord;
    const n = Math.max(2, Math.min(MAX_OPTIONS, parseInt($('quick-count').value, 10) || 2));
    const existing = readForm().options;
    const hasCustom = existing.some((o, i) => o.detail || (o.name && o.name !== `${word} ${i + 1}`));
    if (hasCustom && !await SQ.confirm(`Liste durch „${word} 1“ bis „${word} ${n}“ ersetzen? Eingetragene Zusatzzeilen bleiben erhalten.`, 'Ersetzen')) return;
    optionList.innerHTML = '';
    for (let i = 0; i < n; i++) addOptionRow(`${word} ${i + 1}`, existing[i]?.detail || '');
    saveDraft();
});

$('setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    soundManager.init();
    const data = readForm();
    data.options = data.options.filter(o => o.name);
    if (!data.title) { showSetupError('Bitte gib der Abstimmung einen Titel.'); $('poll-title').focus(); return; }
    if (data.kind !== 'rating' && data.options.length < 2) { showSetupError('Es braucht mindestens zwei Optionen.'); return; }
    const names = data.options.map(o => o.name.toLowerCase());
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) { showSetupError(`„${data.options[names.indexOf(dup)].name}“ steht doppelt in der Liste.`); return; }
    showSetupError('');
    if (editing && pollCode) {
        awaitingEdit = true;
        socket.emit('update_poll_options', { code: pollCode, ...data });
    } else {
        saveDraft();
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
    const rating = current.kind === 'rating';
    const started = current.voters.filter(v => v.started || v.voted).length;
    if (started === 0 && !await SQ.confirm(`Es hat noch niemand ${rating ? 'bewertet' : 'abgestimmt'}. Trotzdem beenden?`, 'Trotzdem beenden')) return;
    if (started > 0 && missing > 0 &&
        !await SQ.confirm(rating
            ? `${missing} ${missing === 1 ? 'Person ist' : 'Personen sind'} noch nicht fertig mit Bewerten. Trotzdem beenden?`
            : `${missing} ${missing === 1 ? 'Person hat' : 'Personen haben'} noch nicht abgestimmt. Trotzdem beenden?`, 'Trotzdem beenden')) return;
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
    const rating = p.kind === 'rating';
    $('votes-cast').textContent = p.votes_cast;
    $('votes-label').textContent = rating ? `von ${voters} fertig bewertet` : `von ${voters} haben abgestimmt`;
    $('votes-fill').style.width = voters ? `${Math.round(p.votes_cast / voters * 100)}%` : '0';
    $('voter-count').textContent = voters;

    // Nur neu zeichnen, was sich geändert hat – sonst flackert bei jedem Update alles
    const showCriteria = rating && p.options.length === 0;
    $('chips-label').textContent = showCriteria ? 'Bewertet wird' : rating ? 'Bewertet werden' : 'Zur Wahl';
    const chipsHtml = showCriteria
        ? p.criteria.map(c => `
        <span class="option-chip"><span class="num emoji">${escapeHtml(c.emoji || '•')}</span><span>${escapeHtml(c.name)}</span></span>`).join('')
        : p.options.map((o, i) => `
        <span class="option-chip"><span class="num">${i + 1}</span><span>${escapeHtml(o.name)}${o.detail ? `<small>${escapeHtml(o.detail)}</small>` : ''}</span></span>`).join('');
    if ($('option-chips').dataset.html !== chipsHtml) {
        $('option-chips').innerHTML = chipsHtml;
        $('option-chips').dataset.html = chipsHtml;
    }

    SQ.syncList($('voters-grid'), p.voters.map(v => ({
        key: v.name.toLowerCase(),
        className: `player-chip voter-chip${v.voted ? ' voted' : v.started ? ' started' : ''}${v.connected ? '' : ' offline'}`,
        text: v.name,
    })));

    const isOpen = p.state === 'open';
    $('open-btn').hidden = isOpen;
    $('close-btn').hidden = !isOpen;
    $('edit-btn').hidden = isOpen;
    $('open-btn').innerHTML = `${rating ? 'Bewertung' : 'Abstimmung'} starten${SQ.icon('play')}`;
    $('close-btn').innerHTML = `${rating ? 'Bewertung' : 'Abstimmung'} beenden${SQ.icon('trophy')}`;
    $('footer-hint').textContent = isOpen
        ? (rating
            ? 'Die Punkte bleiben bis zum Schluss geheim – du siehst nur, wer schon fertig ist.'
            : 'Die Stimmen bleiben bis zum Schluss geheim – du siehst nur, wer schon abgestimmt hat.')
        : `Anmelden geht schon. ${rating ? 'Bewertet' : 'Abgestimmt'} wird, sobald du startest.`;
}

// ---------- Ergebnis ----------
let shownResultKey = null;  // welches Ergebnis gerade angezeigt wird

function fmt(n) {
    return Number(n || 0).toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

function renderResult(p) {
    const r = p.results;
    // Nach dem Beenden kommen weiter Updates (z. B. wenn Leute ihr Handy zumachen). Das Ergebnis
    // ist dann dasselbe – nicht neu aufbauen, sonst laufen Balken und Einblendung jedes Mal neu.
    const key = JSON.stringify([p.code, p.title, r]);
    if (key === shownResultKey && screens.result.classList.contains('active')) return;
    shownResultKey = key;
    $('result-title').innerHTML = escapeHtml(p.title);
    if (r.kind === 'rating') renderRatingResult(p, r);
    else renderChoiceResult(p, r);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        document.querySelectorAll('#ranking .bar div').forEach(d => { d.style.width = `${d.dataset.w}%`; });
    }));
    showScreen('result');
}

function renderChoiceResult(p, r) {
    const winners = r.ranking.filter(row => r.winners.includes(row.index));
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

    $('ranking-title').textContent = 'Alle Stimmen';
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
    $('answers').innerHTML = '';
}

function renderRatingResult(p, r) {
    const single = p.options.length === 0;
    const crit = p.criteria;
    $('total-votes').textContent = `${r.total_votes} ${r.total_votes === 1 ? 'Person' : 'Personen'}`;

    if (single) {
        // Eine Sache bewertet (Frühstück): Gesamtschnitt groß, darunter jedes Kriterium
        const row = r.ranking[0];
        const rated = row.averages.filter(a => a !== null);
        const avg = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : 0;
        $('result-kicker').textContent = r.total_votes === 0 ? 'Keine Bewertungen abgegeben' : 'Das Ergebnis';
        $('winner-row').innerHTML = r.total_votes === 0 ? '' : `
            <div class="winner-card">
                <div class="crown">${SQ.icon('trophy')}</div>
                <div class="name">Ø ${fmt(avg)} <small class="of">von 4</small></div>
                <div class="votes">${fmt(row.total)} von ${r.max_total} Punkten</div>
            </div>`;
        $('ranking-title').textContent = 'Alle Kriterien';
        const best = Math.max(...row.averages.map(a => a || 0));
        $('ranking').innerHTML = crit.map((c, i) => {
            const a = row.averages[i];
            return `
            <li class="rank-row${a !== null && a === best && best > 0 ? ' win' : ''}" style="animation-delay:${i * 0.06}s">
                <span class="place emoji">${escapeHtml(c.emoji || '•')}</span>
                <span class="who">${escapeHtml(c.name)}</span>
                <span class="bar"><div data-w="${(a || 0) / 4 * 100}"></div></span>
                <span class="count">${a === null ? '–' : fmt(a)}<small>von 4</small></span>
            </li>`;
        }).join('');
    } else {
        const winners = r.ranking.filter(row => r.winners.includes(row.index));
        $('result-kicker').textContent = r.total_votes === 0
            ? 'Keine Bewertungen abgegeben'
            : winners.length > 1 ? `Gleichstand – ${winners.length} Sieger!` : 'Und gewonnen hat';
        $('winner-row').innerHTML = winners.map(w => `
            <div class="winner-card">
                <div class="crown">${SQ.icon('crown')}</div>
                <div class="name">${escapeHtml(w.name)}</div>
                ${w.detail ? `<div class="detail">${escapeHtml(w.detail)}</div>` : ''}
                <div class="votes">${fmt(w.total)} von ${r.max_total} Punkten</div>
            </div>`).join('');
        $('ranking-title').textContent = 'Alle Punkte';
        const max = Math.max(1, r.max_total);
        $('ranking').innerHTML = r.ranking.map((row, i) => {
            const parts = crit.map((c, k) => `<span title="${escapeHtml(c.name)}">${escapeHtml(c.emoji || c.name)} ${row.averages[k] === null ? '–' : fmt(row.averages[k])}</span>`).join('');
            return `
            <li class="rank-row${r.winners.includes(row.index) ? ' win' : ''}" style="animation-delay:${i * 0.06}s">
                <span class="place">${row.place}.</span>
                <span class="who">${escapeHtml(row.name)}${row.detail ? `<small>${escapeHtml(row.detail)}</small>` : ''}<small class="crit-parts">${parts}</small></span>
                <span class="bar"><div data-w="${row.total / max * 100}"></div></span>
                <span class="count">${fmt(row.total)}<small>${row.raters} ${row.raters === 1 ? 'Wertung' : 'Wertungen'}</small></span>
            </li>`;
        }).join('');
    }

    // Freitexte ohne Namen
    $('answers').innerHTML = (r.answers || []).map(group => {
        const q = p.texts[group.text]?.question || '';
        const entry = group.entry === null || single ? '' : p.options[group.entry]?.name || '';
        return `
        <div class="ranking-card answer-card">
            <div class="card-title">${escapeHtml(q)}${entry ? ` <small>${escapeHtml(entry)}</small>` : ''}</div>
            <span class="lime-line"></span>
            ${group.answers.length
                ? `<ul class="answer-list">${group.answers.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
                : '<p class="no-answers">Keine Antworten</p>'}
        </div>`;
    }).join('');
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
    $('reveal-head').textContent = p.kind === 'rating' && p.options.length === 0 ? 'Und das Ergebnis …' : 'Und gewonnen hat …';
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
    SQ.keepAwake(true);  // Beamer soll während der Abstimmung nicht einschlafen
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

renderTemplateCards();
openSetup(false);

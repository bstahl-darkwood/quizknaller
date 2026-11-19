// SmartQuiz – Hintergrund (Schnee, Tannen, Lichterkette) und Logo-Symbol für alle Seiten.
(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';

    // Logo-Symbol einmal pro Seite definieren: <svg><use href="#sq-logo"/></svg>
    const defs = document.createElement('div');
    defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    defs.setAttribute('aria-hidden', 'true');
    defs.innerHTML = `
      <svg xmlns="${SVG_NS}">
        <defs>
          <linearGradient id="sq-lime" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a6f04a"/><stop offset="1" stop-color="#5fcf3a"/></linearGradient>
          <linearGradient id="sq-hex" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a4fa8"/><stop offset="1" stop-color="#0b2557"/></linearGradient>
          <symbol id="sq-logo" viewBox="0 0 64 64">
            <polygon points="32,3 57,17.5 57,46.5 32,61 7,46.5 7,17.5" fill="url(#sq-hex)" stroke="url(#sq-lime)" stroke-width="4" stroke-linejoin="round"/>
            <path d="M25.2 24.6a7 7 0 1 1 9.9 6.4c-2.1 1-3.1 2.4-3.1 4.5v1.2" fill="none" stroke="#fff" stroke-width="5.2" stroke-linecap="round"/>
            <circle cx="32" cy="44.3" r="3.3" fill="#fff"/>
            <g stroke="#8be23c" stroke-width="2.6" stroke-linecap="round"><path d="M47 11l3-4"/><path d="M51 16l5-1"/><path d="M44 8l0-5"/></g>
          </symbol>
        </defs>
      </svg>`;
    document.body.prepend(defs);

    const bg = document.querySelector('.night-bg');
    if (!bg) return;

    // Schnee: statisch (kein Animations-Ruckeln auf günstigen Handys)
    const snow = document.createElement('div');
    snow.className = 'snow';
    let seed = 42;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const flakes = Math.round(Math.min(window.innerWidth * window.innerHeight / 9000, 90));
    for (let i = 0; i < flakes; i++) {
        const f = document.createElement('i');
        const size = 1.5 + rnd() * 3;
        f.style.cssText = `left:${rnd() * 100}%;top:${rnd() * 100}%;width:${size}px;height:${size}px;opacity:${0.2 + rnd() * 0.5}`;
        snow.appendChild(f);
    }
    bg.appendChild(snow);

    // Tannen-Silhouette
    const trees = document.createElementNS(SVG_NS, 'svg');
    trees.setAttribute('class', 'trees');
    trees.setAttribute('viewBox', '0 0 400 120');
    trees.setAttribute('preserveAspectRatio', 'none');
    trees.innerHTML = '<path fill="#030c22" d="M0 120V92l10-20 8 16 9-34 10 30 8-18 12 40 9-28 11 22 10-46 12 40 9-18 10 24 12-36 11 30 8-14 10 26 12-44 11 38 9-20 10 28 11-32 12 34 8-16 10 22 12-42 11 36 9-18 10 26 11-30 12 30 9-22 11 28 10-38 12 32 8-12 10 20V120z"/>';
    bg.appendChild(trees);

    // Lichterkette in echter Pixelbreite (sonst werden die Lichter verzerrt)
    if (bg.dataset.lights !== 'off') {
        const lights = document.createElementNS(SVG_NS, 'svg');
        lights.setAttribute('class', 'lights');
        bg.appendChild(lights);
        const draw = () => {
            const w = lights.clientWidth || window.innerWidth;
            const h = 80;
            const sag = w > 700 ? 46 : 28;
            const n = Math.max(6, Math.round(w / 46));
            const y = t => 10 + Math.sin(t * Math.PI * (w > 700 ? 2 : 1)) * sag * 0.5 + sag * 0.4 * Math.sin(t * Math.PI);
            let path = '';
            let bulbs = '';
            for (let i = 0; i <= 60; i++) {
                const t = i / 60;
                path += (i ? 'L' : 'M') + (t * w).toFixed(1) + ' ' + y(t).toFixed(1);
            }
            for (let i = 0; i < n; i++) {
                const t = (i + 0.5) / n;
                const x = t * w;
                const yy = y(t) + 6;
                bulbs += `<circle cx="${x}" cy="${yy}" r="9" fill="#ffb547" opacity=".22"/><circle cx="${x}" cy="${yy}" r="3" fill="#ffd27a"/>`;
            }
            lights.setAttribute('viewBox', `0 0 ${w} ${h}`);
            lights.innerHTML = `<path d="${path}" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1"/>` + bulbs;
        };
        draw();
        let t;
        window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(draw, 150); });
    }
})();

// ---------- Icons ----------
// Einheitliches Linien-Icon-Set (Lucide, ISC-Lizenz, https://lucide.dev) – einfarbig, übernimmt die Textfarbe.
// Verwendung: <i data-icon="upload"></i> im HTML oder SQ.icon('upload') in JS.
window.SQ = window.SQ || {};
(function () {
    const P = {
        'pencil': '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
        'upload': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
        'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
        'settings': '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
        'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        'check': '<path d="M20 6 9 17l-5-5"/>',
        'vote': '<path d="m9 12 2 2 4-4"/><path d="M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7Z"/><path d="M22 19H2"/>',
        'logout': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
        'house': '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        'trash': '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
        'chevron-down': '<path d="m6 9 6 6 6-6"/>',
        'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
        'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
        'play': '<polygon points="6 3 20 12 6 21 6 3"/>',
        'save': '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
        'folder-open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
        'rotate': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
        'user-minus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" x2="16" y1="11" y2="11"/>',
        'users': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        'book-open': '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
        'flame': '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
        'trophy': '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
        'crown': '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
        'alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
        'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
        'clock': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
        // Themen-Icons für Quiz-Karten
        'tree': '<path d="m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z"/><path d="M12 22v-3"/>',
        'disc': '<circle cx="12" cy="12" r="10"/><path d="M6 12c0-1.7.7-3.2 1.8-4.2"/><circle cx="12" cy="12" r="2"/><path d="M18 12c0 1.7-.7 3.2-1.8 4.2"/>',
        'music': '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
        'clapperboard': '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
        'cpu': '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
        'globe': '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
        'map': '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
        'tag': '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1"/>',
        'lightbulb': '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
        'beer': '<path d="M17 11h1a3 3 0 0 1 0 6h-1"/><path d="M9 12v6"/><path d="M13 12v6"/><path d="M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2 11 2s2 1.5 3 1.5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"/><path d="M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"/>',
        'cup': '<path d="m6 8 1.75 12.28a2 2 0 0 0 2 1.72h4.54a2 2 0 0 0 2-1.72L18 8"/><path d="M5 8h14"/><path d="M7 15a6.47 6.47 0 0 1 5 0 6.47 6.47 0 0 0 5 0"/><path d="m12 8 1-6h2"/>',
        'wine': '<path d="M8 22h8"/><path d="M7 10h10"/><path d="M12 15v7"/><path d="M12 15a5 5 0 0 0 5-5c0-2-.5-4-2-8H9c-1.5 4-2 6-2 8a5 5 0 0 0 5 5Z"/>',
        'utensils': '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
        'tv': '<rect width="20" height="15" x="2" y="7" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/>',
        'gift': '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
        'puzzle': '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
        'sparkles': '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
        'help': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
        // Antwortformen (gefüllt)
        'shape-0': '<path d="M12 3.5 21.5 20h-19z"/>',
        'shape-1': '<path d="M12 2.5 21.5 12 12 21.5 2.5 12z"/>',
        'shape-2': '<circle cx="12" cy="12" r="9"/>',
        'shape-3': '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/>'
    };
    SQ.icon = function (name, cls) {
        const solid = name.startsWith('shape-');
        return `<svg class="icon${solid ? ' icon-solid' : ''}${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
    };
    // Passendes Themen-Icon für ein Quiz anhand des Titels (erste passende Regel gewinnt)
    const TOPICS = [
        [/techno|rave|house|elektron/, 'disc'],   // vor "tech", sonst wird Techno zum Chip
        [/bier/, 'beer'],
        [/getränk|drink|cocktail/, 'cup'],
        [/sport|fußball|olymp/, 'trophy'],
        [/essen|koch|küche|food/, 'utensils'],
        [/serie|tv|fernseh/, 'tv'],
        [/film|kino|movie/, 'clapperboard'],
        [/musik|song|lied/, 'music'],
        [/tech|internet|computer|it-/, 'cpu'],
        [/topograph|karte/, 'map'],
        [/geograph|international|länder|welt|reise/, 'globe'],
        [/marke|brand|logo/, 'tag'],
        [/geschicht|brauch|histor/, 'book-open'],
        [/knobel|rätsel|logik/, 'puzzle'],
        [/kurios|fact|fakten/, 'sparkles'],
        [/weihnachtsmann|geschenk/, 'gift'],
        [/feier|party/, 'wine'],
        [/weihnacht|advent|christmas|xmas/, 'tree'],
        [/allgemein|wissen/, 'lightbulb']
    ];
    SQ.topicIcon = function (title) {
        const t = String(title || '').toLowerCase();
        const hit = TOPICS.find(([re]) => re.test(t));
        return hit ? hit[1] : 'help';
    };
    SQ.renderIcons = function (root) {
        (root || document).querySelectorAll('[data-icon]').forEach(el => {
            if (el.dataset.iconDone) return;
            el.innerHTML = SQ.icon(el.dataset.icon);
            el.dataset.iconDone = '1';
        });
    };
    // Bunte Emojis aus Anzeigetexten (z. B. Quiz-Titeln) entfernen
    SQ.plain = function (text) {
        return String(text ?? '')
            .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}️‍⃣]/gu, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    };
    SQ.renderIcons();

    // Bestätigung in der Seite statt confirm(): eingebettete Browser (z. B. das Browser-Panel
    // der Claude-App) lehnen confirm() teils ohne Dialog ab – der Klick blieb dann wirkungslos.
    // Verwendung: if (await SQ.confirm('Wirklich löschen?', 'Löschen')) { … }
    let dialog = null;
    function ensureDialog() {
        if (dialog) return dialog;
        dialog = document.createElement('dialog');
        dialog.className = 'confirm-dialog';
        dialog.setAttribute('aria-labelledby', 'sq-confirm-message');
        dialog.innerHTML =
            '<form method="dialog">' +
            '<p id="sq-confirm-message" class="confirm-message"></p>' +
            '<div class="confirm-actions">' +
            '<button value="cancel" class="confirm-cancel" type="submit">Abbrechen</button>' +
            '<button value="ok" class="confirm-ok" type="submit">OK</button>' +
            '</div></form>';
        // Klick neben den Dialog = Abbrechen
        dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close('cancel'); });
        document.body.appendChild(dialog);
        return dialog;
    }
    SQ.confirm = function (message, okLabel) {
        const d = ensureDialog();
        if (typeof d.showModal !== 'function') return Promise.resolve(window.confirm(message));
        if (d.open) d.close('cancel');  // ein noch offener Dialog gilt als abgebrochen
        d.querySelector('.confirm-message').textContent = message;
        d.querySelector('.confirm-ok').textContent = okLabel || 'OK';
        d.returnValue = '';
        return new Promise((resolve) => {
            d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
            d.showModal();
            d.querySelector('.confirm-ok').focus();
        });
    };
})();

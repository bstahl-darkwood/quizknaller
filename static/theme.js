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

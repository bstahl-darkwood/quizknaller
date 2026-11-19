// SmartQuiz – Weihnachtsmusik für den Host, live im Browser erzeugt (Web Audio API).
// Keine Musikdatei, kein Download. Glockenspiel-Melodie, Bass, Begleitung und Schlittenglöckchen.
//
// Nur gemeinfreie Lieder:
//   Jingle Bells (James Lord Pierpont, 1857)
//   Morgen kommt der Weihnachtsmann (Text Hoffmann von Fallersleben 1840, Melodie traditionell)
//   We Wish You a Merry Christmas (traditionell, England)
//
// Verwendung: const m = new XmasMusic(audioContext, 0.3); m.start(); … m.stop();

(function () {
    const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
    function freq(name) {
        const m = /^([A-G]#?)(\d)$/.exec(name);
        const midi = 12 * (Number(m[2]) + 1) + NOTE[m[1]];
        return 440 * Math.pow(2, (midi - 69) / 12);
    }
    // Akkorde: Grundton (für den Bass) + Begleittöne
    const CHORDS = {
        C: ['C3', ['E4', 'G4', 'C5']],
        F: ['F2', ['F4', 'A4', 'C5']],
        G: ['G2', ['G4', 'B4', 'D5']],
        G7: ['G2', ['F4', 'G4', 'B4']],
        D: ['D3', ['D4', 'F#4', 'A4']],
        D7: ['D3', ['C4', 'F#4', 'A4']],
        A7: ['A2', ['C#4', 'G4', 'A4']],
        B7: ['B2', ['D#4', 'F#4', 'A4']],
        Em: ['E3', ['E4', 'G4', 'B4']],
    };

    // Melodie: "Ton:Schläge" (ohne Zahl = 1 Schlag), "-" = Pause. Akkorde: "Akkord:Schläge".
    const SONGS = [
        {   // Jingle Bells (Refrain)
            bpm: 138, meter: 4, bells: 'eighths',
            melody: 'E5 E5 E5:2 E5 E5 E5:2 E5 G5 C5:1.5 D5:0.5 E5:4 ' +
                    'F5 F5 F5:1.5 F5:0.5 F5 E5 E5 E5:0.5 E5:0.5 E5 D5 D5 E5 D5:2 G5:2 ' +
                    'E5 E5 E5:2 E5 E5 E5:2 E5 G5 C5:1.5 D5:0.5 E5:4 ' +
                    'F5 F5 F5 F5 F5 E5 E5 E5:0.5 E5:0.5 G5 G5 F5 D5 C5:4',
            chords: 'C:4 C:4 C:4 C:4 F:4 C:4 D7:4 G7:4 C:4 C:4 C:4 C:4 F:4 C:4 G7:4 C:4',
        },
        {   // Morgen kommt der Weihnachtsmann
            bpm: 120, meter: 4, bells: 'quarters',
            melody: 'C5 C5 G5 G5 A5 A5 G5:2 F5 F5 E5 E5 D5 D5 C5:2 ' +
                    'G5 G5 F5 F5 E5 E5 D5:2 G5 G5 F5 F5 E5 E5 D5:2 ' +
                    'C5 C5 G5 G5 A5 A5 G5:2 F5 F5 E5 E5 D5 D5 C5:2',
            chords: 'C:4 F:2 C:2 F:2 C:2 G7:2 C:2 C:2 F:2 C:2 G7:2 C:2 F:2 C:2 G7:2 ' +
                    'C:4 F:2 C:2 F:2 C:2 G7:2 C:2',
        },
        {   // We Wish You a Merry Christmas (3/4, mit Auftakt, zweimal)
            bpm: 150, meter: 3, bells: 'quarters',
            melody: 'D5 G5 G5:0.5 A5:0.5 G5:0.5 F#5:0.5 E5 E5 E5 A5 A5:0.5 B5:0.5 A5:0.5 G5:0.5 F#5 D5 D5 ' +
                    'B5 B5:0.5 C6:0.5 B5:0.5 A5:0.5 G5 E5 D5:0.5 D5:0.5 E5 A5 F#5 G5:2 ' +
                    'D5 G5 G5:0.5 A5:0.5 G5:0.5 F#5:0.5 E5 E5 E5 A5 A5:0.5 B5:0.5 A5:0.5 G5:0.5 F#5 D5 D5 ' +
                    'B5 B5:0.5 C6:0.5 B5:0.5 A5:0.5 G5 E5 D5:0.5 D5:0.5 E5 A5 F#5 G5:3',
            chords: '-:1 G:3 C:3 A7:3 D:3 B7:3 Em:3 C:1 D:2 G:3 ' +
                    'G:3 C:3 A7:3 D:3 B7:3 Em:3 C:1 D:2 G:3',
        },
    ];
    const ORDER = [0, 1, 2, 0];   // Jingle Bells zum Schluss noch mal
    const GAP_BEATS = 1;          // kurze Pause zwischen den Liedern

    function parse(seq) {
        return seq.trim().split(/\s+/).map(tok => {
            const [n, d] = tok.split(':');
            return [n, d ? Number(d) : 1];
        });
    }

    // Ganze Schleife als Liste von Ereignissen (Zeit in Sekunden ab Schleifenbeginn)
    function buildLoop() {
        const events = [];
        let offset = 0;
        for (const idx of ORDER) {
            const song = SONGS[idx];
            const spb = 60 / song.bpm;
            let t = 0;
            for (const [n, beats] of parse(song.melody)) {
                if (n !== '-') events.push({ t: offset + t * spb, type: 'bell', f: freq(n), d: beats * spb });
                t += beats;
            }
            const songBeats = t;
            let c = 0;
            for (const [name, beats] of parse(song.chords)) {
                const chord = CHORDS[name];
                if (chord) {
                    events.push({ t: offset + c * spb, type: 'bass', f: freq(chord[0]), d: Math.min(beats, 2) * spb * 0.9 });
                    // Begleitung "Um-pa": auf den Schlägen nach dem ersten
                    for (let b = 1; b < beats; b++) {
                        events.push({ t: offset + (c + b) * spb, type: 'comp', fs: chord[1].map(freq), d: spb * 0.5 });
                    }
                    if (song.meter === 4 && beats >= 4) {   // Bass auf 3 im 4/4: Quinte
                        events.push({ t: offset + (c + 2) * spb, type: 'bass', f: freq(chord[0]) * 1.5, d: spb * 0.9 });
                    }
                }
                c += beats;
            }
            const step = song.bells === 'eighths' ? 0.5 : 1;
            for (let b = 0; b < songBeats; b += step) {
                events.push({ t: offset + b * spb, type: 'jingle', accent: b % 1 === 0 });
            }
            offset += (songBeats + GAP_BEATS) * spb;
        }
        events.sort((a, b) => a.t - b.t);
        return { events, length: offset };
    }

    class XmasMusic {
        constructor(ctx, volume = 0.3) {
            this.ctx = ctx;
            this.loop = buildLoop();
            this.out = ctx.createGain();
            // ×1.8: ungefähr so laut wie die alte MP3 bei gleicher masterVolume
            this.out.gain.value = Math.max(0, Math.min(1, volume)) * 1.8;
            // Kompressor gegen Übersteuern, wenn viele Töne zusammenkommen
            const comp = ctx.createDynamicsCompressor();
            comp.threshold.value = -14;
            comp.ratio.value = 4;
            this.out.connect(comp);
            comp.connect(ctx.destination);
            this.comp = comp;
            this.noise = this._noiseBuffer();
            this.timer = null;
        }

        get loopLength() { return this.loop.length; }

        _noiseBuffer() {
            const len = Math.floor(this.ctx.sampleRate * 0.25);
            const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
            return buf;
        }

        _env(gainNode, t, peak, attack, release) {
            const g = gainNode.gain;
            g.setValueAtTime(0.0001, t);
            g.exponentialRampToValueAtTime(peak, t + attack);
            g.exponentialRampToValueAtTime(0.0001, t + attack + release);
        }

        _tone(type, f, t, peak, attack, release) {
            const osc = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            osc.type = type;
            osc.frequency.value = f;
            osc.connect(g);
            g.connect(this.out);
            this._env(g, t, peak, attack, release);
            osc.start(t);
            osc.stop(t + attack + release + 0.05);
        }

        // Glockenspiel: Grundton + glockentypische Obertöne, klingt aus
        _bell(f, t, d) {
            const release = Math.max(0.35, Math.min(1.4, d * 1.6));
            this._tone('sine', f, t, 0.32, 0.004, release);
            this._tone('sine', f * 2, t, 0.10, 0.003, release * 0.6);
            this._tone('sine', f * 3.01, t, 0.05, 0.002, release * 0.35);
        }

        _bass(f, t, d) {
            this._tone('triangle', f, t, 0.30, 0.01, Math.max(0.2, d));
        }

        _comp(fs, t, d) {
            for (const f of fs) this._tone('triangle', f, t, 0.045, 0.008, Math.max(0.12, d));
        }

        // Schlittenglöckchen: kurzes, hohes Rauschen
        _jingle(t, accent) {
            const src = this.ctx.createBufferSource();
            src.buffer = this.noise;
            const hp = this.ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = 6500;
            const bp = this.ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = 9000;
            bp.Q.value = 0.8;
            const g = this.ctx.createGain();
            src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(this.out);
            this._env(g, t, accent ? 0.22 : 0.12, 0.003, accent ? 0.12 : 0.07);
            src.start(t);
            src.stop(t + 0.2);
        }

        _play(ev, t) {
            if (ev.type === 'bell') this._bell(ev.f, t, ev.d);
            else if (ev.type === 'bass') this._bass(ev.f, t, ev.d);
            else if (ev.type === 'comp') this._comp(ev.fs, t, ev.d);
            else this._jingle(t, ev.accent);
        }

        // Plant alles bis "until" (Sekunden, Kontextzeit) ein
        _schedule(until) {
            const { events, length } = this.loop;
            while (true) {
                const ev = events[this.index];
                const t = this.loopStart + ev.t;
                if (t > until) return;
                this._play(ev, t);
                this.index++;
                if (this.index >= events.length) {
                    this.index = 0;
                    this.loopStart += length;
                }
            }
        }

        start(at) {
            this.stop();
            this.loopStart = (at ?? this.ctx.currentTime) + 0.1;
            this.index = 0;
            // 2 s im Voraus einplanen: auch wenn der Browser den Timer im Hintergrund drosselt,
            // reißt die Musik nicht ab
            this._schedule(this.ctx.currentTime + 2);
            this.timer = setInterval(() => this._schedule(this.ctx.currentTime + 2), 250);
        }

        // Für Tests: ganze Schleife auf einmal einplanen (z. B. in einem OfflineAudioContext)
        scheduleOnce(seconds) {
            this.loopStart = 0;
            this.index = 0;
            this._schedule(seconds);
        }

        stop() {
            if (this.timer) clearInterval(this.timer);
            this.timer = null;
            if (this.loopStart === undefined) return;
            // Kurz ausblenden, dann abkoppeln – bereits eingeplante Töne laufen ins Leere
            const now = this.ctx.currentTime;
            this.out.gain.cancelScheduledValues(now);
            this.out.gain.setValueAtTime(this.out.gain.value, now);
            this.out.gain.linearRampToValueAtTime(0, now + 0.3);
            const out = this.out, comp = this.comp;
            setTimeout(() => { try { out.disconnect(); comp.disconnect(); } catch (e) { /* schon weg */ } }, 400);
            this.loopStart = undefined;
        }

        // Kompatibel zum alten Audio-Element (sounds.js ruft pause() auf)
        pause() { this.stop(); }
    }

    window.XmasMusic = XmasMusic;
})();

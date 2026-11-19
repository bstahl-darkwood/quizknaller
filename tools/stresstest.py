"""Stresstest für Quizknaller: N Bot-Spieler treten einem Spiel bei und spielen es durch.

Zwei Betriebsarten:

1. Gegen den Server mit Admin-Login (Produktion): Du hostest das Spiel im Browser
   (/host), startest das Skript mit dem Spielcode, wartest bis alle Bots in der
   Lobby sind und startest dann das Quiz wie gewohnt.

       uv run --with "python-socketio[asyncio_client]" tools/stresstest.py \
           --url https://quiz.benjamin-stahl.de --code ABC123 --players 100

2. Lokal ohne ADMIN_PASSWORD: Das Skript hostet selbst (--self-host), startet das
   Spiel, sobald alle Bots drin sind, und klickt automatisch weiter.

       uv run --with "python-socketio[asyncio_client]" tools/stresstest.py \
           --url http://localhost:8000 --self-host --players 10

Gemessen wird: Verbindungsaufbau, Beitritt, wie weit die Ankunft von Frage/Ergebnis
über alle Bots streut (Fan-out des Servers), Antwort-Roundtrip (submit_answer →
answer_received) und Verbindungsabbrüche.
"""

import argparse
import asyncio
import json
import random
import statistics
import time

import socketio


def pct(values, p):
    if not values:
        return float("nan")
    values = sorted(values)
    k = min(len(values) - 1, max(0, round(p / 100 * (len(values) - 1))))
    return values[k]


def fmt_ms(values):
    if not values:
        return "–"
    return (f"median {statistics.median(values) * 1000:6.0f} ms | "
            f"p95 {pct(values, 95) * 1000:6.0f} ms | max {max(values) * 1000:6.0f} ms")


class Stats:
    def __init__(self):
        self.connect_times = []
        self.join_times = []
        self.answer_rtts = []
        self.connect_errors = []
        self.join_errors = []
        self.disconnects = 0
        self.reconnects = 0
        self.joined = 0
        self.slot_takeovers = 0
        self.ended = 0
        # Frage-Nr -> Liste der Ankunftszeiten (monotonic) pro Bot
        self.reading_arrivals = {}
        self.answers_arrivals = {}
        self.result_arrivals = {}
        self.answers_sent = {}
        self.results_received = {}
        self.missing_results = 0
        self.disconnect_log = []      # (Zeit, Bot, Frage, Grund)
        self.replays = []             # (Frage, Event, Bot) – nach Reconnect nachgeschickt
        self.other_events = {}        # Event -> [Anzahl, Bytes] (Events, die der Bot nicht braucht)
        self.loop_lag = []            # (Zeit, Verzögerung) der Event-Loop dieses Skripts
        self.t0 = time.monotonic()


class Bot:
    def __init__(self, idx, args, stats: Stats):
        self.idx = idx
        self.args = args
        self.stats = stats
        self.name = f"{args.prefix}{idx:03d}"
        self.sio = socketio.AsyncClient(reconnection=True, reconnection_attempts=5)
        self.code = args.code
        self.question_num = 0
        self.answer_sent_at = None
        self.awaiting_result = False
        self.done = asyncio.Event()
        self.joined = asyncio.Event()
        self.ever_connected = False
        self.replay_until = 0.0
        self._register()

    def _arrive(self, bucket, event):
        now = time.monotonic()
        if now < self.replay_until:
            # kam als Nachlieferung nach einem Reconnect – keine echte Verspätung des Servers
            self.stats.replays.append((self.question_num, event, self.name))
            return
        bucket.setdefault(self.question_num, []).append((now, self.name))

    def _register(self):
        s = self.sio

        @s.event
        async def connect():
            if self.ever_connected:
                self.stats.reconnects += 1
                # wie der echte Client: nach Reconnect wieder ins Spiel
                await s.emit("join_game", {"code": self.code, "name": self.name})
            self.ever_connected = True

        @s.event
        async def disconnect(*reason):
            if not self.done.is_set():
                self.stats.disconnects += 1
                t = time.monotonic() - self.stats.t0
                self.stats.disconnect_log.append((t, self.name, self.question_num, reason))
                print(f"!! [{t:5.1f}s] {self.name} getrennt (Frage {self.question_num}, Grund {reason})", flush=True)

        @s.on("*")
        async def other(event, data=None):
            entry = self.stats.other_events.setdefault(event, [0, 0])
            entry[0] += 1
            entry[1] += len(json.dumps(data, ensure_ascii=False))

        @s.on("joined_game")
        async def joined_game(_data):
            self.stats.join_times.append(time.monotonic() - self._join_sent)
            self.stats.joined += 1
            self.joined.set()

        @s.on("reconnected_player")
        async def reconnected_player(_data):
            # gleicher Name wie ein getrennter Spieler -> Platz übernommen
            if not self.joined.is_set():
                self.stats.join_times.append(time.monotonic() - self._join_sent)
                self.stats.joined += 1
                self.stats.slot_takeovers += 1
            else:
                t = time.monotonic() - self.stats.t0
                print(f"!! [{t:5.1f}s] {self.name} wieder im Spiel (Frage {self.question_num})", flush=True)
            # alles, was jetzt direkt kommt, ist die Nachlieferung der laufenden Frage
            self.replay_until = time.monotonic() + 1.0
            self.joined.set()

        @s.on("error")
        async def error(data):
            msg = (data or {}).get("message", str(data))
            if not self.joined.is_set():
                self.stats.join_errors.append(f"{self.name}: {msg}")
                self.joined.set()
                self.done.set()

        @s.on("show_question_reading")
        async def reading(data):
            self.question_num = data.get("question_num", self.question_num + 1)
            self._arrive(self.stats.reading_arrivals, "Frage")

        @s.on("show_answers")
        async def show_answers(data):
            q = self.question_num
            self._arrive(self.stats.answers_arrivals, "Antworten")
            n_answers = len(data.get("answers") or []) or 4
            time_limit = float(data.get("time_limit", 20))
            if random.random() < self.args.skip_rate:
                return  # dieser Bot "verpennt" die Frage
            delay = random.uniform(self.args.min_delay, min(self.args.max_delay, time_limit - 1))
            asyncio.create_task(self._answer(q, delay, random.randrange(n_answers)))

        @s.on("answer_received")
        async def answer_received(_data):
            if self.answer_sent_at is not None:
                self.stats.answer_rtts.append(time.monotonic() - self.answer_sent_at)
                self.answer_sent_at = None

        @s.on("your_result")
        async def your_result(_data):
            self._arrive(self.stats.result_arrivals, "Ergebnis")
            self.stats.results_received[self.question_num] = self.stats.results_received.get(self.question_num, 0) + 1

        @s.on("game_ended")
        async def game_ended(_data):
            self.stats.ended += 1
            self.done.set()

    async def _answer(self, q, delay, choice):
        await asyncio.sleep(delay)
        if self.question_num != q or not self.sio.connected:
            return
        self.answer_sent_at = time.monotonic()
        self.stats.answers_sent[q] = self.stats.answers_sent.get(q, 0) + 1
        await self.sio.emit("submit_answer", {"code": self.code, "answer": choice})

    async def run(self):
        t0 = time.monotonic()
        try:
            await self.sio.connect(self.args.url, transports=self.args.transports,
                                   headers={"Origin": self.args.url}, wait_timeout=20)
        except Exception as e:  # noqa: BLE001
            self.stats.connect_errors.append(f"{self.name}: {e!r}")
            self.done.set()
            return
        self.stats.connect_times.append(time.monotonic() - t0)
        self._join_sent = time.monotonic()
        await self.sio.emit("join_game", {"code": self.code, "name": self.name})
        try:
            await asyncio.wait_for(self.joined.wait(), 20)
        except asyncio.TimeoutError:
            self.stats.join_errors.append(f"{self.name}: keine Antwort auf join_game")
            self.done.set()

    async def close(self):
        self.done.set()
        try:
            await self.sio.disconnect()
        except Exception:  # noqa: BLE001
            pass


class SelfHost:
    """Bot-Host für lokale Tests ohne Admin-Login."""

    def __init__(self, args):
        self.args = args
        self.sio = socketio.AsyncClient()
        self.code_ready = asyncio.Event()
        self.code = None
        self.players = 0

        @self.sio.on("game_created")
        async def created(data):
            self.code = data["code"]
            self.code_ready.set()

        @self.sio.on("player_joined")
        async def joined(data):
            self.players = len(data.get("players", []))

        @self.sio.on("auth_required")
        async def auth_required(data):
            print("!! Server verlangt Admin-Login – --self-host geht nur ohne ADMIN_PASSWORD.")

        @self.sio.on("show_results")
        async def results(data):
            await asyncio.sleep(self.args.results_pause)
            await self.sio.emit("next_question_request", {"code": self.code})

    async def create(self):
        await self.sio.connect(self.args.url, transports=["websocket"], headers={"Origin": self.args.url})
        await self.sio.emit("create_game", {"quiz_id": self.args.quiz_id})
        await asyncio.wait_for(self.code_ready.wait(), 10)
        return self.code

    async def start(self):
        await self.sio.emit("start_game", {"code": self.code})


async def lag_monitor(stats, stop, interval=0.05):
    """Misst, ob dieses Skript selbst hinterherhinkt (dann sind seine Messwerte zu pessimistisch)."""
    loop = asyncio.get_running_loop()
    while not stop.is_set():
        t = loop.time()
        await asyncio.sleep(interval)
        lag = loop.time() - t - interval
        if lag > 0.05:
            stats.loop_lag.append((time.monotonic() - stats.t0, lag))


async def reporter(bots, stats, stop):
    t0 = time.monotonic()
    while not stop.is_set():
        await asyncio.sleep(5)
        connected = sum(1 for b in bots if b.sio.connected)
        q = max(stats.answers_arrivals or {0: 0})
        now = time.monotonic() - stats.t0
        lag = max((l for t, l in stats.loop_lag if t > now - 5), default=0)
        print(f"[{time.monotonic() - t0:5.0f}s] Skript-Lag {lag * 1000:5.0f} ms | verbunden {connected:3d}/{len(bots)} | "
              f"beigetreten {stats.joined:3d} | Frage {q} | Abbrüche {stats.disconnects} | "
              f"Antworten gesendet {sum(stats.answers_sent.values())}", flush=True)


def spread(arrivals):
    """Frage -> (p95-Abstand zum Ersten, max-Abstand, langsamster Bot)."""
    out = {}
    for q, v in arrivals.items():
        if len(v) < 2:
            continue
        first = min(t for t, _ in v)
        deltas = [t - first for t, _ in v]
        t_last, slowest = max(v)
        out[q] = (pct(deltas, 95), t_last - first, slowest)
    return out


def print_summary(args, stats: Stats, duration):
    print("\n" + "=" * 72)
    print(f"ERGEBNIS – {args.players} Bots gegen {args.url}  (Dauer {duration:.0f}s)")
    print("=" * 72)
    print(f"Verbunden:        {len(stats.connect_times)}/{args.players}   Verbindungsfehler: {len(stats.connect_errors)}")
    print(f"Beigetreten:      {stats.joined}/{args.players}   Beitrittsfehler:   {len(stats.join_errors)}"
          f"   (davon alte Plätze übernommen: {stats.slot_takeovers})")
    print(f"Spielende erhalten: {stats.ended}/{args.players}")
    print(f"Abbrüche/Reconnects: {stats.disconnects}/{stats.reconnects}")
    print(f"Verbindungsaufbau:  {fmt_ms(stats.connect_times)}")
    print(f"Beitritt (join):    {fmt_ms(stats.join_times)}")
    print(f"Antwort-Roundtrip:  {fmt_ms(stats.answer_rtts)}  (n={len(stats.answer_rtts)})")
    print("\nPro Frage – wie lange es dauert, bis ALLE Bots das Event haben (erster → letzter):")
    rs, as_, res = spread(stats.reading_arrivals), spread(stats.answers_arrivals), spread(stats.result_arrivals)
    print("  (Werte: p95 / max in ms, dahinter der langsamste Bot; Nachlieferungen nach Reconnect herausgerechnet)")
    print(f"  {'Frage':>5} | {'Frage gezeigt':>22} | {'Antworten':>22} | {'Ergebnis':>22} | erhalten | gesendet")
    for q in sorted(set(stats.answers_arrivals) | set(stats.result_arrivals)):
        def ms(d):
            if q not in d:
                return "–"
            p95, mx, who = d[q]
            return f"{p95 * 1000:4.0f}/{mx * 1000:5.0f} {who}"
        print(f"  {q:>5} | {ms(rs):>22} | {ms(as_):>22} | {ms(res):>22} | "
              f"{len(stats.answers_arrivals.get(q, [])):>8} | {stats.answers_sent.get(q, 0):>8}")
    if stats.replays:
        print("\nNach Reconnect nachgeschickt (nicht mitgezählt):")
        for q, ev, who in stats.replays:
            print(f"   Frage {q}: {ev} an {who}")
    if stats.disconnect_log:
        print("\nVerbindungsabbrüche:")
        for t, who, q, reason in stats.disconnect_log:
            print(f"   {t:6.1f}s  {who}  Frage {q}  Grund {reason}")
    if stats.other_events:
        print("\nEvents, die die Bots bekommen, aber nicht brauchen (Summe über alle Bots):")
        for ev, (n, b) in sorted(stats.other_events.items(), key=lambda x: -x[1][1]):
            print(f"   {ev:22s} {n:7d}×  {b / 1e6:7.2f} MB")
    lags = [l for _, l in stats.loop_lag]
    worst = max(stats.loop_lag, key=lambda x: x[1], default=None)
    print(f"\nSkript-Lag (eigene Event-Loop >50 ms): {len(lags)}×"
          + (f", schlimmster {worst[1] * 1000:.0f} ms bei {worst[0]:.1f}s" if worst else ""))
    for label, errs in (("Verbindungsfehler", stats.connect_errors), ("Beitrittsfehler", stats.join_errors)):
        if errs:
            print(f"\n{label} (erste 10):")
            for e in errs[:10]:
                print("  ", e)


async def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default="http://localhost:8000")
    p.add_argument("--code", help="Spielcode (wenn du im Browser hostest)")
    p.add_argument("--self-host", action="store_true", help="Skript hostet selbst (nur ohne Admin-Login)")
    p.add_argument("--quiz-id", type=int, default=0)
    p.add_argument("--players", type=int, default=100)
    p.add_argument("--ramp", type=float, default=10, help="Sekunden, über die die Beitritte verteilt werden")
    p.add_argument("--min-delay", type=float, default=1.0, help="frühester Antwortzeitpunkt (s)")
    p.add_argument("--max-delay", type=float, default=8.0, help="spätester Antwortzeitpunkt (s)")
    p.add_argument("--skip-rate", type=float, default=0.0, help="Anteil Fragen, die ein Bot nicht beantwortet")
    p.add_argument("--results-pause", type=float, default=3.0, help="Self-Host: Pause auf dem Ergebnisbildschirm")
    p.add_argument("--prefix", default="Bot")
    p.add_argument("--polling", action="store_true", help="erst Long-Polling, dann Upgrade (wie der Browser)")
    args = p.parse_args()
    args.url = args.url.rstrip("/")
    args.transports = ["polling", "websocket"] if args.polling else ["websocket"]

    host = None
    if args.self_host:
        host = SelfHost(args)
        args.code = await host.create()
        print(f"Spiel {args.code} angelegt (Self-Host)")
    if not args.code:
        p.error("--code oder --self-host angeben")
    args.code = args.code.strip().upper()

    stats = Stats()
    bots = [Bot(i + 1, args, stats) for i in range(args.players)]
    stop = asyncio.Event()
    rep = asyncio.create_task(reporter(bots, stats, stop))
    lagt = asyncio.create_task(lag_monitor(stats, stop))
    t_start = time.monotonic()

    async def start_bot(b, delay):
        await asyncio.sleep(delay)
        await b.run()

    print(f"Verbinde {args.players} Bots mit {args.url}, Spiel {args.code} (Ramp-up {args.ramp:.0f}s) …")
    await asyncio.gather(*(start_bot(b, i * args.ramp / max(1, args.players)) for i, b in enumerate(bots)))
    print(f"Lobby: {stats.joined} Bots beigetreten.")

    if host:
        await asyncio.sleep(1)
        print(f"Starte Spiel (Host sieht {host.players} Spieler) …")
        await host.start()
    elif stats.joined:
        print(">>> Jetzt im Browser das Quiz starten. Das Skript läuft bis zum Spielende (Strg+C bricht ab).")

    try:
        await asyncio.gather(*(b.done.wait() for b in bots))
    except asyncio.CancelledError:
        pass
    finally:
        stop.set()
        rep.cancel()
        lagt.cancel()
        print_summary(args, stats, time.monotonic() - t_start)
        await asyncio.gather(*(b.close() for b in bots))
        if host:
            await host.sio.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

"""Test für die Abstimmung: N Personen melden sich an, stimmen ab, das Ergebnis wird geprüft.

Neben der Last werden die Regeln der Abstimmung geprüft:
  - Abstimmen vor dem Öffnen wird abgelehnt
  - ein Name kann nicht doppelt belegt werden
  - jede Person hat genau eine Stimme, die sie bis zum Ende ändern kann
  - ungültige Optionen werden ignoriert
  - nach Verbindungsabbruch (Token oder Name) bleibt die Stimme erhalten
  - nach dem Beenden wird keine Stimme mehr angenommen
  - das Ergebnis (Stimmen je Option, Sieger, Summe) stimmt exakt mit den abgegebenen Stimmen überein
  - alle Personen bekommen das Ergebnis

Lokal ohne ADMIN_PASSWORD legt das Skript die Abstimmung selbst an, öffnet und beendet sie:

    uv run --with "python-socketio[asyncio_client]" tools/votetest.py --url http://localhost:8000 --self-host

Gegen den Server mit Login: Abstimmung im Browser (/vote) anlegen, Code übergeben, sobald alle
in der Liste sind „Abstimmung öffnen“, nach den Stimmen „Abstimmung beenden“:

    uv run --with "python-socketio[asyncio_client]" tools/votetest.py \\
        --url https://quiz.benjamin-stahl.de --code ABC123
"""

import argparse
import asyncio
import random
import statistics
import sys
import time
from collections import Counter

import socketio


def ms(values):
    if not values:
        return "–"
    v = sorted(values)
    p95 = v[min(len(v) - 1, round(0.95 * (len(v) - 1)))]
    return f"median {statistics.median(v) * 1000:.0f} ms | p95 {p95 * 1000:.0f} ms | max {v[-1] * 1000:.0f} ms"


class Voter:
    def __init__(self, idx, args, log):
        self.idx = idx
        self.args = args
        self.log = log
        self.name = f"{args.prefix}{idx:02d}"
        self.sio = socketio.AsyncClient(reconnection=False)
        self.token = None
        self.state = None
        self.options = []
        self.acked_vote = None        # letzte vom Server bestätigte Stimme
        self.my_vote_on_join = None   # was der Server beim (Wieder-)Beitritt als meine Stimme meldet
        self.errors = []
        self.results = None
        self.vote_sent_at = None
        self.vote_rtts = []
        self.joined = asyncio.Event()
        self.opened = asyncio.Event()
        self.closed = asyncio.Event()
        self.ack = asyncio.Event()
        self.error_event = asyncio.Event()
        self._register()

    def _register(self):
        s = self.sio

        @s.on("poll_joined")
        async def poll_joined(data):
            self.token = data.get("player_token")
            self.state = data.get("state")
            self.options = data.get("options") or []
            self.my_vote_on_join = data.get("my_vote")
            if self.state == "open":
                self.opened.set()
            if self.state == "closed":
                self.results = data.get("results")
                self.closed.set()
            self.joined.set()

        @s.on("poll_state")
        async def poll_state(data):
            self.state = data.get("state")
            if self.state == "open":
                self.opened.set()
            elif self.state == "closed":
                self.results = data.get("results")
                self.closed.set()

        @s.on("vote_saved")
        async def vote_saved(data):
            self.acked_vote = data.get("option")
            if self.vote_sent_at is not None:
                self.vote_rtts.append(time.monotonic() - self.vote_sent_at)
                self.vote_sent_at = None
            self.ack.set()

        @s.on("error")
        async def error(data):
            self.errors.append((data or {}).get("message", str(data)))
            self.error_event.set()
            self.joined.set()  # Beitritt beendet (mit Fehler)

        @s.on("poll_deleted")
        async def poll_deleted(_data):
            self.closed.set()

    async def connect(self):
        await self.sio.connect(self.args.url, transports=["websocket"],
                               headers={"Origin": self.args.url}, wait_timeout=20)

    async def join(self):
        t0 = time.monotonic()
        await self.sio.emit("join_game", {"code": self.args.code, "name": self.name})
        await asyncio.wait_for(self.joined.wait(), 20)
        return time.monotonic() - t0

    async def vote(self, option, wait=True):
        self.ack.clear()
        self.vote_sent_at = time.monotonic()
        await self.sio.emit("cast_vote", {"code": self.args.code, "option": option})
        if wait:
            await asyncio.wait_for(self.ack.wait(), 10)

    async def expect_error(self, coro, timeout=3):
        """Führt coro aus und wartet auf eine Fehlermeldung; gibt sie zurück (oder None)."""
        self.error_event.clear()
        before = len(self.errors)
        await coro
        try:
            await asyncio.wait_for(self.error_event.wait(), timeout)
        except asyncio.TimeoutError:
            return None
        return self.errors[before] if len(self.errors) > before else None


class Host:
    """Nur lokal: legt die Abstimmung an, öffnet und beendet sie."""

    def __init__(self, args):
        self.args = args
        self.sio = socketio.AsyncClient()
        self.code = None
        self.view = {}
        self.created = asyncio.Event()
        self.updates = 0

        @self.sio.on("poll_created")
        async def created(data):
            self.code = data["code"]
            self.created.set()

        @self.sio.on("poll_host_update")
        async def update(data):
            self.view = data
            self.updates += 1

        @self.sio.on("poll_error")
        async def poll_error(data):
            print("!! poll_error:", data)

        @self.sio.on("auth_required")
        async def auth_required(_data):
            print("!! Server verlangt Admin-Login – --self-host geht nur ohne ADMIN_PASSWORD.")

    async def create(self, n_options):
        await self.sio.connect(self.args.url, transports=["websocket"], headers={"Origin": self.args.url})
        options = [{"name": f"Haus {i + 1}", "detail": f"Team {chr(65 + i)}"} for i in range(n_options)]
        await self.sio.emit("create_poll", {"title": "Lasttest Abstimmung", "options": options})
        await asyncio.wait_for(self.created.wait(), 10)
        return self.code

    async def emit(self, event):
        await self.sio.emit(event, {"code": self.code})


class Checks:
    def __init__(self):
        self.rows = []

    def add(self, ok, label, detail=""):
        self.rows.append((bool(ok), label, detail))
        mark = "OK  " if ok else "FAIL"
        print(f"  [{mark}] {label}" + (f" – {detail}" if detail else ""), flush=True)

    @property
    def failed(self):
        return [r for r in self.rows if not r[0]]


async def wait_all(events, timeout, label):
    try:
        await asyncio.wait_for(asyncio.gather(*(e.wait() for e in events)), timeout)
        return True
    except asyncio.TimeoutError:
        print(f"!! Zeitüberschreitung: {label} ({sum(e.is_set() for e in events)}/{len(events)})")
        return False


async def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default="http://localhost:8000")
    p.add_argument("--code", help="Code einer im Browser angelegten Abstimmung")
    p.add_argument("--self-host", action="store_true", help="Skript legt die Abstimmung selbst an (nur ohne Login)")
    p.add_argument("--voters", type=int, default=51)
    p.add_argument("--options", type=int, default=8, help="Anzahl Optionen bei --self-host")
    p.add_argument("--ramp", type=float, default=5, help="Sekunden, über die die Anmeldungen verteilt werden")
    p.add_argument("--vote-window", type=float, default=8, help="Sekunden, über die die Stimmen verteilt werden")
    p.add_argument("--prefix", default="Wähler")
    p.add_argument("--seed", type=int, default=51)
    p.add_argument("--keep", action="store_true", help="Abstimmung am Ende nicht löschen (--self-host)")
    args = p.parse_args()
    args.url = args.url.rstrip("/")
    rng = random.Random(args.seed)
    checks = Checks()
    t_start = time.monotonic()

    host = None
    if args.self_host:
        host = Host(args)
        args.code = await host.create(args.options)
        print(f"Abstimmung {args.code} angelegt (Self-Host, {args.options} Optionen)")
    if not args.code:
        p.error("--code oder --self-host angeben")
    args.code = args.code.strip().upper()

    voters = [Voter(i + 1, args, None) for i in range(args.voters)]

    # ---------- Anmelden ----------
    print(f"\n1) {args.voters} Personen melden sich bei {args.url} an (Abstimmung {args.code}) …")
    join_times, connect_errors = [], []

    async def connect_and_join(v, delay):
        await asyncio.sleep(delay)
        try:
            await v.connect()
            join_times.append(await v.join())
        except Exception as e:  # noqa: BLE001
            connect_errors.append(f"{v.name}: {e!r}")

    await asyncio.gather(*(connect_and_join(v, i * args.ramp / max(1, args.voters)) for i, v in enumerate(voters)))
    joined = [v for v in voters if v.token]
    checks.add(len(joined) == args.voters, f"alle {args.voters} angemeldet",
               f"{len(joined)} ok, Fehler: {connect_errors[:3] + [e for v in voters for e in v.errors][:3]}"
               if len(joined) != args.voters else f"Beitritt {ms(join_times)}")
    if not joined:
        print("Niemand ist drin – Abbruch.")
        sys.exit(1)
    n_options = len(joined[0].options)
    print(f"   Abstimmung hat {n_options} Optionen, Zustand: {joined[0].state}")
    if host:
        await asyncio.sleep(0.5)
        checks.add(len(host.view.get("voters", [])) == args.voters, "Host sieht alle Personen",
                   f"{len(host.view.get('voters', []))} in der Liste")

    # ---------- Regeln vor dem Öffnen ----------
    print("\n2) Regeln vor dem Öffnen")
    v1 = joined[0]
    if v1.state == "lobby":
        msg = await v1.expect_error(v1.vote(0, wait=False))
        checks.add(msg and "nicht begonnen" in msg, "Abstimmen vor dem Öffnen wird abgelehnt", repr(msg))
    else:
        print("   (übersprungen – Abstimmung war schon offen)")

    dup = Voter(joined[1].idx, args, None)  # gleicher Name wie Person 2, die verbunden ist
    await dup.connect()
    await dup.join()
    checks.add(any("vergeben" in e for e in dup.errors), "doppelter Name wird abgelehnt", repr(dup.errors[:1]))
    await dup.sio.disconnect()

    # ---------- Öffnen ----------
    if host:
        print("\n3) Host öffnet die Abstimmung")
        await host.emit("open_poll")
    else:
        print("\n3) >>> Jetzt im Browser „Abstimmung öffnen“ klicken (Skript wartet bis zu 10 Minuten) …")
    t_open = time.monotonic()
    if not await wait_all([v.opened for v in joined], 600, "Öffnen"):
        sys.exit(1)
    checks.add(True, "alle haben „Abstimmung offen“ bekommen", f"nach {time.monotonic() - t_open:.1f}s")

    # ---------- Abstimmen ----------
    print(f"\n4) {len(joined)} Stimmen über {args.vote_window:.0f}s verteilt (ein Teil ändert die Stimme)")
    # Gewichtete Verteilung, damit es einen klaren Sieger gibt; Ergebnis kennt nur das Skript
    weights = [max(1, n_options - i) ** 2 for i in range(n_options)]
    rng.shuffle(weights)
    final_choice = {v.name: rng.choices(range(n_options), weights)[0] for v in joined}
    changers = set(rng.sample([v.name for v in joined], k=min(10, len(joined))))
    invalid_tester = joined[2]

    async def cast(v):
        await asyncio.sleep(rng.uniform(0, args.vote_window))
        if v is invalid_tester:
            for bad in (99, -1, "1", True, None):
                await v.sio.emit("cast_vote", {"code": args.code, "option": bad})
            await asyncio.sleep(0.5)
            checks.add(v.acked_vote is None, "ungültige Optionen werden ignoriert",
                       f"bestätigt: {v.acked_vote!r}")
        if v.name in changers:
            first = (final_choice[v.name] + 1) % n_options
            await v.vote(first)
            await asyncio.sleep(rng.uniform(0.2, 1.5))
        await v.vote(final_choice[v.name])
        await v.vote(final_choice[v.name])  # Doppelklick: zählt trotzdem nur einmal

    await asyncio.gather(*(cast(v) for v in joined))
    all_rtts = [r for v in joined for r in v.vote_rtts]
    checks.add(all(v.acked_vote == final_choice[v.name] for v in joined),
               "jede Stimme wurde bestätigt", f"{len(all_rtts)} Bestätigungen, {ms(all_rtts)}")
    if host:
        await asyncio.sleep(0.5)
        checks.add(host.view.get("votes_cast") == len(joined), "Host zählt jede Person einmal",
                   f"votes_cast={host.view.get('votes_cast')} bei {len(joined)} Personen "
                   f"({len(changers)} haben umgestimmt, alle doppelt geklickt)")

    # ---------- Verbindungsabbruch ----------
    print("\n5) Verbindungsabbrüche")
    v4, v5 = joined[3], joined[4]
    # a) mit gespeichertem Token zurück (wie Neuladen auf dem Handy)
    old_token = v4.token
    await v4.sio.disconnect()
    v4.sio = socketio.AsyncClient(reconnection=False)
    v4.joined.clear()
    v4._register()
    await v4.connect()
    await v4.sio.emit("reconnect_player", {"code": args.code, "name": v4.name, "token": old_token})
    await asyncio.wait_for(v4.joined.wait(), 10)
    checks.add(v4.my_vote_on_join == final_choice[v4.name], "Rückkehr mit Token: Stimme bleibt",
               f"Server meldet {v4.my_vote_on_join}, abgegeben {final_choice[v4.name]}")
    # b) Name neu eintippen (anderes Handy) nach Abbruch
    await v5.sio.disconnect()
    await asyncio.sleep(0.3)
    v5b = Voter(v5.idx, args, None)
    await v5b.connect()
    await v5b.join()
    checks.add(not v5b.errors and v5b.my_vote_on_join == final_choice[v5.name],
               "Rückkehr per Name: Platz und Stimme bleiben",
               f"Fehler {v5b.errors}, Server meldet {v5b.my_vote_on_join}")
    voters_live = [v for v in joined if v is not v5] + [v5b]

    # ---------- Beenden ----------
    if host:
        print("\n6) Host beendet die Abstimmung")
        await host.emit("close_poll")
    else:
        print("\n6) >>> Jetzt im Browser „Abstimmung beenden“ klicken (Skript wartet bis zu 10 Minuten) …")
    if not await wait_all([v.closed for v in voters_live], 600, "Ergebnis"):
        sys.exit(1)
    got_results = [v for v in voters_live if v.results]
    checks.add(len(got_results) == len(voters_live), "alle haben das Ergebnis bekommen",
               f"{len(got_results)}/{len(voters_live)}")

    late = joined[5]
    msg = await late.expect_error(late.vote((final_choice[late.name] + 1) % n_options, wait=False))
    checks.add(msg and "beendet" in msg, "Stimme nach dem Beenden wird abgelehnt", repr(msg))

    # ---------- Ergebnis prüfen ----------
    print("\n7) Ergebnis prüfen")
    res = got_results[0].results
    expected = Counter(final_choice.values())
    server_counts = {r["index"]: r["votes"] for r in res["ranking"]}
    foreign = res["total_votes"] - len(joined)
    if foreign:
        print(f"   Hinweis: {foreign} Stimme(n) kamen nicht von den Bots (z. B. vom eigenen Handy).")
    mismatch = {i: (expected.get(i, 0), server_counts.get(i, 0)) for i in range(n_options)
                if expected.get(i, 0) != server_counts.get(i, 0)}
    checks.add(not mismatch if not foreign else True, "Stimmen je Option stimmen exakt",
               "Abweichungen (erwartet, Server): " + str(mismatch) if mismatch else
               ", ".join(f"{joined[0].options[i]['name']}: {expected.get(i, 0)}" for i in range(n_options)))
    checks.add(res["total_votes"] == len(joined) + max(foreign, 0), "Summe der Stimmen",
               f"{res['total_votes']} bei {len(joined)} Personen")
    best = max(expected.values())
    exp_winners = sorted(i for i, c in expected.items() if c == best)
    checks.add(sorted(res["winners"]) == exp_winners or foreign, "Sieger korrekt",
               ", ".join(joined[0].options[i]["name"] for i in res["winners"]) + f" mit {best} Stimmen")
    same = all(v.results == res for v in got_results)
    checks.add(same, "alle sehen dasselbe Ergebnis")
    ranks = [r["place"] for r in res["ranking"]]
    checks.add(ranks == sorted(ranks) and ranks[0] == 1, "Platzierung aufsteigend ab Platz 1", str(ranks))

    if host and not args.keep:
        await host.emit("delete_poll")
        await asyncio.sleep(0.3)

    # ---------- Zusammenfassung ----------
    print("\n" + "=" * 70)
    print(f"ERGEBNIS – {len(joined)} Personen, {n_options} Optionen, {time.monotonic() - t_start:.0f}s")
    print("=" * 70)
    for r in res["ranking"]:
        bar = "█" * r["votes"]
        print(f"  Platz {r['place']:>2}  {r['name']:<20} {r['votes']:>3}  {bar}")
    print(f"\nAnmeldung:      {ms(join_times)}")
    print(f"Stimme → OK:    {ms(all_rtts)}")
    if host:
        print(f"Host-Updates:   {host.updates}")
    print(f"\nPrüfungen: {len(checks.rows) - len(checks.failed)}/{len(checks.rows)} bestanden")
    for ok, label, detail in checks.failed:
        print(f"  FEHLER: {label} – {detail}")

    for v in voters_live + [host] if host else voters_live:
        try:
            await v.sio.disconnect()
        except Exception:  # noqa: BLE001
            pass
    sys.exit(1 if checks.failed else 0)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

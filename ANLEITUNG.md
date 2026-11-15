# SmartQuiz – Aufbau & Funktionsweise

Kahoot-artiges Multiplayer-Quiz: ein **Host** (Beamer) steuert das Spiel, **Spieler** antworten am Handy. Alles läuft über einen Python-Server mit WebSockets.

## Lokal starten

```bash
uv sync                 # Abhängigkeiten installieren (holt bei Bedarf Python ≥ 3.10)
uv run python main.py   # Server auf http://localhost:8000 (anderer Port: PORT=9000 uv run python main.py)
```

| URL | Wer | Zweck |
|---|---|---|
| `/host` | Beamer/Laptop | Quiz wählen, Lobby mit QR-Code, Spiel steuern |
| `/` | Handys | Mit Code + Name beitreten, antworten |
| `/creator` | Quiz-Autor | Eigene Quizze bauen, speichern, als JSON exportieren |

Handys im selben WLAN erreichen den Server über die IP des Rechners (z. B. `http://192.168.x.x:8000`). Der QR-Code nutzt automatisch die Adresse, mit der `/host` geöffnet wurde. Öffne `/host` darum über die IP und nicht über `localhost`, sonst zeigt der QR-Code auf `localhost`.

## Dateien

```
main.py          Server: FastAPI (HTTP) + python-socketio (Echtzeit), komplette Spiellogik
auth.py          Admin-Login: Passwort, signiertes Cookie, Schutz der Host-Befehle
poll.py          Abstimmung (SmartVote): Optionen, Stimmen, Auswertung
database.py      SQLite-Persistenz (quizknaller.db): Spiele, Spieler, Antworten, Abstimmungen
quizzes.json     Eingebaute Quizze (Titel + Fragen)
static/
  host.html/js/css     Beamer-Ansicht
  vote.html/js/css     Beamer-Ansicht der Abstimmung (/vote)
  player.html/js/css   Handy-Ansicht
  creator.html/js/css  Quiz-Editor (rein im Browser, speichert in localStorage)
  sounds.js, host.mp3  Soundeffekte & Hintergrundmusik
passenger_wsgi.py  Einstieg für Netcup-Hosting · render.yaml  Einstieg für Render
```

## Architektur

```
 Handy (player.js) ──┐                     ┌── games{} im RAM (aktiver Zustand)
                     ├─ Socket.IO ─ main.py ┤
 Beamer (host.js) ───┘                     └── SQLite (Wiederherstellung nach Reload/Neustart)
```

- **Der Server ist die Autorität.** Er kennt die richtigen Antworten, misst die Antwortzeit und berechnet die Punkte. Spieler bekommen die richtige Antwort erst nach der Auflösung.
- Jedes Spiel hat einen 6-stelligen **Code** und einen Socket.IO-Raum mit diesem Namen.
- Der Host bekommt beim Erstellen ein geheimes **Host-Token** (im localStorage). Nur damit kann er nach einem Reload die Kontrolle zurückholen.

## Spielablauf (Zustände)

```
lobby → starting (3 s Countdown) → reading → question → results ─┐
                                      ▲                          │ „Nächste Frage“ / Autoplay
                                      └──────────────────────────┘
                                   nach der letzten Frage → ended
```

1. **lobby**: Spieler treten mit Code + Name bei, Namen sind pro Spiel eindeutig. Der Host kann Teams und Auto-Remove einstellen.
2. **reading**: Nur die Frage wird angezeigt. Die Lesezeit hängt von der Textlänge ab (2–8 s).
3. **question**: Die Antworten erscheinen und der Timer läuft (pro Frage 5–120 s). Die Frage endet, wenn alle geantwortet haben, der Host-Timer abläuft oder spätestens der Server-Timer greift.
4. **results**: Der Beamer zeigt Verteilung und Rangliste, jedes Handy sein eigenes Ergebnis. Mit Autoplay geht es nach 10 s automatisch weiter.
5. **ended**: Podium und Konfetti. Danach kann der Host über „Neues Quiz“ ein anderes Quiz für **dieselben Spieler** starten, ohne neuen Code.

## Punkte

- Richtig: **500–1000 Punkte**, je schneller, desto mehr (linear über das Zeitlimit).
- **Serie**: ab der 2. richtigen Antwort in Folge +50 pro Serienstufe, maximal +200.
- Falsch oder keine Antwort: 0 Punkte, die Serie wird zurückgesetzt.
- **Team-Modus**: Die Teamwertung ist die Summe der besten *N* Spieler jedes Teams (N stellt der Host ein).

## Verbindungsabbrüche

| Situation | Verhalten |
|---|---|
| Spieler lädt in der Lobby neu | tritt automatisch wieder bei |
| Spieler verliert kurz die Verbindung (Standby, WLAN-Wechsel) | Handy meldet sich nach dem automatischen Neuverbinden selbst wieder an, kein Reload nötig |
| Spieler kommt mitten in einer Frage zurück | Server schickt die laufende Frage nach: in der Lesezeit den Fragetext, in der Antwortzeit auch die Antworten mit der Restzeit. Wer schon geantwortet hat, sieht „beantwortet“ und kann nicht doppelt antworten |
| Spieler lädt im Spiel neu oder öffnet die Seite erneut | Punkte bleiben erhalten; Wiedereinstieg mit gespeicherter Sitzung oder gleichem Namen |
| Host lädt neu | übernimmt per Token wieder, der aktuelle Bildschirm wird wiederhergestellt |
| Host länger als 60 s weg | Spiel endet für alle |
| Server-Neustart | Spiele werden aus SQLite geladen; eine laufende Frage wird übersprungen, der Host macht mit „Weiter“ weiter |
| Auto-Remove aktiv | Wer X Fragen in Folge nicht antwortet, fliegt raus und bekommt einen Hinweis |

Spiele, die älter als 24 h sind, löscht der Server beim Start.

## Login (Admin-Bereich)

`/host`, `/vote` und `/creator` sind nur mit Passwort erreichbar; die Spielerseite `/` bleibt offen. Nach dem Anmelden bleibt das Gerät 30 Tage angemeldet, „Abmelden“ steht auf der Quiz-Auswahl und bei der Abstimmung.

- **Passwort setzen (Server):** in `~/quizknaller/.env` (nicht im Git):
  ```bash
  umask 077; echo 'ADMIN_PASSWORD=dein-passwort' > ~/quizknaller/.env
  ```
  danach `./deploy/deploy.sh`. Ohne Passwort (mind. 8 Zeichen) bricht das Deploy-Skript ab, bevor es etwas ändert.
- **Passwort ändern** meldet alle Geräte ab. Ein Neustart/Deploy tut das nicht.
- **Geschützt sind auch die Befehle selbst**, nicht nur die Seiten: Spiel erstellen/starten/beenden, Abstimmung erstellen/öffnen/beenden/löschen usw. werden vom Server ohne gültiges Admin-Cookie ignoriert.
- **Fehlversuche:** nach 8 falschen Passwörtern ist die Anmeldung von dieser IP für 15 Minuten gesperrt.
- **Lokal** ohne `ADMIN_PASSWORD` ist der Login aus (Hinweis im Terminal). Zum Ausprobieren: `ADMIN_PASSWORD=test1234 uv run python main.py`.

## Sicherheit

- **Host und Spieler haben je einen geheimen Token** (im `localStorage` des Geräts). Nur damit lässt sich eine laufende Verbindung übernehmen – Spiel-Code und Name allein reichen nicht, weil beides auf dem Beamer steht. Ohne Token klappt der Wiedereinstieg mit gleichem Namen nur, wenn der Spieler wirklich getrennt ist.
- **Obergrenzen:** 200 Fragen pro Quiz, Titel 100 / Frage 300 / Antwort 150 Zeichen, 200 Spieler pro Spiel, 300 gleichzeitige Spiele, 20 Teams.
- **Produktion:** Socket.IO nimmt nur Verbindungen von `https://quiz.benjamin-stahl.de` an (`CORS_ORIGINS` in `docker-compose.prod.yml`); die App setzt `X-Frame-Options`, `X-Content-Type-Options` und `Referrer-Policy`.

## Eigene Quizze

Im **Creator** erstellen und auf „Im Browser speichern“ klicken. Das Quiz erscheint dann im selben Browser unter `/host`. Alternativ als JSON exportieren und unter `/host` per „Quiz hochladen“ importieren. Dauerhaft für alle verfügbar wird ein Quiz, wenn man es in `quizzes.json` einträgt:

```json
{ "title": "Mein Quiz", "questions": [
  { "question": "Frage?", "answers": ["A", "B", "C", "D"], "correct": 1, "time_limit": 20 }
]}
```
`correct` ist der Index der richtigen Antwort (0–3). Es gibt immer genau vier Antworten.

## Abstimmung (SmartVote)

Für Abstimmungen wie „Das schönste Lebkuchenhaus“: `/host` → **Abstimmung starten** (oder direkt `/vote`).

1. **Einrichten:** Titel und Optionen eintragen. Jede Option hat einen Namen (Pflicht) und eine optionale Zeile, z. B. wer gebaut hat. „Häuser 1–n anlegen“ füllt die Liste mit „Haus 1“ bis „Haus n“. Der Entwurf bleibt im Browser gespeichert.
2. **QR-Code anzeigen:** Es erscheint ein Code mit QR-Code, wie beim Quiz. Die Leute scannen ihn und geben ihren Namen ein; sie sehen die Optionen schon, können aber noch nicht abstimmen. Solange nicht gestartet ist, lässt sich die Liste über **Bearbeiten** noch ändern (die Handys aktualisieren sich sofort).
3. **Abstimmung starten:** Jede Person hat eine Stimme und kann sie bis zum Ende ändern. Wer später kommt, kann noch mitmachen. Der Beamer zeigt nur, *wer* schon abgestimmt hat, nicht *wofür* – das bleibt bis zum Schluss geheim.
4. **Abstimmung beenden:** Trommelwirbel 3-2-1, dann der Sieger mit Konfetti und die komplette Rangliste mit Stimmen und Prozent. Bei Gleichstand gibt es mehrere Sieger. Die Handys zeigen den Sieger und wofür man selbst gestimmt hat.

Abstimmungen werden in der Datenbank gespeichert (Tabelle `polls`) und überstehen Reload und Server-Neustart; nach 48 Stunden werden sie gelöscht. Abstimmungs-Codes und Quiz-Codes teilen sich denselben Beitritt – der Server erkennt am Code, was gemeint ist. Obergrenzen: 40 Optionen, 300 Personen pro Abstimmung.

## Socket-Events (Kurzreferenz)

**Host → Server:** `create_game`, `create_custom_game`, `switch_game_quiz`, `switch_custom_game_quiz`, `configure_teams`, `configure_auto_remove`, `start_game`, `time_up`, `next_question_request`, `autoplay_started`, `end_game_request`, `reconnect_host`
**Spieler → Server:** `join_game`, `select_team`, `submit_answer`, `reconnect_player`
**Abstimmung, Host → Server:** `create_poll`, `update_poll_options`, `open_poll`, `close_poll`, `delete_poll`, `reconnect_poll_host` · **Spieler → Server:** `join_game`/`reconnect_player` (wie beim Quiz), `cast_vote` · **Server → Clients:** `poll_created`, `poll_host_update` (Host), `poll_joined`, `poll_options`, `poll_state`, `vote_saved`, `poll_deleted`
**Server → Clients:** `game_created`, `player_joined/left/updated`, `game_starting`, `show_question_reading`, `show_answers`, `answer_update`, `show_results` (Host), `your_result` (Spieler), `game_ended`, `quiz_switched`, `host_disconnected/reconnected`, `error`

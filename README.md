# Share my Train

Unabhängiges Hobby- und Civic-Tech-Projekt: **alle Züge in Deutschland** (Fern- und Regionalverkehr, S-Bahn) live auf einer Pixelkarte mit echten Verspätungen. Dazu gibt es eine Verbindungssuche mit Umstiegsprognose für Fahrgäste und offene **Lessons learned für die Bahn** aus beobachteten Ist-Daten.

Live: https://sharemytrain.de (bis die Domain aufgeschaltet ist: https://bahnimprove-leitstand.netlify.app) · Wochenbericht: https://sharemytrain.de/bericht

> **Echte Daten.** Soll-Fahrplan und Ist-Zeiten stammen aus den offenen Feeds von gtfs.de (DELFI e.V.): GTFS für den Fahrplan (~1.000 Fernverkehrsfahrten pro Tag), GTFS-Realtime für Verspätungen, Prognosen und Ausfälle. Eine Netlify Function sammelt den Feed alle 2 Minuten, damit der ganze Tag für den Tagesbericht vorliegt. Gibt es für einen Tag keine Echtzeitdaten, schaltet die App sichtbar auf eine Simulation um.

## Was drin ist

- **Pixelkarte**: Deutschland und Nachbarländer (Natural Earth), alle Fernverkehrsabschnitte, eigene 3×5-Pixelschrift. Züge sind farbcodiert nach Verspätung (grün < 6 Min, gelb, orange, rot ≥ 31 Min). Zoom, Pan und Pinch werden unterstützt.
- **Live und Zeitraffer**: Live-Uhr (Europe/Berlin) oder Replay mit 1×/60×/300×/1200×, Zeitregler, Wechsel zwischen „Gestern“ und „Heute“.
- **Leitstand-Seitenleiste**: Pünktlichkeit bis jetzt, Züge unterwegs, aktive Störungen, größte Verspätungen. Ein Klick auf einen Zug zeigt Fahrtverlauf und **Ursachenkette** („+4 Min hängt fest hinter ICE 42 …“), ein Klick auf einen Bahnhof die nächsten Abfahrten.
- **Tagesbericht**:
  - Note A–E und Bilanz (Pünktlichkeit, Fahrgast-Verspätungsstunden, verpasste Anschlüsse)
  - Vorschläge: *Anschluss halten*, *Nicht warten*, *Überholung* (verspäteten Zug den pünktlichen vorlassen). Jeder Vorschlag ist eine komplette Neusimulation des Tages mit genau dieser Änderung, danach werden die besten Entscheidungen gierig kombiniert.
  - Umschaltbares Ziel: **Pünktlichkeit** (DB-Kennzahl) oder **Fahrgäste** (Menschen statt Züge)
  - Ursachenanteile, teuerste Störungen, Knoten mit dem größten Verspätungszuwachs, „Verspätungs-Verbreiter“

### Für Fahrgäste

- **Suche** über alle Fernverkehrsfahrten des Tages: Linie („ICE 28“), Bahnhof („Köln“, auch ohne Umlaute) oder Strecke („Köln München“).
- **Standort** mit einem Tipp. Danach zeigt die App den nächsten Bahnhof mit Abfahrtstafel und trägt ihn als Start der Reise ein. Wer einmal zugestimmt hat, wird beim nächsten Besuch automatisch gefunden.
- **Reise**: Verbindungssuche im Fernverkehr mit bis zu zwei Umstiegen. Für jeden Umstieg schätzt die App aus der aktuellen Verspätung, wie wahrscheinlich er klappt. Empfohlen wird die Verbindung mit der besten *erwarteten* Ankunft, also unter Berücksichtigung, dass ein Umstieg platzen kann.

### Lessons learned für die DB

`src/insights/aggregate.ts` verdichtet jeden Tag ausschließlich **beobachtete** Ist-Werte (keine Prognosen) und addiert sie über bis zu 28 Tage:

- Fahrzeitverluste je Abschnitt → „Fahrzeit ehrlich planen oder Ursache beheben“
- Haltezeit-Überschreitungen je Bahnhof → „Haltezeit/Fahrgastwechsel“
- Verspätete Starts je Startbahnhof → „Bereitstellung prüfen“
- Platzende Umstiege → „Übergangszeit oder Anschlusssicherung“
- Mitgebrachte Verspätung aus dem Ausland
- Abschnitte mit regelmäßiger Aufholung → „Hier steckt Reserve“

Ein Befund ist **belastbar** ab 40 Fällen aus mindestens 7 Tagen, und nur wenn er an der Mehrzahl der Tage auftritt (Dauerproblem statt Einzelstörung). Die Function `build-insights` verdichtet jede Nacht den abgeschlossenen Tag, `GET /api/insights` liefert das Ergebnis.

### Regionalverkehr in Kacheln

Rund 43.000 Regionalfahrten am Tag sind zu viel für ein Handy. Ein nächtlicher Job (`build-static-background`, ausgelöst von `refresh-static`) bereitet deshalb Fern- und Regionalverkehr aus gtfs.de auf. Der Regionalverkehr landet in Kacheln von 0,5° × 0,75°, also etwa 55 × 52 km, in Netlify Blobs. Die App lädt nur die Kacheln, die sie braucht: den sichtbaren Ausschnitt (ab Zoom 2,2), den eigenen Standort, einen Bahnhof sowie Start und Ziel einer Reise. `GET /api/rv?date=&tile=` liefert eine Kachel samt Echtzeitdaten. Die Verbindungssuche verknüpft Regionalzüge rund um Start und Ziel mit dem bundesweiten Fernverkehr.

### Verspätungsgründe

`collect-reasons` fragt alle 10 Minuten die IRIS-Schnittstelle der DB für rund 70 große Bahnhöfe ab (`public/data/iris-stations.json`, erzeugt mit `scripts/build-iris-stations.ts`). Die Funktion zählt die gemeldeten Grundcodes, etwa „Verspätung aus vorheriger Fahrt“ oder „Reparatur an der Strecke“. Die Lessons learned zeigen sie je Bahnhof und gruppiert nach Hebel: Infrastruktur, Betriebsablauf, Fahrzeuge, äußere Einflüsse.

### Offene Daten

`GET /api/open-data` (Index) bzw. `?date=YYYYMMDD` liefert die Tageswerte, `GET /api/insights` die Befunde. Die Action `open-data.yml` sichert beides jeden Montag nach [`open-data/`](open-data/) und schreibt einen lesbaren Wochenbericht.

## Starten

```bash
npm install
npm run dev        # http://localhost:5173
npm test
npm run build      # statisches Bundle in dist/
npm run data       # Fahrpläne (gtfs.de, Fern- + Regionalverkehr) und Kartengrenzen neu erzeugen
npm run realtime   # Echtzeit einmal abrufen → public/data/realtime/YYYYMMDD.json
npm run realtime -- --watch   # lokal alle 2 Minuten sammeln
```

### Echtzeit in Produktion (Netlify)

- `netlify/functions/collect-realtime.mts`: geplante Function (alle 2 Min.). Sie lädt `https://realtime.gtfs.de/realtime-free.pb` (~7 MB), filtert die Fernverkehrsfahrten und schreibt je Verkehrstag ein JSON in Netlify Blobs.
- `netlify/functions/realtime.mts`: `GET /api/realtime?date=YYYYMMDD` liefert die gesammelten Daten (60 s CDN-Cache).
- Das Frontend fragt zuerst `/api/realtime`, dann `data/realtime/DATUM.json` (lokal). Fehlt beides, startet es die Simulation.

Die Fahrt-IDs im Echtzeitfeed gehören zur jeweils aktuellen Fahrplanversion von gtfs.de. Deshalb lädt die Action `timetable.yml` den Fahrplan täglich neu, und Netlify baut danach automatisch neu.

Der Fahrplan in `public/data/timetable.json` deckt gestern plus 14 Tage ab. Die GitHub Action `timetable.yml` aktualisiert ihn täglich. Liegt das heutige Datum außerhalb, fällt die App auf den gleichen Wochentag zurück und zeigt einen Hinweis.

## Aufbau

```
scripts/build-timetable.ts   GTFS (gtfs.de Fernverkehr) → kompakter Fahrplan je Verkehrstag
scripts/build-map.ts         Natural Earth → Landesgrenzen
src/sim/model.ts             Verkehrstag: Fahrten, Anschlüsse, Störungen, fest gewürfelte Zufallswerte
src/sim/engine.ts            Ereignisbasierte Simulation (Zugfolge, Überholverbot, Reserven, Anschlüsse)
src/sim/analysis.ts          Kennzahlen, Gegenrechnung, Tagesbericht
src/sim/live.ts              Zugpositionen, Brennpunkte und Kennzahlen zu einem Zeitpunkt
src/sim/real.ts              Ist-Zeiten aus Echtzeitdaten, Nachspielen echter Tage
src/realtime/                GTFS-Realtime lesen und je Tag zusammenführen
netlify/functions/           Sammler (alle 2 Min.) und /api/realtime
src/ui/map.ts                Pixel-Renderer (eigener Rasterizer, kein Kartenframework)
src/main.ts                  App, Zeitsteuerung, Seitenleiste
```

**Echte Tage nachspielen**: Für den Tagesbericht wird der beobachtete Tag in Verspätungszuwächse zerlegt (Startverspätung, Zuwachs je Abschnitt, Zuwachs je Halt) und mit dem Netzmodell nachgespielt. Jeder Vorschlag ist die Differenz zweier Modellläufe, übertragen auf die echten Kennzahlen.

**Simulationsmodell**: Halt-zu-Halt-Abschnitte mit 3 Min Mindestzugfolge und Überholverbot auf freier Strecke. Verspätete Züge holen bis zu 4 % Fahrzeitreserve auf. Anschlusszüge warten bis 3 Min (Standardregel), die Umsteigezeit beträgt 3 Min. Streckenstörungen wirken auf alle Abschnitte, die geografisch durch den Störungsort laufen. Fahrgastzahlen sind je Zuggattung geschätzt.

**Bewusst nicht modelliert** (deshalb sind die Vorschläge Hinweise, keine Dispositionsanweisungen): Nah- und Güterverkehr, Gleisbelegung in Bahnhöfen, Fahrzeug- und Personalumläufe, Umleitungen und Zugausfälle.

## Nächste Schritte

1. **Verspätungsgründe**: Der GTFS-Realtime-Feed enthält keine Gründe. Die IRIS-Schnittstelle der DB (wie bei bahn.expert) liefert je Bahnhof Meldungen mit Ursachencodes (Bauarbeiten, Signalstörung, Verspätung aus vorheriger Fahrt …). Die ~60 wichtigsten Knoten können ergänzend abgefragt werden.
2. **Systematische Schwachstellen**: Mit ein paar Wochen Daten lassen sich Abschnitte erkennen, auf denen bestimmte Züge täglich Minuten verlieren (Fahrplan unrealistisch).
3. **Spielmodus „Schatten-Fahrdienstleiter“**: Echte Entscheidungssituationen tagsüber („RE wartet auf ICE +7?“), abends die Auswertung gegen die Realität, mit Punkten, Rängen und Achievements.
4. **Zeitraffer-Export** des Tages als GIF bzw. Video zum Teilen.

## Betrieb auf Netlify

- Umgebungsvariable `STATIC_BUILD_SECRET` (beliebiger geheimer Wert) schützt den nächtlichen Fahrplan-Job.
- Geplante Functions: `collect-realtime` (alle 2 Min.), `collect-reasons` (alle 10 Min.), `build-insights` (nachts), `refresh-static` (nachts).
- Der kostenlose Plan reicht für ein Hobbyprojekt. Bei viel Besuch zählen vor allem die Abrufe der Regionalkacheln (CDN-Cache 2 Minuten).

## Lizenzen

- Code: [MIT](LICENSE)
- Offene Daten in `open-data/` und unter `/api/*`: CC BY-SA 4.0 (abgeleitet aus dem Echtzeit-Feed unter CC BY-SA 4.0), Quellenangabe „Share my Train (sharemytrain.de), Daten: DELFI e.V./gtfs.de, Deutsche Bahn (IRIS)“

## Datenquellen & Lizenzen

- Fahrplan: [gtfs.de](https://gtfs.de) (freie GTFS-Basisversion, Daten von DELFI e.V., CC BY 4.0, Gültigkeit 30 Tage)
- Echtzeit: [gtfs.de GTFS-Realtime](https://gtfs.de/de/realtime/) „free“, CC BY-SA 4.0 (kommerzielle Nutzung mit Namensnennung und Weitergabe unter gleichen Bedingungen erlaubt; einzelne Quellen im Feed haben laut gtfs.de eigene Vereinbarungen). Abruf nur serverseitig alle 2 Minuten.
- Landesgrenzen: [Natural Earth](https://www.naturalearthdata.com) über `world-atlas`, Public Domain
- Verspätungsgründe: öffentliche IRIS-Schnittstelle der Deutschen Bahn
- Schriften: Geist, Pixelify Sans, Silkscreen (OFL), lokal ausgeliefert über Fontsource, keine Anfragen an Google

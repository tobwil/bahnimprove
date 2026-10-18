# Bahnimprove · Leitstand Fernverkehr

Pixel-Leitstand für den deutschen Fernverkehr: eine Live-Karte aller ICE/IC/EC-Fahrten mit Verspätungen und Störungen, dazu ein **Tagesbericht**, der durchrechnet, welche Dispositionsentscheidungen die Pünktlichkeit bzw. die Fahrgastminuten verbessert hätten.

> **Stand: Prototyp.** Der Soll-Fahrplan ist echt (offener DELFI-Feed, ~1.000 Fernverkehrsfahrten pro Tag). Störungen und Verspätungen erzeugt bis zur Anbindung echter Echtzeitdaten eine Simulation. Die App kennzeichnet das sichtbar.

## Was drin ist

- **Pixelkarte**: Deutschland und Nachbarländer (Natural Earth), alle Fernverkehrsabschnitte, eigene 3×5-Pixelschrift. Züge sind farbcodiert nach Verspätung (grün < 6 Min, gelb, orange, rot ≥ 31 Min). Zoom, Pan und Pinch werden unterstützt.
- **Live und Zeitraffer**: Live-Uhr (Europe/Berlin) oder Replay mit 1×/60×/300×/1200×, Zeitregler, Wechsel zwischen „Gestern“ und „Heute“.
- **Leitstand-Seitenleiste**: Pünktlichkeit bis jetzt, Züge unterwegs, aktive Störungen, größte Verspätungen. Ein Klick auf einen Zug zeigt Fahrtverlauf und **Ursachenkette** („+4 Min hängt fest hinter ICE 42 …“), ein Klick auf einen Bahnhof die nächsten Abfahrten.
- **Tagesbericht**:
  - Note A–E und Bilanz (Pünktlichkeit, Fahrgast-Verspätungsstunden, verpasste Anschlüsse)
  - Vorschläge: *Anschluss halten*, *Nicht warten*, *Überholung* (verspäteten Zug den pünktlichen vorlassen). Jeder Vorschlag ist eine komplette Neusimulation des Tages mit genau dieser Änderung, danach werden die besten Entscheidungen gierig kombiniert.
  - Umschaltbares Ziel: **Pünktlichkeit** (DB-Kennzahl) oder **Fahrgäste** (Menschen statt Züge)
  - Ursachenanteile, teuerste Störungen, Knoten mit dem größten Verspätungszuwachs, „Verspätungs-Verbreiter“

## Starten

```bash
npm install
npm run dev        # http://localhost:5173
npm test
npm run build      # statisches Bundle in dist/
npm run data       # Fahrplan (gtfs.de) und Kartengrenzen neu erzeugen
```

Der Fahrplan in `public/data/timetable.json` deckt gestern plus 14 Tage ab. Die GitHub Action `timetable.yml` aktualisiert ihn täglich. Liegt das heutige Datum außerhalb, fällt die App auf den gleichen Wochentag zurück und zeigt einen Hinweis.

## Aufbau

```
scripts/build-timetable.ts   GTFS (gtfs.de Fernverkehr) → kompakter Fahrplan je Verkehrstag
scripts/build-map.ts         Natural Earth → Landesgrenzen
src/sim/model.ts             Verkehrstag: Fahrten, Anschlüsse, Störungen, fest gewürfelte Zufallswerte
src/sim/engine.ts            Ereignisbasierte Simulation (Zugfolge, Überholverbot, Reserven, Anschlüsse)
src/sim/analysis.ts          Kennzahlen, Gegenrechnung, Tagesbericht
src/sim/live.ts              Zugpositionen und Kennzahlen zu einem Zeitpunkt
src/ui/map.ts                Pixel-Renderer (eigener Rasterizer, kein Kartenframework)
src/main.ts                  App, Zeitsteuerung, Seitenleiste
```

**Simulationsmodell**: Halt-zu-Halt-Abschnitte mit 3 Min Mindestzugfolge und Überholverbot auf freier Strecke. Verspätete Züge holen bis zu 4 % Fahrzeitreserve auf. Anschlusszüge warten bis 3 Min (Standardregel), die Umsteigezeit beträgt 3 Min. Streckenstörungen wirken auf alle Abschnitte, die geografisch durch den Störungsort laufen. Fahrgastzahlen sind je Zuggattung geschätzt.

**Bewusst nicht modelliert** (deshalb sind die Vorschläge Hinweise, keine Dispositionsanweisungen): Nah- und Güterverkehr, Gleisbelegung in Bahnhöfen, Fahrzeug- und Personalumläufe, Umleitungen und Zugausfälle.

## Nächste Schritte

1. **Echtzeitdaten**: Account im [DB API Marketplace](https://developers.deutschebahn.com/) anlegen und die API *Timetables* abonnieren (kostenlos). Ein Collector fragt dann die ~60 wichtigsten Fernverkehrsknoten im Minutentakt ab (Plan + Änderungen), speichert Ist-Zeiten in Postgres und liefert sie der Karte per WebSocket. Die Simulation bleibt für die Gegenrechnung: Primärverspätungen werden aus den Ist-Daten geschätzt und durch dasselbe Modell geschickt.
2. **Systematische Schwachstellen**: Mit ein paar Wochen Daten lassen sich Abschnitte erkennen, auf denen bestimmte Züge täglich Minuten verlieren (Fahrplan unrealistisch).
3. **Spielmodus „Schatten-Fahrdienstleiter“**: Echte Entscheidungssituationen tagsüber („RE wartet auf ICE +7?“), abends die Auswertung gegen die Realität, mit Punkten, Rängen und Achievements.
4. **Zeitraffer-Export** des Tages als GIF bzw. Video zum Teilen.

## Datenquellen & Lizenzen

- Fahrplan: [gtfs.de](https://gtfs.de) Fernverkehr, Daten von DELFI e.V., CC BY 4.0
- Landesgrenzen: [Natural Earth](https://www.naturalearthdata.com) über `world-atlas`, Public Domain
- Schriften: Silkscreen, VT323 (Google Fonts, OFL)

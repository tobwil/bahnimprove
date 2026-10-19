# Offene Daten von Bahnimprove

Hier legt eine GitHub Action jede Woche die verdichteten Daten der Live-Seite ab. Die Ablage dient als offene Daten zum Nachprüfen und zugleich als Sicherung.

| Datei | Inhalt |
|---|---|
| `tage/YYYYMMDD.json` | Tageswerte: Fahrzeitabweichung je Abschnitt, Haltezeit je Bahnhof, Startverspätung, Umstiege, mitgebrachte Verspätung aus dem Ausland, Pünktlichkeit je Linie, gemeldete Gründe je Bahnhof. Nur beobachtete Werte, keine Prognosen. |
| `befunde.json`, `befunde.csv` | Aktuelle Lessons learned über die letzten bis zu 28 Tage mit Belastbarkeitsstufe |
| `berichte/YYYY-Www.md` | Lesbarer Wochenbericht |

Histogramme (`hist`) zählen Abweichungen in ganzen Minuten von −10 (Index 0) bis +60 (Index 70).

## Lizenz

[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.de), weil sie aus dem Echtzeit-Feed von gtfs.de (CC BY-SA 4.0) abgeleitet sind. Quellenangabe: „Bahnimprove, Daten: DELFI e.V./gtfs.de, Deutsche Bahn (IRIS)“.

Die Rohdaten stammen von [gtfs.de](https://gtfs.de): Fahrpläne der DELFI e.V. (CC BY 4.0) und der GTFS-Realtime-Feed (CC BY-SA 4.0). Verspätungsgründe kommen aus der öffentlichen IRIS-Schnittstelle der Deutschen Bahn.

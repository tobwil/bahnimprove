/** Seite "Über, Daten & Datenschutz" – Methode, Quellen, Lizenzen, Downloads. */
export function aboutPage(): string {
  return `
    <section class="card">
      <h3>Worum es geht</h3>
      <p class="fine">Bahnimprove ist ein unabhängiges Hobby- und Civic-Tech-Projekt. Es zeigt alle Züge in Deutschland live und hilft Fahrgästen bei der Planung. Außerdem wertet es offen aus, wo die Bahn Zeit verliert und was sie dagegen tun könnte. Es ist kein Angebot der Deutschen Bahn.</p>
    </section>

    <section class="card">
      <h3>Datenquellen</h3>
      <table class="table">
        <tr><td>Fahrpläne Fern- und Regionalverkehr<span class="sub">gtfs.de, Daten von DELFI e.V.</span></td><td class="num">CC BY 4.0</td></tr>
        <tr><td>Echtzeit (Verspätungen, Prognosen, Ausfälle)<span class="sub">GTFS-Realtime von gtfs.de</span></td><td class="num">CC BY 4.0</td></tr>
        <tr><td>Verspätungsgründe an großen Bahnhöfen<span class="sub">IRIS-Schnittstelle der Deutschen Bahn</span></td><td class="num">DB</td></tr>
        <tr><td>Landesgrenzen<span class="sub">Natural Earth</span></td><td class="num">gemeinfrei</td></tr>
      </table>
    </section>

    <section class="card">
      <h3>Offene Daten</h3>
      <p class="fine">Die verdichteten Tageswerte (Abschnitte, Halte, Starts, Umstiege, gemeldete Gründe) und die aktuellen Befunde gibt es zum Herunterladen und Nachprüfen, unter CC BY 4.0 mit Quellenangabe „Bahnimprove, Daten: DELFI e.V./gtfs.de, Deutsche Bahn“.</p>
      <div class="suggestion-foot" style="justify-content:flex-start">
        <a class="ghost-btn" href="api/insights" target="_blank" rel="noopener">Befunde (JSON)</a>
        <a class="ghost-btn" href="api/open-data" target="_blank" rel="noopener">Tageswerte (Index)</a>
        <a class="ghost-btn" href="https://github.com/tobwil/bahnimprove/tree/main/open-data" target="_blank" rel="noopener">Archiv auf GitHub</a>
      </div>
      <p class="fine">Quellcode: <a href="https://github.com/tobwil/bahnimprove" target="_blank" rel="noopener">github.com/tobwil/bahnimprove</a> (MIT-Lizenz).</p>
    </section>

    <section class="card">
      <h3>Datenschutz</h3>
      <p class="fine"><b>Kein Tracking, keine Cookies, keine Anmeldung.</b> Schriften und alle Daten kommen vom eigenen Server, es gibt keine Anfragen an Google oder andere Dritte.</p>
      <p class="fine"><b>Standort:</b> Wenn du auf den Standort-Knopf tippst, fragt dein Browser um Erlaubnis. Der Standort wird nur auf deinem Gerät verwendet, um den nächsten Bahnhof zu finden, und nie an den Server gesendet. Geladen werden lediglich die Fahrplandaten der Gegend (Kacheln von etwa 50 × 50 km).</p>
      <p class="fine"><b>Hosting:</b> Die Seite läuft bei Netlify. Beim Aufruf verarbeitet Netlify technisch notwendige Daten wie die IP-Adresse in Server-Protokollen.</p>
    </section>`;
}

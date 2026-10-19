/** Seite "Über, Daten & Datenschutz" – Methode, Quellen, Lizenzen, Downloads. */
export function aboutPage(): string {
  return `
    <section class="card">
      <h3>Worum es geht</h3>
      <p class="fine"><b>Share my Train</b> (sharemytrain.de) ist ein unabhängiges Hobby- und Civic-Tech-Projekt. Es zeigt alle Züge in Deutschland live und hilft Fahrgästen bei der Planung. Außerdem wertet es offen aus, wo die Bahn Zeit verliert und was sie dagegen tun könnte. Es ist kein Angebot der Deutschen Bahn.</p>
    </section>

    <section class="card">
      <h3>Datenquellen</h3>
      <table class="table">
        <tr><td>Fahrpläne Fern- und Regionalverkehr<span class="sub"><a href="https://gtfs.de/de/feeds/de_fv/" target="_blank" rel="noopener">gtfs.de</a>, Daten von DELFI e.V.</span></td><td class="num"><a href="https://creativecommons.org/licenses/by/4.0/deed.de" target="_blank" rel="noopener">CC BY 4.0</a></td></tr>
        <tr><td>Echtzeit (Verspätungen, Prognosen, Ausfälle)<span class="sub">GTFS-Realtime von <a href="https://gtfs.de/de/realtime/" target="_blank" rel="noopener">gtfs.de</a>, unverändert abgerufen und für Karte, Tafeln und Auswertungen aufbereitet</span></td><td class="num"><a href="https://creativecommons.org/licenses/by-sa/4.0/deed.de" target="_blank" rel="noopener">CC BY-SA 4.0</a></td></tr>
        <tr><td>Verspätungsgründe an großen Bahnhöfen<span class="sub">IRIS-Schnittstelle der Deutschen Bahn</span></td><td class="num">DB</td></tr>
        <tr><td>Landesgrenzen<span class="sub">Natural Earth</span></td><td class="num">gemeinfrei</td></tr>
      </table>
    </section>

    <section class="card">
      <h3>Offene Daten</h3>
      <p class="fine">Die verdichteten Tageswerte (Abschnitte, Halte, Starts, Umstiege, gemeldete Gründe) und die aktuellen Befunde gibt es zum Herunterladen und Nachprüfen, unter CC BY-SA 4.0 mit Quellenangabe „Share my Train (sharemytrain.de), Daten: DELFI e.V./gtfs.de, Deutsche Bahn“. Weil sie auf dem Echtzeit-Feed unter CC BY-SA 4.0 beruhen, gilt auch für Weiterverwendungen: Namensnennung und Weitergabe unter gleichen Bedingungen.</p>
      <div class="suggestion-foot" style="justify-content:flex-start">
        <a class="ghost-btn" href="api/insights" target="_blank" rel="noopener">Befunde (JSON)</a>
        <a class="ghost-btn" href="api/open-data" target="_blank" rel="noopener">Tageswerte (Index)</a>
        <a class="ghost-btn" href="https://github.com/tobwil/bahnimprove/tree/main/open-data" target="_blank" rel="noopener">Archiv auf GitHub</a>
      </div>
      <p class="fine">Quellcode: <a href="https://github.com/tobwil/bahnimprove" target="_blank" rel="noopener">github.com/tobwil/bahnimprove</a> (MIT-Lizenz).</p>
    </section>

    <section class="card">
      <h3>Datenschutz</h3>
      <p class="fine"><b>Kein Tracking, keine Cookies, keine Anmeldung.</b> Dein Standort bleibt auf deinem Gerät. Alles Weitere in der <a href="/datenschutz" data-legal="privacy">Datenschutzerklärung</a>.</p>
      <p class="fine">Anbieter: KIsruptiv, siehe <a href="/impressum" target="_blank" rel="noopener">Impressum</a>.</p>
    </section>

    <section class="card">
      <h3>Kein Angebot der Deutschen Bahn</h3>
      <p class="fine">Share my Train ist ein unabhängiges Civic-Tech-Projekt und steht in keiner Verbindung zur Deutschen Bahn AG. Alle Angaben ohne Gewähr: Prognosen und Umstiegschancen sind Schätzungen aus offenen Echtzeitdaten. Verbindlich sind die Angaben der Verkehrsunternehmen und die Anzeigen am Bahnsteig.</p>
    </section>`;
}

/** Datenschutzerklärung (eigene Seite unter /datenschutz) */
export function privacyPage(): string {
  return `
    <section class="card">
      <h3>Verantwortlich</h3>
      <p class="fine">Verantwortlich für die Datenverarbeitung auf sharemytrain.de und train.kisruptiv.de ist KIsruptiv. Name, Anschrift und Kontakt stehen im <a href="/impressum" target="_blank" rel="noopener">Impressum</a>.</p>
    </section>

    <section class="card">
      <h3>Kurz gesagt</h3>
      <p class="fine"><b>Kein Tracking, keine Cookies, keine Werbung, keine Anmeldung.</b> Es werden keine Profile gebildet und keine Daten an Dritte verkauft oder weitergegeben. Schriften und Daten kommen vom eigenen Server, es gibt keine Anfragen an Google oder andere Dienste.</p>
    </section>

    <section class="card">
      <h3>Hosting und Server-Protokolle</h3>
      <p class="fine">Die Seite wird bei Netlify, Inc. (San Francisco, USA) gehostet. Bei jedem Aufruf verarbeitet Netlify technisch notwendige Daten: IP-Adresse, Zeitpunkt, aufgerufene Adresse, Browser-Kennung und übertragene Datenmenge. Das ist nötig, um die Seite sicher auszuliefern (Art. 6 Abs. 1 lit. f DSGVO, berechtigtes Interesse an einem stabilen, sicheren Betrieb). Die Protokolle werden von Netlify nur kurzzeitig aufbewahrt. Für die Übermittlung in die USA stellt Netlify einen Auftragsverarbeitungsvertrag mit den Standardvertragsklauseln der EU-Kommission bereit.</p>
    </section>

    <section class="card">
      <h3>Standort</h3>
      <p class="fine">Nur wenn du auf den Standort-Knopf tippst, fragt dein Browser um Erlaubnis. Der Standort wird ausschließlich auf deinem Gerät verwendet, um den nächsten Bahnhof zu finden, und nie an den Server gesendet. Vom Server geladen werden nur die Fahrplandaten der Gegend (Kacheln von etwa 50 × 50 km).</p>
    </section>

    <section class="card">
      <h3>Zug teilen (Share my Train)</h3>
      <p class="fine">Ein geteilter Link enthält nur den Tag, den Zug, Ein- und Ausstieg und den Namen, den du selbst einträgst. Er wird nirgends gespeichert. Wie jeder Seitenaufruf taucht er kurzzeitig in den Server-Protokollen von Netlify auf. Wer den Link öffnet, sieht diese Angaben. Dein Standort wird nie geteilt.</p>
    </section>

    <section class="card">
      <h3>Speicher auf deinem Gerät</h3>
      <p class="fine">Damit du Einstellungen nicht jedes Mal neu wählen musst, merkt sich der Browser lokal (localStorage): Kartenfilter, zuletzt gewählte Bahnhöfe und den Namen fürs Teilen. Diese Angaben verlassen dein Gerät nicht und sind für die von dir genutzten Funktionen nötig (§ 25 Abs. 2 TDDDG). Du kannst sie jederzeit über die Browser-Einstellungen löschen.</p>
    </section>

    <section class="card">
      <h3>Externe Links</h3>
      <p class="fine">Links zu GitHub, gtfs.de, Creative Commons oder WhatsApp öffnen fremde Seiten erst, wenn du sie antippst. Dort gelten deren Datenschutzbestimmungen.</p>
    </section>

    <section class="card">
      <h3>Deine Rechte</h3>
      <p class="fine">Du hast das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch (Art. 15–21 DSGVO). Wende dich dafür an die Kontaktadresse im Impressum. Außerdem kannst du dich bei einer Datenschutz-Aufsichtsbehörde beschweren, zum Beispiel beim Bayerischen Landesamt für Datenschutzaufsicht (BayLDA), Ansbach.</p>
      <p class="fine">Stand: Oktober 2026</p>
    </section>`;
}

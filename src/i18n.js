// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, the search button). Every
// text is a { en, fr } object: Gladys picks the user's language. The search
// typed by the user is never repeated back.
// -----------------------------------------------------------------------------

import { ATTRIBUTION } from './constants.js';
import { berlinText } from './time.js';

const reasons = {
  rate_limited: {
    en: 'the page asked to slow down (429)',
    fr: 'la page demande de ralentir (429)',
  },
  server: { en: 'the page is unavailable (5xx)', fr: 'la page est indisponible (5xx)' },
  not_found: { en: 'a file is missing (404)', fr: 'un fichier manque (404)' },
  http: { en: 'unexpected HTTP answer', fr: 'réponse HTTP inattendue' },
  network: { en: 'network error', fr: 'erreur réseau' },
  timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
  too_large: { en: 'answer too large', fr: 'réponse trop grande' },
  invalid: { en: 'unreadable data', fr: 'données illisibles' },
};
const reason = (code, lang) => (reasons[code] ?? reasons.invalid)[lang];

/** "2027: provisional data (655 of 656 operators)" per year, most recent first. */
function yearsText(years, lang) {
  return years
    .map(({ year, priced, provisional }) => {
      const kind =
        provisional === 0
          ? { en: 'final', fr: 'définitives' }[lang]
          : provisional === priced
            ? { en: 'PROVISIONAL', fr: 'PROVISOIRES' }[lang]
            : { en: `${provisional} provisional`, fr: `dont ${provisional} provisoires` }[lang];
      return lang === 'en'
        ? `${year}: ${priced} operators, ${kind}`
        : `${year} : ${priced} gestionnaires, ${kind}`;
    })
    .join(lang === 'en' ? '; ' : ' ; ');
}

export const T = {
  starting: {
    en: 'Reading the Par14a-Database data…',
    fr: 'Lecture des données Par14a-Database…',
  },
  storeUnreadable: {
    en: 'The saved data in /data cannot be read: read again every 10 seconds, nothing downloaded meanwhile (check the volume of the integration).',
    fr: 'Les données gardées dans /data sont illisibles : relues toutes les 10 secondes, rien n’est téléchargé en attendant (vérifiez le volume de l’intégration).',
  },

  /**
   * The status: the years held (with their provisional share and the date of
   * the data), the last check, the error of the last attempt if any, and the
   * contracts whose operator is not found.
   */
  status({
    years,
    published,
    checkedAt,
    error,
    retryAt,
    unresolved,
    weekdays,
    issues = [],
    dataError,
    invalid = 0,
    dropped = [],
  }) {
    const out = {};
    for (const lang of ['en', 'fr']) {
      const parts = [];
      if (years.length > 0) {
        parts.push(
          lang === 'en'
            ? `${ATTRIBUTION}. ${yearsText(years, lang)}.`
            : `${ATTRIBUTION}. ${yearsText(years, lang)}.`,
        );
        if (published) {
          parts.push(
            lang === 'en' ? `Data published on ${published}.` : `Données publiées le ${published}.`,
          );
        }
        if (checkedAt) {
          parts.push(
            lang === 'en'
              ? `Checked ${berlinText(checkedAt)} (German time).`
              : `Vérifiées le ${berlinText(checkedAt)} (heure allemande).`,
          );
        }
      } else {
        parts.push(lang === 'en' ? 'No data yet.' : 'Pas encore de données.');
      }
      if (error && retryAt !== undefined) {
        parts.push(
          lang === 'en'
            ? `Last check failed: ${reason(error, lang)}; next try ${berlinText(retryAt)}.`
            : `Dernière vérification en échec : ${reason(error, lang)} ; nouvel essai ${berlinText(retryAt)}.`,
        );
      }
      for (const { year, issue, held } of issues) {
        if (issue === 'pending') {
          parts.push(
            lang === 'en'
              ? `${year}: no sheet published yet.`
              : `${year} : aucune grille publiée pour l’instant.`,
          );
        } else {
          parts.push(
            lang === 'en'
              ? `${year}: the file was refused (${reason(issue, lang)})${held ? '; the data held stays in use' : ''}.`
              : `${year} : le fichier a été refusé (${reason(issue, lang)})${held ? ' ; les données gardées restent utilisées' : ''}.`,
          );
        }
      }
      if (dataError) {
        parts.push(
          lang === 'en'
            ? 'The data cannot be written to /data (it stays in memory; downloaded again after a restart): check the volume of the integration.'
            : 'Les données ne peuvent pas être écrites dans /data (elles restent en mémoire ; retéléchargées après un redémarrage) : vérifiez le volume de l’intégration.',
        );
      }
      for (const year of dropped) {
        parts.push(
          lang === 'en'
            ? `${year}: kept in memory only (/data would be too large); downloaded again soon after the next start.`
            : `${year} : gardée en mémoire seulement (/data serait trop grand) ; retéléchargée peu après le prochain démarrage.`,
        );
      }
      if (invalid > 0) {
        parts.push(
          lang === 'en'
            ? `${invalid} contract(s): an input is not a number or out of bounds (VAT 0-100 %, supplement 0-200 ct/kWh, fixed 0-1000 EUR/month).`
            : `${invalid} contrat(s) : une entrée n’est pas un nombre ou sort des bornes (TVA 0-100 %, supplément 0-200 ct/kWh, fixe 0-1000 EUR/mois).`,
        );
      }
      if (unresolved > 0) {
        parts.push(
          lang === 'en'
            ? `${unresolved} contract(s): grid operator not found or without a usable Modul 3 tariff; use the ID given by "Find my grid operator".`
            : `${unresolved} contrat(s) : gestionnaire de réseau introuvable ou sans tarif Modul 3 utilisable ; utilisez l’identifiant donné par « Trouver mon gestionnaire ».`,
        );
      }
      if (weekdays > 0) {
        parts.push(
          lang === 'en'
            ? `${weekdays} contract(s): the sheet notes HT/NT on working days only, which the data does not encode; every day is priced with the windows.`
            : `${weekdays} contrat(s) : la grille indique HT/NT en jours ouvrés seulement, ce que les données ne codent pas ; chaque jour est tarifé avec les plages.`,
        );
      }
      out[lang] = parts.join(' ');
    }
    return out;
  },

  noData: {
    en: 'No Par14a-Database data yet: wait for the first download (see the status).',
    fr: 'Pas encore de données Par14a-Database : attendez le premier téléchargement (voir le statut).',
  },
  emptySearch: {
    en: 'Type part of the operator name, its town, its postcode or its ID.',
    fr: 'Saisissez une partie du nom du gestionnaire, sa ville, son code postal ou son identifiant.',
  },
  noMatch: {
    en: 'No grid operator found in the Par14a-Database data: try another part of the name (your bill names the "Netzbetreiber").',
    fr: 'Aucun gestionnaire trouvé dans les données Par14a-Database : essayez une autre partie du nom (la facture indique le « Netzbetreiber »).',
  },
};

const ct = (n) => n.toFixed(2);
const quarterList = (op, letter) =>
  op.quarters
    .map((levels, i) => (levels ? `${letter}${i + 1}` : null))
    .filter(Boolean)
    .join(', ');

/** One line per operator found, with its ID and the sheet of the year. */
export function searchResult(matches, year, more) {
  const out = {};
  for (const lang of ['en', 'fr']) {
    const lines = matches.map((op) => {
      const where = [op.plz, op.ort].filter(Boolean).join(' ');
      const head = `${op.name}${where ? ` (${where})` : ''} – ID ${op.id}`;
      if (op.error) {
        return lang === 'en'
          ? `${head}: no usable Modul 3 tariff for ${year} (${op.error}).`
          : `${head} : pas de tarif Modul 3 utilisable pour ${year} (${op.error}).`;
      }
      const kind = op.provisional
        ? { en: 'provisional', fr: 'provisoire' }[lang]
        : { en: 'final', fr: 'définitive' }[lang];
      const read = op.read ? (lang === 'en' ? `, read ${op.read}` : `, relevée le ${op.read}`) : '';
      const prices = `HT ${ct(op.prices.H)} / ST ${ct(op.prices.S)} / NT ${ct(op.prices.N)} ct/kWh`;
      const note = op.weekdaysNote
        ? lang === 'en'
          ? ' Note: the sheet limits HT/NT to working days, not encoded in the data.'
          : ' Note : la grille limite HT/NT aux jours ouvrés, non codé dans les données.'
        : '';
      return lang === 'en'
        ? `${head}: ${year} sheet ${kind}${read}, ${prices} net, Modul 3 in ${quarterList(op, 'Q')}.${note}`
        : `${head} : grille ${year} ${kind}${read}, ${prices} hors TVA, Modul 3 en ${quarterList(op, 'T')}.${note}`;
    });
    if (more) {
      lines.push(
        lang === 'en'
          ? 'More operators match: refine the search.'
          : 'D’autres gestionnaires correspondent : précisez la recherche.',
      );
    }
    lines.push(
      lang === 'en'
        ? `Enter the ID in the "Grid operator" field of the contract. Source: ${ATTRIBUTION}; the operator's own price sheet prevails.`
        : `Saisissez l’identifiant dans le champ « Gestionnaire de réseau » du contrat. Source : ${ATTRIBUTION} ; la grille du gestionnaire fait foi.`,
    );
    out[lang] = lines.join('\n');
  }
  return out;
}

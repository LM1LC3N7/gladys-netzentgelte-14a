// -----------------------------------------------------------------------------
// Year files shaped like the Par14a-Database web page (daten/<year>.json):
// fictional operators, fictional prices, the real field names.
// -----------------------------------------------------------------------------

const sheet = (year, status, prices, zf, extra = {}) => ({
  gueltig_ab: `${year}-01-01`,
  status,
  preisblatt_url: 'https://example.org/preisblatt.pdf',
  abgerufen_am: year === 2026 ? '2025-12-20' : '2026-10-28',
  std_grundpreis_eur_a: 60,
  std_arbeitspreis_ct_kwh: prices.std ?? prices.st,
  m1_reduzierung_eur_a: 120,
  m3_ht_ct_kwh: prices.ht,
  m3_st_ct_kwh: prices.st,
  m3_nt_ct_kwh: prices.nt,
  m3_quartale_aktiv: Object.keys(zf).join(','),
  zf,
  ...extra,
});

const every = (windows) => ({ 1: windows, 2: windows, 3: windows, 4: windows });

/**
 * One year: 101 Musterstadt (Q1 and Q4 only, HT at a quarter past), 102
 * Beispiel (all quarters, NT across midnight, other windows in Q4), 103
 * Musterstadt Land (a note: working days only), 104 broken (overlapping
 * windows), 105 without a sheet.
 */
export function yearFile(year = 2026, overrides = {}) {
  const provisional = year >= 2027;
  const status = provisional ? 'vorlaeufig' : 'endgueltig';
  const add = provisional ? 1 : 0;
  const list = [
    {
      vnb_id: '101',
      name: 'Musterstadt Netz GmbH',
      plz: '10115',
      ort: 'Berlin',
      pb: sheet(
        year,
        status,
        { ht: 12 + add, st: 8 + add, nt: 2 + add, std: 8 + add },
        {
          1: { ht: ['17:15-20:00'], nt: ['00:00-06:00', '22:45-24:00'] },
          4: { ht: ['17:15-20:00'], nt: ['00:00-06:00', '22:45-24:00'] },
        },
      ),
    },
    {
      vnb_id: '102',
      name: 'Beispiel Energienetze GmbH',
      plz: '80331',
      ort: 'München',
      pb: sheet(
        year,
        status,
        { ht: 15 + add, st: 9 + add, nt: 1 + add },
        {
          ...every({ ht: ['16:45-19:00'], nt: ['23:00-06:45'] }),
          4: { ht: ['16:45-19:00'], nt: ['23:00-02:30'] },
        },
      ),
    },
    {
      vnb_id: '103',
      name: 'Musterstadt Land Netz GmbH',
      plz: '10117',
      ort: 'Berlin',
      pb: sheet(
        year,
        status,
        { ht: 10, st: 7, nt: 3 },
        every({ ht: ['18:00-20:00'], nt: ['01:00-05:00'] }),
        { hinweise: 'HT/NT laut Blatt nur werktags; halbautomatisch ausgelesen' },
      ),
    },
    {
      vnb_id: '104',
      name: 'Kaputt Netz AG',
      pb: sheet(
        year,
        status,
        { ht: 10, st: 7, nt: 3 },
        every({ ht: ['18:00-20:00'], nt: ['19:00-21:00'] }),
      ),
    },
    { vnb_id: '105', name: 'Ohne Blatt eG', plz: '01067', ort: 'Dresden' },
  ];
  return list.map((op) => (overrides[op.vnb_id] ? overrides[op.vnb_id](op) : op));
}

export const YEARS = ['2027', '2026'];

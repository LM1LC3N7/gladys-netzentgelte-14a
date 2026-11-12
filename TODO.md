# TODO

## Before announcing

- [ ] Test on a real Gladys 5.3+: install, the status, the search button, a
      contract on a meter, the costs of a day and a night, the dashboard price
      widget, a contract with an unknown operator.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).
- [ ] Store field left out of the manifest: `keywords` (Netzentgelt, §14a,
      Modul 3, Wärmepumpe, Wallbox).

## To confirm

- [ ] How the core shows a delegated contract that throws (the reason in the
      supervision, the catch-up once the data arrives).
- [ ] The final 2027 sheets (expected by the end of 2026): the switch from
      provisional to final, and the size of the year files then.
- [ ] Whether the Par14a-Database keeps its JSON format and URLs (two weeks
      old when this was written); a change makes the check fail visibly and
      the data held stays in use.

## Ideas

- Encode the working-days notes (2 sheets in 2026/2027) if the database adds a
  field for them; public holidays then too.
- A dashboard widget with the windows of the day.
- A recomputation of the past costs when a provisional sheet becomes final
  (the core offers no dated recalculation to a delegated integration without a
  calendar).

## Decisions

- **Version 0.1.0** set once by hand when leaving the template (package, lock
  file, manifest, image tag `ghcr.io/lm1lc3n7/gladys-netzentgelte-14a:0.1.0`);
  the Release workflow owns it from now on.
- **`type: "provider"`, `gladys_version: ">=5.3.0"`**: no device, the energy
  contract capability only (it needs Gladys 5.2, as gladys-octopus-energy);
  `countries: ["DE"]` needs 5.3.
- **Delegated model, one template**: about 650 operators (20 templates at
  most), so the operator is a contract input (its vnbdigital ID, or its exact
  name, or a part matching one operator only). The core rule engine can say
  "these windows in these quarters" (`months` + `time`), but evaluates a
  30-minute interval at its start, and the sheets put their windows on the
  quarter hour (about 1,300 of the 2026 windows): it would misprice them. The module
  prices the two quarter hours of each interval, the engine's own convention
  for 15-minute calendars.
- **Data**: the JSON of the Par14a-Database web page (one file per year, the
  same content as its CSV and SQLite releases, with the windows grouped per
  quarter), not the GitHub raw CSV (three files to join). Kept whole in
  `/data` (about 1 MB a year) and checked again when read back.
- **Once a day, conditional**: the source changes a few times a week; GitHub
  Pages answers ETag and 304. The time of the attempt goes to `/data` first.
- **No configuration**: the inputs belong to the contract (several contracts
  may name several operators); the search is an action with a field, so the
  module never reads `getConfig()`.
- **Inputs**: VAT (19 % default, on the net grid fee), a supplement per kWh
  added as typed (VAT included), a fixed amount per month (a `fixed` component
  the core computes). Bounds: VAT 0-100 %, supplement 0-200 ct/kWh, fixed
  0-1000 EUR/month, all checked by the module; an empty or blank input takes
  its default, a text that is not a plain decimal or a value out of bounds
  refuses the pricing.
- **Modul 1 reduction not enterable** (review r1): the core refuses a
  negative `fixed` amount (`tariff.schema.json`, `amount >= 0`), and the
  reduction exceeds the grid base price for 618 of 640 operators in 2027. The
  docs say to leave it out. To ask the core: a negative fixed amount, or a
  `credit` component.
- **Years checked one by one** (review r1): a year without any sheet and not
  held is "pending" (the source opens a year before its sheets), a file that
  does not read is refused; both remember their ETag. Only network failures
  (5xx, timeout, 429) speed the retries up.
- **Outside the Modul 3 quarters**: the standard price of the sheet
  (`std_arbeitspreis_ct_kwh`, ST when absent: the regulation sets ST to it,
  and the data shows them equal).
- **Working days**: 2 operators note "HT/NT nur werktags" in a comment only:
  priced every day with the windows, said in the status and the search answer.
- **Labels in English** (`HT`, `ST`, `NT`, `Standard`, `(provisional)`, the
  date the sheet was read): the pricing answer carries no language.
- **The status** dates the data (Last-Modified of the files, check time in
  German time) and counts the provisional sheets per year, the contracts whose
  operator is not found and those with a working-days note.

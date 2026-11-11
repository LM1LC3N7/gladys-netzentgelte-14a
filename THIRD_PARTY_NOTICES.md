# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). Its
code is its own: no third-party code is copied or ported. It reads, at run
time, data published by the project below.

## Par14a-Database (data)

<https://github.com/the78mole/Par14a-Database> (format read at commit
`b2a7640`, 2026-11-01)

**Par14a-Database (the78mole), <https://github.com/the78mole/Par14a-Database>,
licence: CC BY 4.0** (Creative Commons Attribution 4.0 International,
<https://creativecommons.org/licenses/by/4.0/legalcode>).

- What is used: the yearly JSON files of its web page
  (`https://the78mole.github.io/Par14a-Database/daten/<year>.json` and
  `jahre.json`), downloaded by the integration once a day, kept in its `/data`
  volume, and never shipped in this repository nor in the Docker image (the
  test fixtures are fictional operators and prices).
- Changes made to the data (CC BY 4.0, section 3(a)(1)(B)): the Modul 3
  windows of each quarter are turned into quarter-hour levels (HT, ST, NT,
  standard outside the Modul 3 quarters); a 30-minute interval is priced as its
  two quarters; VAT and a supplement typed by the user are added. An operator
  whose sheet does not read (a price missing or out of bounds, a malformed or
  overlapping window) is not priced.
- The data comes, as its authors state, from the price sheets the German
  distribution system operators publish under the EnWG (the original sheet
  always prevails), the operator master data from
  [vnbdigital.de](https://www.vnbdigital.de) and the smart meter roll-out rates
  from the [Bundesnetzagentur](https://www.bundesnetzagentur.de) (the latter
  are not used here). It is provided without any warranty of accuracy,
  completeness or timeliness; the 2027 sheets are provisional (`vorlaeufig`).
- The code of the project (`scripts/`, `web/`, MIT licence, Copyright (c)
  2026 the78mole) is not used.

## paragraph14a-netzentgelte (cross-check only)

<https://github.com/khawajashahbaz/paragraph14a-netzentgelte> (commit
`15083d0`, 2026-10-30), Kilowattheim, Muhammad Shahbaz, CC BY 4.0: its 31
price sheets (16 operators, 2026 and 2027) were compared by hand with the
Par14a-Database during the development (prices and windows identical). Nothing
of it is used by the integration nor shipped.

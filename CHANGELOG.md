# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- Declared for Germany only (`countries: ["DE"]`): the Gladys catalog of an
  instance outside Germany no longer lists it in its browse views (the search
  still finds it). Requires Gladys 5.3.0 or later.

## [0.1.1] - 2026-11-11

### Added

- The "§14a Modul 3 grid fee (Germany)" energy contract (delegated pricing):
  every half hour priced at the HT, ST or NT grid fee of the user's grid
  operator, in the windows and quarters of its price sheet (German time, clock
  changes included), as two quarter hours; VAT and a supplement per kWh added,
  a fixed amount per month computed by Gladys. Current price, its end and the
  next price for the dashboard and the scenes.
- Data from the Par14a-Database (the78mole, CC BY 4.0): about 650 operators,
  2026 and 2027 (provisional), checked once a day with a conditional request,
  kept in `/data`; the status dates the data and tells the provisional share.
- "Find my grid operator" button: the ID, the sheet and the windows of the
  operators matching a name, a town or a postcode.
- Each year checked on its own: a year opened without sheets ("pending") or
  a file that does not read never stops the others, and is not downloaded
  again until it changes. The status is published in the background, never
  awaited by the pricing.
- `THIRD_PARTY_NOTICES.md` with the attribution of the data, shipped in the
  image with `LICENSE`.

[Unreleased]: https://github.com/LM1LC3N7/gladys-netzentgelte-14a/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-netzentgelte-14a/releases/tag/v0.1.1

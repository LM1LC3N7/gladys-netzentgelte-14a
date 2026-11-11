# gladys-netzentgelte-14a

[Gladys Assistant](https://gladysassistant.com) external integration for the
**German time-variable grid fees of §14a EnWG Modul 3**: an energy contract
(delegated pricing) that prices every half hour of a meter at the HT, ST or NT
grid fee of the user's grid operator, in the windows and quarters of its price
sheet, German time. About 650 operators, 2026 and 2027 (provisional), from the
**Par14a-Database (the78mole), CC BY 4.0**. **Unofficial, not affiliated with
any grid operator. Never tested with a real Gladys energy contract yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (App)   daily check, /data, status, pricing handlers, search
                 ├─ src/http.js     the only network access (timeout, ETag, 8 MB cap, no redirect)
                 ├─ src/data.js     year file -> operators, quarter-hour levels per quarter (pure)
                 ├─ src/tariff.js   delegated costs and current price (pure)
                 ├─ src/time.js     Berlin wall-clock time of an instant (pure)
                 └─ src/store.js    /data state file (atomic writes, missing ≠ unreadable)
```

- **Source**: `https://the78mole.github.io/Par14a-Database/daten/jahre.json`
  (the years) and `.../daten/<year>.json` (one entry per operator: `vnb_id`,
  `name`, `plz`, `ort`, and `pb`, its sheet: `status`, `m3_ht_ct_kwh`,
  `m3_st_ct_kwh`, `m3_nt_ct_kwh`, `std_arbeitspreis_ct_kwh`,
  `m3_quartale_aktiv`, `zf` = `{ "<quarter>": { ht: ["HH:MM-HH:MM"], nt: [...] } }`,
  `abgerufen_am`). The 6 most recent years listed are kept.
- **Schedule**: one check a day (the source changes a few times a week), with
  `If-None-Match`; the time of the attempt is written to `/data` before the
  first request, so neither a restart nor a reconnection checks sooner. Errors:
  5, 15, 30, 60 minutes, then every 3 hours; 429: its Retry-After within
  [1 min, 6 h] (10 min when absent), kept in `/data`. A file that does not read
  is refused whole; the year held stays in use.
- **Checks on the data**: windows on the quarter-hour grid (`24:00` as an end,
  an end before the start crosses midnight), HT and NT never overlapping, prices
  finite within [0, 200] ct/kWh; an operator failing one is listed by the
  search with the reason and never priced.
- **Pricing** (`onEnergyPrice`): each 30-minute interval as two quarter hours
  of `kwh / 2`, each at the level of its Berlin wall-clock time in the sheet of
  its Berlin year; outside the Modul 3 quarters, the standard price. Cost =
  grid fee × (1 + VAT) + supplement; components `grid_fee`, `vat`,
  `supplement`; label `HT` / `ST` / `NT` / `Standard`, `(provisional)` for a
  provisional sheet. Anything missing (year, operator, sheet) throws: the core
  stores no cost and retries. No network on this path.
- **Current price** (`onEnergyCurrent`): the current quarter hour, the next
  change within 8 days and its price; `null` when the contract cannot be
  priced.
- **Why delegated**: about 650 operators (the manifest allows 20 templates),
  and windows on the quarter-hour grid while the core rule engine evaluates a
  30-minute interval at its start (it splits an interval into quarters only for
  a 15-minute calendar). The engine does express time windows per quarter
  (`months` + `time`), but not at :15 / :45 on 30-minute data.

## Credits

Data: **Par14a-Database (the78mole), <https://github.com/the78mole/Par14a-Database>,
CC BY 4.0**, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Cross-checked
by hand with [paragraph14a-netzentgelte](https://github.com/khawajashahbaz/paragraph14a-netzentgelte)
(Kilowattheim, CC BY 4.0). Delegated pricing modelled on the sibling
integration [gladys-octopus-energy](https://github.com/LM1LC3N7/gladys-octopus-energy).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run mutants                                 # mutation check (scripts/mutants.json)
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network (the real-clock test uses a local HTTP server):
the year files are fictional operators shaped like the real ones
(`test/fixtures/par14a.js`), Gladys is the SDK's fake, the timers run on a
virtual clock.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`); the data notice is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (both shipped in the Docker
image).

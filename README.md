# U.S. Economic Metrics Dashboard

Interactive, GitHub Pages-ready dashboard for official U.S. inflation and labor-market data.

## Live dashboard

Published from its own GitHub repository:

`https://ifc-chalaco.github.io/us-economic-dashboard/`

## What it covers

- Headline and core CPI, including monthly and 12-month changes
- Detailed CPI categories and user-selectable category groups
- Unemployment rate, labor-force participation, and payroll employment
- Official release dates, observation periods, adjustment status, and source links

## Refresh architecture

The scheduled GitHub Action runs each weekday after the standard BLS 8:30 a.m. ET release window. The ingestor requests official BLS API data and rewrites the published JSON only when observations change. If the data changed, the workflow commits the refreshed files to `main`; GitHub Pages then serves the updated dashboard from `/docs`.

The schedule is deliberately more frequent than the monthly releases because BLS release dates vary. No unofficial estimates are inserted.

## Run locally

```bash
python3 scripts/refresh_bls.py
python3 -m http.server 8000 --directory docs
```

Open `http://localhost:8000/`.

## Data sources

- [BLS Public Data API](https://www.bls.gov/developers/)
- [Consumer Price Index release schedule](https://www.bls.gov/schedule/news_release/cpi.htm)
- [Employment Situation release schedule](https://www.bls.gov/schedule/news_release/empsit.htm)

All displayed values are derived from official BLS series. See `config/series.json` for the exact series catalog.

# U.S. Economic Metrics Dashboard

Interactive, GitHub Pages-ready dashboard for U.S. inflation, labor, growth and market conditions.

## Live dashboard

Published from its own GitHub repository:

`https://ifc-chalaco.github.io/us-economic-dashboard/`

## What it covers

- Headline and core CPI, including monthly and 12-month changes
- Detailed CPI categories and user-selectable category groups
- Unemployment rate, labor-force participation, and payroll employment
- Philadelphia Fed professional-forecaster expectation ranges for unemployment
- PPI, PCE inflation, import prices, JOLTS, ECI, productivity, unit labor costs and claims
- GDP, retail sales, industrial production, durable goods, housing starts and permits
- SPX/S&P 500, Nasdaq, Dow, VIX, Treasury rates, yield curve, credit spreads, financial conditions and oil
- Official release dates, observation periods, adjustment status, and source links

## Refresh architecture

The scheduled GitHub Action runs each weekday after the standard U.S. release window. The ingestor requests BLS, Philadelphia Fed and FRED data and rewrites the published JSON only when observations change. If the data changed, the workflow commits the refreshed files to `main`; GitHub Pages then serves the updated dashboard from `/docs`.

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
- [Philadelphia Fed Survey of Professional Forecasters](https://www.philadelphiafed.org/surveys-and-data/real-time-data-research/survey-of-professional-forecasters)
- [Federal Reserve Economic Data](https://fred.stlouisfed.org/)

All displayed values are derived from official BLS series. See `config/series.json` for the exact series catalog.

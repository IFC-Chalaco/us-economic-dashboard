const DATA_URL = "./data/economic_data.json";
const COLORS = ["#2563eb", "#0f766e", "#c17a16", "#7c3aed", "#dc2626", "#0891b2", "#4d7c0f"];
const state = { data: null, view: "inflation", activeTab: "overview" };
const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  bindControls();
  loadData();
});

function bindControls() {
  ["view-select", "group-select", "series-select", "measure-select", "start-date", "end-date"]
    .forEach((id) => $(id).addEventListener("change", () => {
      if (id === "view-select") syncViewControls();
      if (id === "group-select") populateSeries();
      if (id === "measure-select" && state.view === "labor") populateSeries();
      render();
    }));
  $("reset-filters").addEventListener("click", resetFilters);
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });
  ["inflation", "labor", "growth", "market"].forEach((category) => {
    $(`${category}-series-select`).addEventListener("change", () => renderCategoryChart(category));
  });
}

async function loadData() {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    initializeControls();
    render();
    initializeCategoryTabs();
  } catch (error) {
    $("error-banner").hidden = false;
    $("error-banner").textContent = `Unable to load published BLS data: ${error.message}`;
  }
}

function activateTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tabPanel === tab);
    panel.classList.remove("is-entering");
    if (panel.dataset.tabPanel === tab) {
      window.requestAnimationFrame(() => panel.classList.add("is-entering"));
    }
  });
  if (tab !== "overview") {
    window.requestAnimationFrame(() => renderCategoryTab(tab));
  }
  if (window.location.hash !== `#${tab}`) {
    window.history.replaceState(null, "", `#${tab}`);
  }
}

function fredByCategory(category) {
  return (state.data.fred_series || []).filter((item) => item.category === category);
}

function initializeCategoryTabs() {
  const categorySources = {
    inflation: [
      ...seriesByKind("cpi").filter((item) => ["CUSR0000SA0", "CUSR0000SA0L1E"].includes(item.id)),
      ...fredByCategory("inflation"),
      ...seriesByKind("labor").filter((item) => item.id === "CES0500000003"),
    ],
    labor: [
      ...seriesByKind("labor").filter((item) => !item.id.match(/^CES(20|30|50|55|60|65|70|90)/)),
      ...fredByCategory("labor"),
    ],
    growth: fredByCategory("growth"),
    market: fredByCategory("markets"),
  };

  Object.entries(categorySources).forEach(([category, source]) => {
    const select = $(`${category}-series-select`);
    select.innerHTML = "";
    source.forEach((item) => select.add(new Option(item.name, item.id)));
  });

  renderCategoryCards("inflation", "inflation-metrics", categorySources.inflation.slice(0, 8));
  renderCategoryCards("labor", "labor-metrics", categorySources.labor.slice(0, 8));
  renderCategoryCards("growth", "growth-metrics", categorySources.growth);
  renderCategoryCards("market", "market-metrics", categorySources.market);
  const requestedTab = window.location.hash.slice(1);
  if (["overview", "inflation", "labor", "growth", "markets"].includes(requestedTab)) {
    activateTab(requestedTab);
  }
}

function allExtendedSeries() {
  return [...(state.data.series || []), ...(state.data.fred_series || [])];
}

function findExtendedSeries(id) {
  return allExtendedSeries().find((item) => item.id === id);
}

function latestChange(series) {
  const observations = series?.observations || [];
  const row = observations.at(-1);
  if (!row) return { row: null, value: null, type: "change" };
  if (series.kind === "cpi") return { row, value: row.yearly_change, type: "yearly" };
  if (series.kind === "fred") {
    const lag = series.frequency === "Monthly" ? 12 : series.frequency === "Quarterly" ? 4 : 1;
    const previous = observations.at(-(lag + 1));
    const value = previous?.value && row.value
      ? ((row.value / previous.value) - 1) * 100
      : row.pct_change;
    return { row, value, type: lag > 1 ? "yearly" : "change" };
  }
  return { row, value: row.monthly_change, type: "change" };
}

function formatIndicatorValue(series, value) {
  if (!Number.isFinite(value)) return "-";
  if (series.unit === "Percent" || series.unit === "Percentage points") return `${value.toFixed(2)}%`;
  if (series.format === "currency" || series.unit?.includes("Dollars")) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function indicatorSignal(series, change) {
  if (!Number.isFinite(change) || change === 0) return "neutral";
  const preference = series.signal || (
    series.kind === "cpi" || series.id === "LNS14000000" ? "lower" : "higher"
  );
  if (preference === "neutral") return "neutral";
  return (change > 0 && preference === "higher") || (change < 0 && preference === "lower")
    ? "positive"
    : "negative";
}

function renderCategoryCards(category, targetId, source) {
  const target = $(targetId);
  target.innerHTML = "";
  source.forEach((series) => {
    const { row, value: change, type } = latestChange(series);
    if (!row) return;
    const signal = indicatorSignal(series, change);
    const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "●";
    const changeLabel = Number.isFinite(change)
      ? `${arrow} ${change >= 0 ? "+" : ""}${change.toFixed(2)}% ${type === "yearly" ? "over 12 months" : "from prior period"}`
      : "No prior-period comparison";
    const card = document.createElement("article");
    card.className = "card indicator-card";
    card.innerHTML = `
      <span class="indicator-name">${series.name}</span>
      <strong>${formatIndicatorValue(series, row.value)}</strong>
      <small>${monthLabel(row.date)} · ${series.frequency || series.adjustment || "Published observation"}</small>
      <span class="indicator-change ${signal}">${changeLabel}</span>
    `;
    target.appendChild(card);
  });
}

function renderCategoryTab(tab) {
  const category = tab === "markets" ? "market" : tab;
  renderCategoryChart(category);
  if (tab === "labor") renderIndustryChart();
}

function renderCategoryChart(category) {
  const select = $(`${category}-series-select`);
  const series = findExtendedSeries(select.value);
  if (!series) return;
  const chartId = {
    inflation: "inflation-chart",
    labor: "labor-detail-chart",
    growth: "growth-chart",
    market: "market-chart",
  }[category];
  const rows = series.observations || [];
  const color = category === "market" ? "#7c3aed" : category === "growth" ? "#c17a16" : category === "labor" ? "#0f766e" : "#2563eb";
  const inflationDetails = category === "inflation"
    ? rows.map((row, index) => {
        const previous = index > 0 ? rows[index - 1] : null;
        const rawDelta = previous ? row.value - previous.value : null;
        const delta = previous && series.unit !== "Percent" && previous.value !== 0
          ? ((row.value / previous.value) - 1) * 100
          : rawDelta;
        const deltaUnit = series.unit === "Percent" ? "pp" : "%";
        return {
          date: monthLabel(row.date),
          value: formatIndicatorValue(series, row.value),
          delta,
          label: Number.isFinite(delta)
            ? `${delta > 0 ? "▲" : delta < 0 ? "▼" : "●"} ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} ${deltaUnit} vs previous month`
            : "No prior-month comparison",
          signal: !Number.isFinite(rawDelta) || rawDelta === 0 ? "stable" : rawDelta < 0 ? "favorable" : "adverse",
        };
      })
    : null;
  const laborDetails = category === "labor"
    ? rows.map((row, index) => {
        const previous = index > 0 ? rows[index - 1] : null;
        const delta = previous ? row.value - previous.value : null;
        const unit = {
          Percent: "pp",
          Thousands: "K",
          "Dollars per hour": "$",
          Hours: " hours",
        }[series.unit] || "";
        const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "●";
        const arrowColor = delta > 0 ? "#b91c1c" : delta < 0 ? "#15803d" : "#b45309";
        return Number.isFinite(delta)
          ? `<span style="color:${arrowColor};font-weight:700">${arrow}</span> ${unit === "$" ? unit : ""}${delta >= 0 ? "+" : ""}${delta.toFixed(2)}${unit === "$" ? "" : unit} vs prior month`
          : "No prior-month comparison";
      })
    : null;
  const chart = $(chartId);
  const layout = plotLayout(series.unit || "Value");
  Plotly.react(chart, [{
    x: rows.map((row) => row.date),
    y: rows.map((row) => row.value),
    type: "scatter",
    mode: "lines",
    line: { color, width: 3 },
    fill: "tozeroy",
    fillcolor: `${color}12`,
    name: series.name,
    customdata: inflationDetails || laborDetails,
    hoverinfo: category === "inflation" ? "none" : undefined,
    hovertemplate: category === "inflation"
      ? undefined
      : `${category === "labor" ? "" : "%{x|%b %Y}<br>"}${series.name}: %{y:,.2f}${category === "labor" ? "<br>%{customdata}" : ""}<extra></extra>`,
  }], {
    ...layout,
    margin: { ...layout.margin, t: 48 },
    title: {
      text: series.name,
      x: 0.05,
      y: 0.98,
      xanchor: "left",
      yanchor: "top",
      font: { family: "Newsreader", size: 20 },
    },
    hoverlabel: category === "labor"
      ? { align: "left", font: { family: "DM Sans", size: 11 } }
      : undefined,
    hovermode: category === "inflation" ? "closest" : "x unified",
  }, { responsive: true, displaylogo: false });
  if (category === "inflation") {
    updateInflationReadout(null);
    chart.removeAllListeners?.("plotly_hover");
    chart.removeAllListeners?.("plotly_unhover");
    chart.on("plotly_hover", (event) => updateInflationReadout(event.points[0].customdata));
    chart.on("plotly_unhover", () => updateInflationReadout(null));
  } else if (category === "labor") {
    chart.removeAllListeners?.("plotly_hover");
    chart.on("plotly_hover", (event) => positionLaborHover(chart, event.points[0]));
  }
}

function positionLaborHover(chart, point) {
  requestAnimationFrame(() => {
    const hover = chart.querySelector(".hoverlayer g.legend");
    if (!hover || !point) return;
    const layout = chart._fullLayout;
    const size = layout?._size;
    if (!size) return;

    const bounds = hover.getBBox();
    const pointX = point.xaxis._offset + point.xaxis.d2p(point.x);
    const pointY = point.yaxis._offset + point.yaxis.d2p(point.y);
    const plotLeft = size.l;
    const plotTop = size.t;
    const plotRight = plotLeft + size.w;
    const plotBottom = plotTop + size.h;
    const gap = 14;
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

    let x = clamp(pointX - bounds.width / 2, plotLeft + 6, plotRight - bounds.width - 6);
    let y = pointY - bounds.height - gap;
    if (y < plotTop + 6) {
      x = pointX + gap;
      if (x + bounds.width > plotRight - 6) x = pointX - bounds.width - gap;
      x = clamp(x, plotLeft + 6, plotRight - bounds.width - 6);
      y = clamp(pointY - bounds.height / 2, plotTop + 6, plotBottom - bounds.height - 6);
    }
    hover.setAttribute("transform", `translate(${x},${y})`);
  });
}

function updateInflationReadout(detail) {
  const readout = $("inflation-hover-readout");
  const date = readout.querySelector(".inflation-hover-date");
  const value = readout.querySelector(".inflation-hover-value");
  const delta = readout.querySelector(".inflation-hover-delta");
  if (!detail) {
    readout.className = "inflation-hover-readout stable";
    date.textContent = "Glide over the line";
    value.textContent = "-";
    delta.textContent = "Previous-month delta";
    return;
  }
  readout.className = `inflation-hover-readout ${detail.signal} is-active`;
  date.textContent = detail.date;
  value.textContent = detail.value;
  delta.textContent = detail.label;
}

function renderIndustryChart() {
  const industries = seriesByKind("labor")
    .filter((item) => item.id.match(/^CES(20|30|50|55|60|65|70|90)/))
    .map((item) => ({ name: item.name.replace(" employment", ""), change: item.observations.at(-1)?.monthly_change }))
    .filter((item) => Number.isFinite(item.change))
    .sort((a, b) => a.change - b.change);
  Plotly.react("industry-chart", [{
    x: industries.map((item) => item.change),
    y: industries.map((item) => item.name),
    type: "bar",
    orientation: "h",
    marker: { color: industries.map((item) => item.change >= 0 ? "#0f766e" : "#b91c1c") },
    text: industries.map((item) => `${item.change >= 0 ? "+" : ""}${item.change.toFixed(0)}K`),
    textposition: "outside",
    hoverinfo: "skip",
  }], {
    ...plotLayout(""),
    margin: { l: 205, r: 52, t: 18, b: 48 },
    showlegend: false,
    hovermode: false,
    xaxis: {
      ...plotLayout("").xaxis,
      title: { text: "Monthly payroll change (thousands)", standoff: 12 },
    },
    yaxis: {
      ...plotLayout("").yaxis,
      title: { text: "" },
      automargin: true,
    },
  }, { responsive: true, displaylogo: false });
}

function initializeControls() {
  const cpi = seriesByKind("cpi");
  [...new Set(cpi.map((item) => item.group))].sort().forEach((group) => {
    $("group-select").add(new Option(group, group));
  });
  const dates = cpi[0]?.observations.map((row) => row.date) || [];
  $("start-date").value = dates[Math.max(0, dates.length - 61)]?.slice(0, 7) || "";
  $("end-date").value = dates.at(-1)?.slice(0, 7) || "";
  populateSeries();
  syncViewControls();
}

function seriesByKind(kind) {
  return state.data.series.filter((item) => item.kind === kind);
}

function populateSeries() {
  const select = $("series-select");
  const selected = select.value;
  select.innerHTML = "";
  const group = $("group-select").value;
  const source = state.view === "inflation"
    ? seriesByKind("cpi").filter((item) => group === "All" || item.group === group)
    : seriesByKind("labor").filter((item) =>
        $("measure-select").value !== "monthly_change" || item.id === "CES0000000001"
      );
  source.forEach((item) => select.add(new Option(item.name, item.id)));
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

function syncViewControls() {
  state.view = $("view-select").value;
  const inflation = state.view === "inflation";
  $("group-select").disabled = !inflation;
  $("measure-select").innerHTML = "";
  if (inflation) {
    $("measure-select").add(new Option("12-month change", "yearly_change"));
    $("measure-select").add(new Option("Monthly change", "monthly_change"));
    $("measure-select").add(new Option("Index level", "value"));
  } else {
    $("measure-select").add(new Option("Published level / rate", "value"));
    $("measure-select").add(new Option("Monthly payroll change", "monthly_change"));
  }
  populateSeries();
}

function resetFilters() {
  $("view-select").value = "inflation";
  $("group-select").value = "All";
  state.view = "inflation";
  syncViewControls();
  const allDates = seriesByKind("cpi")[0]?.observations.map((row) => row.date) || [];
  $("start-date").value = allDates[Math.max(0, allDates.length - 61)]?.slice(0, 7) || "";
  $("end-date").value = allDates.at(-1)?.slice(0, 7) || "";
  render();
}

function latest(id) {
  const item = state.data.series.find((series) => series.id === id);
  return { series: item, row: item?.observations.at(-1) };
}

function pct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "-";
}

function monthLabel(date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

function renderKpis() {
  const headline = latest("CUSR0000SA0");
  const core = latest("CUSR0000SA0L1E");
  const unemployment = latest("LNS14000000");
  const payroll = latest("CES0000000001");
  $("headline-yoy").textContent = pct(headline.row?.yearly_change);
  $("core-yoy").textContent = pct(core.row?.yearly_change);
  $("unemployment").textContent = pct(unemployment.row?.value);
  $("payroll").textContent = Number.isFinite(payroll.row?.monthly_change)
    ? `${payroll.row.monthly_change >= 0 ? "+" : ""}${payroll.row.monthly_change.toFixed(0)}K`
    : "-";
  $("headline-note").textContent = `${monthLabel(headline.row.date)} · ${headline.row.monthly_change >= 0 ? "+" : ""}${headline.row.monthly_change.toFixed(1)}% monthly`;
  $("core-note").textContent = `${monthLabel(core.row.date)} · ${core.row.monthly_change >= 0 ? "+" : ""}${core.row.monthly_change.toFixed(1)}% monthly`;
  $("unemployment-note").textContent = `${monthLabel(unemployment.row.date)} · seasonally adjusted`;
  $("payroll-note").textContent = `${monthLabel(payroll.row.date)} · thousands`;
  $("updated-at").textContent = new Date(state.data.generated_at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";

  const direction = headline.row.yearly_change > core.row.yearly_change ? "Headline inflation is running above core inflation" : "Core inflation is running above headline inflation";
  $("executive-summary").textContent =
    `${direction}. In ${monthLabel(headline.row.date)}, headline CPI was ${pct(headline.row.yearly_change)} over 12 months and ${pct(headline.row.monthly_change)} for the month. ` +
    `The unemployment rate was ${pct(unemployment.row.value)} in ${monthLabel(unemployment.row.date)}, while total nonfarm payrolls changed by ${payroll.row.monthly_change >= 0 ? "an increase of" : "a decrease of"} ${Math.abs(payroll.row.monthly_change).toFixed(0)} thousand.`;
}

function filteredObservations(series, measure) {
  const start = $("start-date").value;
  const end = $("end-date").value;
  return series.observations.filter((row) =>
    (!start || row.date.slice(0, 7) >= start) &&
    (!end || row.date.slice(0, 7) <= end) &&
    Number.isFinite(row[measure])
  );
}

function plotLayout(yTitle) {
  return {
    margin: { l: 58, r: 20, t: 18, b: 48 },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "DM Sans", color: "#132238" },
    xaxis: { gridcolor: "rgba(19,34,56,.08)", automargin: true },
    yaxis: { title: yTitle, gridcolor: "rgba(19,34,56,.08)", zerolinecolor: "rgba(19,34,56,.25)" },
    legend: { orientation: "h", y: 1.12 }, hovermode: "x unified",
  };
}

function trendValueLabel(value, measure, selected) {
  if (!Number.isFinite(value)) return "-";
  if (measure === "yearly_change" || (measure === "monthly_change" && selected.id !== "CES0000000001")) {
    return `${value.toFixed(1)}%`;
  }
  if (measure === "monthly_change" && selected.id === "CES0000000001") {
    return `${value >= 0 ? "+" : ""}${value.toFixed(0)}K`;
  }
  return selected.unit === "Percent" ? `${value.toFixed(1)}%` : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function trendDelta(row, previousRow, measure, selected) {
  if (!previousRow || !Number.isFinite(row[measure]) || !Number.isFinite(previousRow[measure])) {
    return { value: null, label: "No prior-month comparison", signal: "stable", insight: "Insufficient history to assess direction." };
  }

  let value;
  let suffix;
  if (measure === "value" && selected.unit !== "Percent") {
    value = previousRow.value === 0 ? null : ((row.value / previousRow.value) - 1) * 100;
    suffix = "%";
  } else if (measure === "monthly_change" && selected.id === "CES0000000001") {
    value = row.monthly_change - previousRow.monthly_change;
    suffix = "K";
  } else {
    value = row[measure] - previousRow[measure];
    suffix = " pp";
  }

  if (!Number.isFinite(value)) {
    return { value: null, label: "No prior-month comparison", signal: "stable", insight: "Insufficient history to assess direction." };
  }

  const isInflation = selected.kind === "cpi";
  const lowerIsFavorable = isInflation || selected.id === "LNS14000000";
  const higherIsFavorable = selected.id === "LNS11300000" || selected.id === "CES0000000001";
  let signal = "stable";
  if (value !== 0) {
    if (lowerIsFavorable) signal = value < 0 ? "favorable" : "adverse";
    else if (higherIsFavorable) signal = value > 0 ? "favorable" : "adverse";
    else signal = value > 0 ? "favorable" : "adverse";
  }

  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "●";
  const digits = suffix === "K" ? 0 : 2;
  let insight = "No change from the previous month.";
  if (isInflation && value < 0) insight = "Inflation momentum eased from the previous month.";
  if (isInflation && value > 0) insight = "Inflation momentum increased from the previous month.";
  if (selected.id === "LNS14000000" && value < 0) insight = "The unemployment rate improved from the previous month.";
  if (selected.id === "LNS14000000" && value > 0) insight = "The unemployment rate weakened from the previous month.";
  if (selected.id === "LNS11300000" && value < 0) insight = "Labor-force participation declined from the previous month.";
  if (selected.id === "LNS11300000" && value > 0) insight = "Labor-force participation improved from the previous month.";
  if (selected.id === "CES0000000001" && value < 0) insight = "Payroll growth slowed from the previous month.";
  if (selected.id === "CES0000000001" && value > 0) insight = "Payroll growth accelerated from the previous month.";
  return {
    value,
    signal,
    insight,
    label: `${arrow} ${value >= 0 ? "+" : ""}${value.toFixed(digits)}${suffix} vs previous month`,
  };
}

function updateTrendReadout(detail) {
  const readout = $("trend-hover-readout");
  const date = readout.querySelector(".trend-hover-date");
  const value = readout.querySelector(".trend-hover-value");
  const delta = readout.querySelector(".trend-hover-delta");
  const insight = readout.querySelector(".trend-hover-insight");
  if (!detail) {
    date.textContent = "Glide over the line";
    value.textContent = "-";
    delta.textContent = "Previous-month change";
    delta.className = "trend-hover-delta stable";
    insight.textContent = "Direction will be assessed in economic context.";
    return;
  }
  date.textContent = detail.date;
  value.textContent = detail.value;
  delta.textContent = detail.delta;
  delta.className = `trend-hover-delta ${detail.signal}`;
  insight.textContent = detail.insight;
}

function renderTrend() {
  const measure = $("measure-select").value;
  let selected = state.data.series.find((item) => item.id === $("series-select").value);
  if (!selected) selected = state.view === "inflation" ? seriesByKind("cpi")[0] : seriesByKind("labor")[0];
  const rows = filteredObservations(selected, measure);
  const observationIndex = new Map(selected.observations.map((row, index) => [row.date, index]));
  const hoverDetails = rows.map((row) => {
    const index = observationIndex.get(row.date);
    const previousRow = index > 0 ? selected.observations[index - 1] : null;
    const delta = trendDelta(row, previousRow, measure, selected);
    return {
      date: monthLabel(row.date),
      value: trendValueLabel(row[measure], measure, selected),
      delta: delta.label,
      signal: delta.signal,
      insight: delta.insight,
    };
  });
  const labels = { yearly_change: "12-month change (%)", monthly_change: selected.id === "CES0000000001" ? "Monthly change (thousands)" : "Monthly change (%)", value: selected.unit || "Index level" };
  $("trend-title").textContent = selected.name;
  $("trend-note").textContent = `${selected.adjustment} · ${labels[measure]}`;
  updateTrendReadout(null);
  const chart = $("trend-chart");
  Plotly.react(chart, [{
    x: rows.map((row) => row.date), y: rows.map((row) => row[measure]),
    type: "scatter", mode: "lines", line: { color: COLORS[0], width: 3 },
    fill: "tozeroy", fillcolor: "rgba(37,99,235,.09)", name: selected.name,
    customdata: hoverDetails,
    hoverinfo: "none",
  }], { ...plotLayout(labels[measure]), hovermode: "closest" }, { responsive: true, displaylogo: false });
  chart.removeAllListeners?.("plotly_hover");
  chart.removeAllListeners?.("plotly_unhover");
  chart.on("plotly_hover", (event) => updateTrendReadout(event.points[0].customdata));
  chart.on("plotly_unhover", () => updateTrendReadout(null));
}

function renderCategories() {
  const group = $("group-select").value;
  const rows = seriesByKind("cpi")
    .filter((item) => group === "All" || item.group === group)
    .map((item) => ({ name: item.name, group: item.group, row: item.observations.at(-1) }))
    .filter((item) => Number.isFinite(item.row?.yearly_change))
    .sort((a, b) => a.row.yearly_change - b.row.yearly_change);
  Plotly.react("category-chart", [{
    x: rows.map((item) => item.row.yearly_change), y: rows.map((item) => item.name),
    type: "bar", orientation: "h", marker: { color: rows.map((item) => item.row.yearly_change >= 0 ? "#c17a16" : "#0f766e") },
    text: rows.map((item) => `${item.row.yearly_change.toFixed(1)}%`), textposition: "outside",
    customdata: rows.map((item) => item.group), hovertemplate: "%{y}<br>%{x:.1f}%<br>%{customdata}<extra></extra>",
  }], { ...plotLayout("12-month change (%)"), margin: { l: 150, r: 36, t: 18, b: 48 }, showlegend: false }, { responsive: true, displaylogo: false });
}

function renderLabor() {
  const unemployment = state.data.series.find((item) => item.id === "LNS14000000");
  const actual = filteredObservations(unemployment, "value");
  const expectations = state.data.expectations?.unemployment;
  const forecast = expectations?.observations || [];
  const traces = [];

  if (forecast.length) {
    traces.push(
      {
        x: forecast.map((row) => row.date),
        y: forecast.map((row) => row.p25),
        type: "scatter",
        mode: "lines",
        line: { color: "rgba(99,112,131,0)", width: 0 },
        hoverinfo: "skip",
        showlegend: false,
        name: "Expected range lower bound",
      },
      {
        x: forecast.map((row) => row.date),
        y: forecast.map((row) => row.p75),
        type: "scatter",
        mode: "lines",
        line: { color: "rgba(99,112,131,.35)", width: 1 },
        fill: "tonexty",
        fillcolor: "rgba(99,112,131,.18)",
        name: "Expected range (25th-75th percentile)",
        customdata: forecast.map((row) => [row.p25, row.p75]),
        hovertemplate: "%{x|%b %Y}<br>Expected range: %{customdata[0]:.1f}%-%{customdata[1]:.1f}%<extra></extra>",
      },
      {
        x: forecast.map((row) => row.date),
        y: forecast.map((row) => row.expected_mean),
        type: "scatter",
        mode: "lines+markers",
        line: { color: "#637083", width: 2, dash: "dot" },
        marker: { size: 7, color: "#637083" },
        name: "Expected mean",
        hovertemplate: "%{x|%b %Y}<br>Expected mean: %{y:.1f}%<extra></extra>",
      }
    );
  }

  traces.push({
    x: actual.map((row) => row.date),
    y: actual.map((row) => row.value),
    type: "scatter",
    mode: "lines+markers",
    line: { width: 3, color: "#0f766e" },
    marker: { size: 5, color: "#0f766e" },
    name: "Actual unemployment rate",
    hovertemplate: "%{x|%b %Y}<br>Actual: %{y:.1f}%<extra></extra>",
  });

  const layout = plotLayout("Unemployment rate (%)");
  layout.legend = { orientation: "h", y: 1.18 };
  Plotly.react("labor-chart", traces, layout, { responsive: true, displaylogo: false });
  $("labor-note").textContent = forecast.length
    ? `Green is monthly BLS actual. Shading is the ${expectations.range_definition.toLowerCase()} from the ${expectations.survey_date} SPF.`
    : "Green is the monthly BLS actual unemployment rate.";
}

function render() {
  if (!state.data) return;
  renderKpis();
  renderTrend();
  renderCategories();
  renderLabor();
}

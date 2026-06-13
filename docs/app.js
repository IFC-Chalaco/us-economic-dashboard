const DATA_URL = "./data/economic_data.json";
const COLORS = ["#2563eb", "#0f766e", "#c17a16", "#7c3aed", "#dc2626", "#0891b2", "#4d7c0f"];
const state = { data: null, view: "inflation" };
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
}

async function loadData() {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    initializeControls();
    render();
  } catch (error) {
    $("error-banner").hidden = false;
    $("error-banner").textContent = `Unable to load published BLS data: ${error.message}`;
  }
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

function renderTrend() {
  const measure = $("measure-select").value;
  let selected = state.data.series.find((item) => item.id === $("series-select").value);
  if (!selected) selected = state.view === "inflation" ? seriesByKind("cpi")[0] : seriesByKind("labor")[0];
  const rows = filteredObservations(selected, measure);
  const labels = { yearly_change: "12-month change (%)", monthly_change: selected.id === "CES0000000001" ? "Monthly change (thousands)" : "Monthly change (%)", value: selected.unit || "Index level" };
  $("trend-title").textContent = selected.name;
  $("trend-note").textContent = `${selected.adjustment} · ${labels[measure]}`;
  Plotly.react("trend-chart", [{
    x: rows.map((row) => row.date), y: rows.map((row) => row[measure]),
    type: "scatter", mode: "lines", line: { color: COLORS[0], width: 3 },
    fill: "tozeroy", fillcolor: "rgba(37,99,235,.09)", name: selected.name,
  }], plotLayout(labels[measure]), { responsive: true, displaylogo: false });
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
  const labor = seriesByKind("labor").filter((item) => item.id !== "CES0000000001");
  const traces = labor.map((item, index) => {
    const rows = filteredObservations(item, "value");
    return { x: rows.map((row) => row.date), y: rows.map((row) => row.value), type: "scatter", mode: "lines", name: item.name, line: { width: 3, color: COLORS[index + 1] } };
  });
  Plotly.react("labor-chart", traces, plotLayout("Percent"), { responsive: true, displaylogo: false });
}

function render() {
  if (!state.data) return;
  renderKpis();
  renderTrend();
  renderCategories();
  renderLabor();
}

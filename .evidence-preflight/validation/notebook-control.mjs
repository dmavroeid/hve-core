const markdown = source => ({ cell_type: "markdown", metadata: {}, source });
const code = source => ({
  cell_type: "code", metadata: {}, source, execution_count: null, outputs: [],
});

export function notebookControl() {
  const cells = [
    markdown(`# Trusted notebook execution control

Where should the fleet-charging team investigate queue delays, and what remains
insufficient to recommend maintenance changes? This authored control exercises
checker mechanics; it is not a model submission or evidence of skill value.

## Data assets

Use only task-fixture/sessions.csv, profile.json and BRIEF.txt. The profile
defines one row per synthetic charging session and documents observational
limits and repeated station observations.`),
    code(`from pathlib import Path
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

FIXTURES = Path("task-fixture")
FIGURES = Path("deliverable") / "figures"
FIGURES.mkdir(parents=True, exist_ok=True)

def save_figure(figure: plt.Figure, name: str) -> None:
    figure.tight_layout()
    figure.savefig(FIGURES / f"{name}.png", dpi=120)
    plt.close(figure)
`),
    markdown("## Loading and quality checks\n\nCheck the declared shape, column types and missingness before interpreting relationships."),
    code(`with (FIXTURES / "profile.json").open(encoding="utf-8") as handle:
    profile = json.load(handle)
data = pd.read_csv(FIXTURES / "sessions.csv", parse_dates=["date"])
assert len(data) == profile["rows"] == 60000
assert data["station_id"].nunique() == profile["stations"] == 80
assert set(profile["columns"]).issubset(data.columns)
print(data.dtypes.to_string())
print(data.isna().sum().to_string())
print(f"CONTROL_EXECUTED rows={len(data)} stations={data['station_id'].nunique()}")
`),
    markdown(`## Univariate distributions

How are queue delays, energy delivery and charging durations distributed?
Inspect the displayed summaries alongside the exported histograms; long tails
are investigation leads, not equipment-fault diagnoses.`),
    code(`measures = {
    "queue_minutes": "Queue delay (minutes)",
    "energy_kwh": "Delivered energy (kWh)",
    "duration_minutes": "Charging duration (minutes)",
}
print(data[list(measures)].describe().to_string())
for column, label in measures.items():
    figure, axis = plt.subplots()
    axis.hist(data[column].dropna(), bins=245, color="#0072B2")
    axis.set(xlabel=label, ylabel="Session count", title=label)
    save_figure(figure, f"distribution-{column}")
`),
    markdown(`## Relationships and correlation

Are longer waits associated with energy delivery or charging duration?
Each scatter uses a fixed 5,000-session sample, not all 60,000 points.
Correlation is descriptive; annotated values and a fixed -1 to 1 scale
prevent color alone from conveying the relationship.`),
    code(`sample = data.sample(n=5000, random_state=42)
for column in ["energy_kwh", "duration_minutes"]:
    figure, axis = plt.subplots()
    axis.scatter(sample[column], sample["queue_minutes"], alpha=0.2, s=8, marker="o")
    axis.set(xlabel=measures[column], ylabel=measures["queue_minutes"])
    save_figure(figure, f"queue-vs-{column}")

correlations = data[list(measures)].corr()
figure, axis = plt.subplots()
image = axis.imshow(correlations, vmin=-1, vmax=1, cmap="cividis")
axis.set_xticks(range(3), list(measures), rotation=30, ha="right")
axis.set_yticks(range(3), list(measures))
for row in range(3):
    for column in range(3):
        axis.text(column, row, f"{correlations.iloc[row, column]:.2f}",
                  ha="center", va="center")
figure.colorbar(image, ax=axis, label="Pearson correlation")
save_figure(figure, "numeric-correlation")
`),
    markdown(`## Temporal trends and station groups

When and where are delays higher? Compare daily medians and means using
different line and marker shapes, then inspect the ten largest station
medians. Aggregation avoids an unreadable 80-station facet grid; it does
not adjust for traffic mix or repeated observations.`),
    code(`daily = data.groupby("date")["queue_minutes"].agg(["median", "mean"])
figure, axis = plt.subplots()
axis.plot(daily.index, daily["median"], "o-", markersize=2, label="Daily median")
axis.plot(daily.index, daily["mean"], "x--", markersize=2, label="Daily mean")
axis.set(xlabel="Session date", ylabel="Queue delay (minutes)")
axis.legend()
save_figure(figure, "daily-queue-delays")

stations = data.groupby("station_id")["queue_minutes"].median().nlargest(10)
figure, axis = plt.subplots()
axis.barh(stations.index.astype(str), stations.values, color="#0072B2")
axis.set(xlabel="Median queue delay (minutes)", ylabel="Station")
save_figure(figure, "station-queue-priorities")
print(stations.to_string())
`),
    markdown(`## Outliers, insights and next steps

Inspect the ten longest recorded waits as individual investigation leads.
The station ranking and daily summaries prioritize follow-up, not maintenance
changes. No intervention assignment or fault labels exist; synthetic
observational associations cannot establish maintenance effects. Review
station-level dependence and missing temperature measurements before proposing
an intervention or a causal model.`),
    code(`print(data.nlargest(10, "queue_minutes")[
    ["station_id", "date", "queue_minutes"]].to_string(index=False))
print(f"Highest station median: {stations.index[0]} "
      f"({stations.iloc[0]:.2f} minutes); validate operational causes independently.")
`),
  ];
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "hve-simplified-pilot", display_name: "Python control", language: "python" },
      language_info: { name: "python" },
    },
    cells: cells.map((cell, index) => ({ id: `control-${index}`, ...cell })),
  };
}

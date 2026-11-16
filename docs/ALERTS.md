# Alert & warning engine

Every alert states **what** is happening, **which asteroid** it affects, **why it matters**, **how urgent** it is, and the
**actions** to consider. It also lists the verified observations (`evidence`) and any assumptions behind a projection.

## Avoiding false alarms

- **Persistence:** a condition must hold for `persistEvaluations` (2) consecutive evaluations (~10 s) before it raises.
- **Clear streak:** an active alert resolves only after `clearEvaluations` (3) consecutive clear evaluations.
- **Stale data is ignored:** if the metric a rule needs is stale, the rule does not evaluate that world at all.
  Missing data neither raises nor resolves.
- **Projections need evidence:** trend-based rules require a reliable trend (≥ 6 samples over ≥ 0.25 *unpaused* game cycles).
- **Context checks:** food alerts are suppressed while food is reliably increasing; battery alerts need a draining trend
  or unpowered consumers, not merely a low battery; rocket interiors are exempt from the water minimum.
- **Acknowledge** keeps an alert visible but marked ACK. **Dismiss** hides it until it resolves or **escalates** in
  severity (WARNING → CRITICAL re-surfaces it). Alert state survives restarts (`data/alerts.json`).

## Rules

| Rule id | Severity | Condition (defaults) |
|---|---|---|
| `food-runway` | CRITICAL / WARNING | stock ÷ (pop × 1000 kcal) < 3 / < 6 cycles, unless food is reliably rising |
| `food-declining` | WARNING | reliable falling food trend with trend runway < 12 cycles ("production falling behind consumption") |
| `starving` | CRITICAL / WARNING | any duplicant ≤ 200 kcal / at least half the duplicants < 1000 kcal |
| `incapacitated` | CRITICAL / WARNING | ≥ 2 / 1 duplicants at 0 HP |
| `suffocating` | CRITICAL | any duplicant < 35 % breath |
| `stress` | WARNING | any duplicant ≥ 85 % stress, or at least half the duplicants ≥ 60 % |
| `workforce` | CRITICAL | fewer than half the duplicants able to work (incapacitated / starving / suffocating / status-check critical) |
| `oxygen` | CRITICAL / WARNING | free O₂ < 10 / < 40 kg per duplicant, or O₂ trend projects depletion in < 2 / < 5 cycles |
| `battery` | CRITICAL / WARNING | ≤ 5 % with draining trend or unpowered consumers / ≤ 20 % and draining |
| `power-deficit` | WARNING | battery energy reliably falling (R² ≥ 0.5), or no operational generators while consumers draw power |
| `generator-empty` | WARNING | any generator reports empty |
| `coal-runway`, `petroleum-runway`, `gas-runway` | WARNING | reliable falling trend with runway < 5 cycles |
| `water-runway` | WARNING | runway < 10 cycles, or (asteroids with duplicants) total water < 2 t |
| `temperature` | CRITICAL / WARNING | average revealed-cell temperature ≥ 75 / ≥ 60 °C |
| `world-discovered`, `world-settled`, `generator-online`, `cycle-milestone`, `population` | INFO | one-shot events relative to the previous snapshot of the same save |

## Thresholds

Create `config/thresholds.json` (see `config/thresholds.example.json`) with any subset of:

```
foodRunwayCriticalCycles 3     foodRunwayWarningCycles 6     kcalPerDupePerCycle 1000
oxygenKgPerDupeCritical 10     oxygenKgPerDupeWarning 40
batteryCriticalPct 5           batteryWarningPct 20
waterRunwayWarningCycles 10    waterMinimumKg 2000           fuelRunwayWarningCycles 5
temperatureWarningC 60         temperatureCriticalC 75
stressWarningPct 60            stressCriticalPct 85
hungryKcal 1000                starvingKcal 200              lowBreathPct 35
incapacitatedCritical 2
persistEvaluations 2           clearEvaluations 3
trendMinSamples 6              trendMinSpanCycles 0.25       trendWindowCycles 3
staleAfterSeconds 45
```

Restart the server after editing.

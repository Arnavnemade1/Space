# Orbital Datacenter Testbed

An interactive 3D physics engine, trade-off explorer, and mission simulator for testing orbital datacenters — launch them, fly them, power them, cool them, analyze radiation and cost trade-offs, and discover how they fail.

```bash
npm install
npm run dev          # Interactive 3D Web UI (http://localhost:5173)
npm test             # 157 automated physics validation assertions
npm run stress       # 84,439 invariant checks across full parameter matrices
node tools/explore.mjs # Parameter space explorer & Pareto front solver
node tools/mission.mjs # 12-year end-to-end mission campaign simulation
```

---

## Table of Contents
1. [Overview & Core Mission](#overview--core-mission)
2. [Physics Invariants & Engineering Fundamentals](#physics-invariants--engineering-fundamentals)
   - [Thermal Management & Radiative Cooling](#1-thermal-management--radiative-cooling)
   - [Space Radiation Environment & Reliability](#2-space-radiation-environment--reliability)
   - [Power Generation, Energy Storage & Eclipse Dynamics](#3-power-generation-energy-storage--eclipse-dynamics)
   - [Atmospheric Drag & Orbital Decay](#4-atmospheric-drag--orbital-decay)
   - [Downlink & Latency Constraints](#5-downlink--latency-constraints)
   - [Launch Economics & Terrestrial Breakeven](#6-launch-economics--terrestrial-breakeven)
3. [Exhaustive Outcomes & Engineering Solutions Matrix](#exhaustive-outcomes--engineering-solutions-matrix)
4. [How to Test All Designs (Testing & Simulation Guide)](#how-to-test-all-designs-testing--simulation-guide)
   - [Level 1: Automated Unit & Physics Invariant Testing](#level-1-automated-unit--physics-invariant-testing)
   - [Level 2: Parameter Matrix Exploration & Pareto Solver (CLI)](#level-2-parameter-matrix-exploration--pareto-solver-cli)
   - [Level 3: End-to-End 12-Year Mission Lifecycle Simulation](#level-3-end-to-end-12-year-mission-lifecycle-simulation)
   - [Level 4: Interactive 3D Workspaces (Web UI)](#level-4-interactive-3d-workspaces-web-ui)
5. [Model Accuracy & Validation Reference Standards](#model-accuracy--validation-reference-standards)
6. [Codebase Architecture & Directory Layout](#codebase-architecture--directory-layout)

---

## Overview & Core Mission

Deploying high-density compute infrastructure into Earth orbit bypasses terrestrial land, power grid, and cooling water limits. However, space introduces severe physical constraints. Operating silicon in vacuum requires radiating 100% of electrical power as heat, surviving total ionizing radiation and solar cosmic rays, maintaining orbit against upper-atmospheric drag, and achieving economic parity against terrestrial power grids.

This testbed provides a rigorous, closed-loop physics engine with zero DOM dependencies in `src/sim/`, paired with a 3D visualization engine in `src/render/` and CLI exploration tools in `tools/`.

---

## Physics Invariants & Engineering Fundamentals

### 1. Thermal Management & Radiative Cooling
In vacuum, conduction and convection are impossible. Heat rejection depends strictly on thermal radiation into space, governed by the Stefan-Boltzmann law:

$$Q_{\text{emitted}} = A_{\text{rad}} \cdot \eta_{\text{fin}} \cdot \left( \sum \epsilon \sigma \left( T_{\text{rad}}^4 - T_{\text{cmb}}^4 \right) \right)$$

where $\sigma = 5.670374 \times 10^{-8} \text{ W/(m}^2 \cdot \text{K}^4)$, $\epsilon$ is infrared emissivity, and $\eta_{\text{fin}} \approx 0.85$ is radiator fin efficiency.

- **100% Thermal Conversion**: Electrical power consumed by IT hardware equals waste heat ($Q_{\text{heat}} = P_{\text{IT}}$).
- **Temperature Drop Penalty**: Heat moves through a thermal transport chain: Silicon Junction (358 K) $\to$ Liquid Coolant (333 K) $\to$ Radiator Surface (318 K). Because radiation scales with $T^4$, a 40 K drop reduces heat rejection capability by **~35%**.
- **Coating Degradation**: Z93 white radiator paint solar absorptivity $\alpha_s$ darkens from **0.17 at Beginning-of-Life (BOL) to 0.30 at End-of-Life (EOL ~10–12 yrs)** due to atomic oxygen and solar UV exposure, risking thermal runaway if sized only for BOL.

### 2. Space Radiation Environment & Reliability
Modeled parametrically in `src/sim/radiation.js` across orbital altitudes and inclinations:

- **Total Ionizing Dose (TID)**: Trapped protons/electrons accumulate charge in gate oxides, causing leakage currents and threshold shifts. Commercial COTS hardware tolerates ~5 krad(Si); upscreened COTS ~30 krad(Si); radiation-tolerant silicon ~100 krad(Si).
- **Single Event Upsets (SEU)**: Heavy ion and high-energy proton strikes cause memory bit flips in SRAM/DRAM. SECDED ECC memory mitigates 97%+ of single-bit events.
- **Single Event Latchup (SEL)**: Parasitic thyristor short-circuits across supply rails. Without sub-millisecond over-current protection and automatic power-cycling, devices undergo catastrophic thermal destruction.
- **Inner Proton Belt Limit**: Between 1,000 km and 10,000 km, radiation dose spikes to **>350 krad/year**. Unshielded commercial electronics fail within months.

### 3. Power Generation, Energy Storage & Eclipse Dynamics
- **Solar Array Sizing**: A 10 MW IT facility requires ~11.8 MW gross generation. At 30% solar cell efficiency, this demands **~37,000 m² of solar arrays** (a 192 m square).
- **Eclipse Battery Tax**: In mid-inclination orbits (e.g., 550 km at 51.6°), Earth's shadow obscures the Sun for ~35% of every 96-minute orbit. Maintaining 10 MW continuous compute requires carrying **>220 tonnes of Li-ion batteries**.
- **Dawn-Dusk Sun-Synchronous Orbit (SSO)**: Siting at ~98° inclination at 600–800 km keeps the spacecraft in perpetual sunlight year-round, **eliminating battery mass entirely**.

### 4. Atmospheric Drag & Orbital Decay
- High solar array and radiator surface areas result in a low **ballistic coefficient** ($B = m / (C_d A)$).
- Below 600 km, upper atmospheric drag induces rapid secular orbital decay. Siting at 400 km requires continuous high-impulse electric propulsion stationkeeping to avoid deorbiting within 1–2 years.

### 5. Downlink & Latency Constraints
- Downlinking multi-petabyte compute outputs over traditional RF (Ka/Ku band) hits bandwidth and spectrum limits.
- Optical (Laser) Inter-Satellite Links (OISL) providing 100 Gbps–1 Tbps cross-links paired with edge AI data reduction (processing raw data on-orbit) reduce downlinked data volume by up to 99%.

### 6. Launch Economics & Terrestrial Breakeven
- Evaluated against a terrestrial baseline ($2,099 per PFLOP-year at $0.07/kWh).
- At current launch costs ($1,500–$2,500/kg), space compute costs **5x to 15x more per PFLOP-year**.
- Financial parity requires next-generation reusable heavy lift (Starship class) achieving launch costs below **$150–$250/kg**.

---

## Exhaustive Outcomes & Engineering Solutions Matrix

| Subsystem / Issue | Failure Outcome | Viable Outcome Condition | Engineering Solution |
| :--- | :--- | :--- | :--- |
| **Thermal Rejection** | Thermal runaway; silicon junction exceeds 85°C; radiator area explodes to >40,000 m². | Stable equilibrium below junction limit over 12-year EOL. | **High-Tj Silicon (GaN/SiC operating up to 375K–400K)**: Reduces radiator area by up to 60-70%. Deployable liquid metal (GaInSn) loops and high-emissivity coatings. |
| **Radiation (TID)** | Electronics bricked within months due to oxide breakdown. | 10+ year survival with <5% compute capacity loss. | **Graded-Z Passive Shielding**: 10–20 mm Al-equivalent with inner high-Z liners. Siting outside the 1,000–10,000 km inner belt. |
| **Radiation (SEE/SEL)** | Latchup shorts power rails; memory bit flips corrupt model weights. | Zero single-point hardware destruction; 99.99% memory state integrity. | **Active Current Limiting**: Sub-millisecond Over-Current Protection (OCP) power switches. **SECDED ECC + Scrubbing**: Software Triple Modular Redundancy (TMR). |
| **Eclipse Power** | Battery mass exceeds 30% of total payload (200+ t); battery cycle death at Year 5. | Zero battery mass penalty; continuous solar power generation. | **Dawn-Dusk Sun-Synchronous Orbit (SSO)**: 97.9°–98.6° inclination orbit remains in perpetual sunlight, eliminating energy storage mass. |
| **Atmospheric Drag** | Spacecraft deorbits into atmosphere within 18 months. | Orbit stable for 12+ years with minimal propellant consumption. | **High-Isp Electric Propulsion**: Hall-effect or gridded ion thrusters ($I_{sp} > 3000\text{ s}$) using Argon/Krypton. Stationing above 600 km. |
| **Downlink Bottleneck** | Downlink pipe saturated; 95% of computed output stranded in orbit. | Terabit-scale high-throughput downlink. | **Optical Laser Downlink**: 100 Gbps to 1 Tbps laser transceivers. **Edge AI Data Filtering**: Process raw data on-orbit before transmission. |
| **Launch Economics** | Project cost 50x higher than terrestrial datacenter; commercial failure. | Cost parity ($/PFLOP-year) with terrestrial datacenters. | **Next-Gen Heavy Lift (Starship/New Glenn)**: Launch costs $\le \$200\text{/kg}$. High compute density per unit payload mass. |

---

## How to Test All Designs (Testing & Simulation Guide)

### Level 1: Automated Unit & Physics Invariant Testing
Verify that base models (USSA-76 atmosphere, Dormand-Prince integrators, J2 secular rates, Hohmann transfers) match reference values:

```bash
npm test
```

Run stress invariant sweeps over 3,888 ascents and 1,260 spacecraft designs:

```bash
npm run stress
```

### Level 2: Parameter Matrix Exploration & Pareto Solver (CLI)
Use `tools/explore.mjs` to execute multidimensional trade studies, compute Pareto fronts, and measure sensitivity fold-changes:

```bash
# 1. Orbit Band Study: Where can a datacenter live?
node tools/explore.mjs orbitBand --viable-only --pareto

# 2. Thermal Trade Study: Impact of running silicon hotter (330K to 400K)
node tools/explore.mjs thermalTrade --analyse

# 3. Shielding Trade Study: Aluminum thickness (1mm to 40mm) vs. silicon class
node tools/explore.mjs shieldingTrade --analyse

# 4. Fleet Comparison: Vehicle payload capacities and pad selection
node tools/explore.mjs fleetComparison --pareto --rank dvIdeal

# 5. Custom Multi-Axis Sweep Example
node tools/explore.mjs --custom design \
  --axis altitude=500e3,700e3,35786e3 \
  --axis junctionTemp=330,358.15,400 \
  --axis shieldingMm=2.54,10,20 \
  --base itPower=10e6,inclination=97.9 \
  --viable-only --pareto
```

### Level 3: End-to-End 12-Year Mission Lifecycle Simulation
Simulate complete 12-year operational campaigns including launch staging, assembly flights, array/battery degradation, thermal paint darkening, radiation accumulation, and deorbit disposal:

```bash
# 10 MW SSO Baseline Mission (700 km, 97.9° inclination)
node tools/mission.mjs --alt 700e3 --inc 97.9

# High Radiation Belt Failure Case (2,500 km altitude)
node tools/mission.mjs --alt 2500e3

# High Eclipse Battery Tax Case (550 km, 51.6° inclination)
node tools/mission.mjs --alt 550e3 --inc 51.6

# Megawatt Scaling Case (100 MW station)
node tools/mission.mjs --power 100e6
```

### Level 4: Interactive 3D Workspaces (Web UI)
Start the local dev server:

```bash
npm run dev
```

Open `http://localhost:5173` to interact with 6 dedicated workspaces:

| Workspace | Description & Functionality |
| :--- | :--- |
| **LAUNCH** | Vehicle, pad, payload, target orbit. 3DOF ascent with real staging, max-Q, and $\Delta V$ loss breakdown. |
| **DESIGN** | Compute load and orbit $\to$ closed mass/power/thermal budget plus a to-scale 3D procedural station model. |
| **ANALYSIS** | Cost vs. terrestrial datacenter, radiation total dose curves, downlink bandwidth, and breakeven launch cost solver. |
| **SWEEP** | Flie a single design across all altitudes from 300 km to GEO. |
| **EXPLORE** | Full parameter matrices, Pareto fronts, sensitivity charts, and table rankings. |
| **MISSION** | 3D mission playback across 5 phases: pad launch, ascent, orbital assembly, 12-year operation, and disposal. |

---

## Model Accuracy & Validation Reference Standards

Every model in `src/sim/` is validated against published reference values:

- **US Standard Atmosphere 1976**: Base pressures accurate to <0.03% via upward hydrostatic integration.
- **Dormand–Prince 5(4)**: Energy conservation held to $1.2 \times 10^{-10}$ and angular momentum to $6 \times 10^{-11}$ over 50 orbits.
- **J2 Secular Rates**: Matches ISS nodal regression of $-5.0^\circ/\text{day}$ and Sun-synchronous inclination of $98.6^\circ$ at 800 km.
- **Hohmann LEO$\to$GEO**: Returns $2426 + 1467 = 3893 \text{ m/s}$.
- **Falcon 9 Ascent**: Delivers 22.8 t to 400 km circular with max-Q at 39 kPa / 10.7 km.

---

## Codebase Architecture & Directory Layout

```
src/sim/         Physics engine — SI units throughout, zero DOM dependencies
  constants.js     CODATA 2018 / WGS84 / EGM96 physical constants
  atmosphere.js    USSA-76 + Vallado exponential model
  gravity.js       Point mass + J2/J3/J4 spherical harmonics + third-body gravity
  integrate.js     RK4 and adaptive Dormand-Prince 5(4) integrators
  frames.js        ECI/ECEF/geodetic frame conversions, GMST, solar ephemeris
  orbit.js         Keplerian elements, transfer orbits, J2 secular rates, eclipses, decay
  vehicles.js      Launch vehicle and launch pad database
  ascent.js        3DOF rocket ascent simulator: guidance, staging, aerodynamic losses
  thermal.js       Radiator sizing, radiative view factors, transient heating response
  power.js         Solar array sizing, battery DoD, eclipse energy storage
  radiation.js     Total Ionizing Dose (TID), SEU rates, Single Event Latchup (SEL)
  comms.js         RF/Optical link budgets, Shannon capacity, ground station passes
  datacenter.js    Integrated datacenter mass/power/thermal budget solver
  economics.js     Financial cost model and terrestrial comparison solver
  explore.js       Parameter matrix cartesian product, Pareto front solver, sensitivity
  mission.js       End-to-end launch $\to$ assembly $\to$ 12-year projection $\to$ disposal engine
src/render/      Three.js 3D graphics engine
  scene.js         WGS84 Earth globe, real coastlines, day/night lighting
  rocket.js        Procedural launch vehicle rendering from stage data
  station.js       Procedural datacenter rendering from sized budgets
  playback.js      5-phase mission playback and camera choreography
src/ui/          Interactive panels, widgets, and charts
tools/           CLI harnesses: stress.mjs, explore.mjs, mission.mjs
test/            Automated Vitest physics validation test suite
```

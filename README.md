# Orbital Datacenter Testbed

An interactive 3D environment for testing whether you can put a datacenter in
orbit — launch it, fly it, power it, cool it, and find out how it fails.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 156 validation assertions
npm run stress     # 84,000 invariant checks over the whole parameter space
npm run explore    # list the built-in parameter studies
node tools/mission.mjs   # end-to-end campaigns: launch, deploy, 12 years, ending
```

## Running variations

This is built for sweeping, not for admiring one case.

### In the app — the EXPLORE tab

Pick a question, hit RUN. Every combination is evaluated with the full physics
(no interpolation), then shown three ways: a ranked table, the **Pareto front**
(configurations that no other beats on every objective), and a **sensitivity**
readout telling you which knob actually drives the answer. Candidate orbits are
drawn in 3D, green if the design closes and red if it doesn't.

### On the CLI

```bash
node tools/explore.mjs                            # list studies
node tools/explore.mjs orbitBand --viable-only    # where a datacenter can live
node tools/explore.mjs shieldingTrade --analyse   # sensitivity + per-axis breakdown
node tools/explore.mjs fleetComparison --pareto --rank dvIdeal
node tools/explore.mjs inclinationCost --csv out.csv --json out.json

# arbitrary matrices
node tools/explore.mjs --custom design \
  --axis altitude=400e3,700e3,1200e3 \
  --axis itPower=1e6,1e7,1e8 \
  --base inclination=97.9,missionYears=10

# max payload by bisection on the full integrated trajectory
node tools/explore.mjs --maxpayload --alt 500e3
```

Built-in studies: `orbitBand`, `powerScaling`, `thermalTrade`, `shieldingTrade`,
`fleetComparison`, `inclinationCost`. Add your own in `STUDIES`
(`src/sim/explore.js`) — each is just axes plus a base config.

`paretoFront`, `sensitivity`, `groupBy`, `rank`, `toCsv` and `toJson` are all
exported, so you can drive a sweep from your own script.

## The workspaces

| Tab | What you do |
|---|---|
| **LAUNCH** | Vehicle, pad, payload, target orbit. 3DOF ascent with real staging, max-Q, and a full ΔV loss breakdown. |
| **DESIGN** | Compute load and orbit → closed mass/power/thermal budget plus a to-scale 3D model of the spacecraft. |
| **ANALYSIS** | Cost vs. a terrestrial datacenter, radiation, downlink. Solves for the breakeven launch price. |
| **SWEEP** | One design flown at every altitude from 300 km to GEO. |
| **EXPLORE** | Full parameter matrices, Pareto fronts, sensitivity. |
| **MISSION** | The whole campaign played back in 3D: a real vehicle flies the trajectory, the station assembles flight by flight, twelve years pass, and it ends however the engine says it does. |

`Space` play/pause · `F` follow vehicle · scroll to zoom (the spacecraft is
drawn at true scale, so you can fly right up to it).

## Mission playback

The MISSION tab runs a full campaign end to end and renders it, in five phases:
pad, ascent, deployment, operations, outcome.

Nothing in the scene is a drawing. The launch vehicle is generated from its own
stage data — tank length is propellant mass over bulk density over
cross-section — so the vehicles differ because their propellants do. Hydrolox is
a third the density of kerolox, which is why SLS has a fat core and Ariane 6 a
small one swamped by solids. Against published heights the model lands at 68 m
for Falcon 9 (real 70), 121 m for Starship (121), 19 m for Electron (18) and
42 m for a Falcon Heavy side booster (42). Vehicles whose stage masses are
estimates come out short, and inherit that flagged uncertainty rather than being
tuned to match.

The station is the scenario's own design: eight radiator panels really do sum to
the computed `thermal.area`, four array wings to `power.array.area`. Change the
orbit, the eclipse fraction changes, the array area changes, and the structure
on screen grows.

The ending is whichever limit the projection reaches first — planned end of
life, propellant exhausted and the orbit decaying into the atmosphere, total
dose exceeding what the electronics tolerate, or thermal runaway. That last one
is driven by a real mechanism: radiator coatings do not lose emissivity, they
gain solar absorptivity. Z93 white paint darkens from alpha 0.17 to 0.30 over a
mission, so a radiator sized at beginning-of-life absorptivity slowly stops
being able to shed the heat its own computers make.

## Accuracy

Every model is a published one, validated against external reference values —
standards' own tables, textbook worked examples, or well-known operational
figures. No expected value in the test suite is captured from this code's own
output, which would only prove self-consistency.

- **US Standard Atmosphere 1976** reproduces its published layer base pressures
  to <0.03% by upward hydrostatic integration.
- **Dormand–Prince 5(4)** holds specific energy to 1.2e-10 and angular momentum
  to 6e-11 over 50 orbits.
- **Element conversion** matches Curtis Example 4.3 on all six elements.
- **J2 secular rates** give ISS nodal regression of −5.0°/day and a
  sun-synchronous inclination of 98.6° at 800 km.
- **Hohmann LEO→GEO** returns 2426 + 1467 = 3893 m/s.
- **Falcon 9** delivers its published 22.8 t to 400 km circular, with max-Q
  emerging at 39 kPa / 10.7 km — neither is an input.
- **GEO eclipse** lasts ~70 minutes at equinox from exact disk-overlap geometry.

Beyond the unit tests, `npm run stress` sweeps 3,888 ascents and 1,260 designs
and asserts invariants that must hold for *any* input: no NaN anywhere, mass
budgets that close, monotonic physical trends, and the exact ΔV identity
`|v| = |v₀| + ideal − gravity − drag − steering`. 84,439 checks, all passing.

Confidence is **not** uniform, and the in-app *MODELS & LIMITS* panel states it
per model:

- Gravity, geodesy, orbital mechanics, integration — exact to the coefficients used.
- Lower atmosphere — reproduces USSA-76 tables.
- Upper atmosphere — mean solar activity, factor of ~2 (inherent; even
  NRLMSISE-00 carries 15–30%).
- Launch vehicle aerodynamics — generic slender-body shape model, ±tens of percent.
- **Radiation — order of magnitude only.** A parametric fit, not AP-9/AE-9
  through a transport code. The *structure* it produces is robust; the
  individual numbers are not.
- **Cost — commercial assumptions, not physics.** Named and editable.

The ascent sim is 3DOF: no rotational dynamics, control authority, winds, or
engine-out. It will fly a trajectory no real vehicle could hold — the q·α
readout exists so that this is visible rather than silent.

### Known limits

Vulcan Centaur is the one vehicle the guidance handles poorly across the board.
Its Centaur V sits at a thrust-to-weight near 0.29 and takes 19 minutes to empty
its tanks; real missions fly a multi-burn profile with proper closed-loop
targeting, which this simulator does not implement. Vehicles are also marginal
at exactly their published rated payload, which is expected — that figure is a
theoretical maximum against an optimised trajectory.

## What the physics settles

- **All electrical power becomes heat.** No work leaves the system, so thermal
  load equals electrical load exactly. A radiator rejects ~1 kW/m². A 10 MW
  facility needs ~13,000 m² of radiator — a 114 m square — and that is not a
  design choice.
- **Solar arrays are bigger still**, ~37,000 m² for the same 10 MW.
- **Radiators and arrays outweigh the computers**, by a lot.
- **Batteries dominate LEO mass budgets** — 30% depth of discharge for cycle
  life, ~5500 cycles a year. A dawn–dusk sun-synchronous orbit deletes the line
  item entirely.
- **Those areas wreck the ballistic coefficient**, so drag sets the deorbit
  clock below ~700 km regardless of mass.
- **The viable altitude band is narrow and discontinuous**: drag rules out the
  bottom, the inner proton belt rules out 1000–20000 km, GEO reappears above it.
- **Shielding saturates.** Going 1 mm → 20 mm lifts viability from 25% to 67%;
  40 mm buys nothing for twice the mass.
- **At Starship-class prices, launch stops being the dominant cost.**
  Space-qualified hardware is — which inverts the usual framing.

## Layout

```
src/sim/         physics — SI units throughout, no DOM, no framework
  constants.js     CODATA 2018 / WGS84 / EGM96, each value cited inline
  atmosphere.js    USSA-76 + Vallado exponential + F10.7 correction
  gravity.js       point mass + J2/J3/J4 zonals, third-body
  integrate.js     RK4 and adaptive Dormand-Prince 5(4) with event bisection
  frames.js        ECI/ECEF/geodetic, GMST, solar ephemeris
  orbit.js         elements, Kepler, transfers, J2 secular, eclipse, decay
  vehicles.js      vehicle + launch site database, incl. strap-on boosters
  ascent.js        3DOF ascent: guidance, staging, parallel burn, loss accounting
  thermal.js       radiator sizing, view factors, transient response
  power.js         arrays, batteries, eclipse, distribution
  radiation.js     dose, SEU, latchup  (least certain module)
  comms.js         link budget, Shannon, ground station coverage
  datacenter.js    integrates all of the above into one closed design
  economics.js     cost model and terrestrial comparison
  explore.js       parameter matrices, Pareto fronts, sensitivity
  mission.js       launch -> deployment -> 12-year projection -> disposal
  explore.js       parameter matrices, Pareto fronts, sensitivity, export
src/render/      three.js scene, overlays, and mission playback
  scene.js         WGS84 globe, real coastlines, day/night, log depth buffer
  rocket.js        procedural launch vehicles from stage data
  station.js       procedural datacenter from the sized design
  playback.js      five-phase mission playback and camera choreography
src/ui/          panels, charts, widgets
tools/           stress harness and explorer CLI
test/            156 validation assertions
```

Angles are radians everywhere inside `src/sim`; degrees appear only at the UI
boundary. Scene units are 1 unit = 1000 km, converted in exactly one place.

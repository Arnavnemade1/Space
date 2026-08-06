/**
 * The "MODELS & LIMITS" panel.
 *
 * This exists because a simulator that looks confident is dangerous. Every
 * model here has a validity range and an error bar, and they differ by orders
 * of magnitude between subsystems. Anyone using a number out of this tool
 * should be able to find out in one click how much to trust it.
 */

export const MODELS_DOC = `
<h2>MODELS &amp; LIMITS</h2>

<p>Every model in this simulator is a named, published one, and each is
validated against external reference values by the test suite
(<code>npm test</code>, 156 assertions). Confidence varies enormously between
subsystems, so the table below states it explicitly rather than letting a
uniform interface imply uniform accuracy.</p>

<table>
  <tr><th>Subsystem</th><th>Model</th><th>Confidence</th></tr>
  <tr><td>Gravity</td><td class="mono">EGM96 J2/J3/J4 zonal harmonics</td><td>Exact to the coefficients used</td></tr>
  <tr><td>Geodesy</td><td class="mono">WGS84 ellipsoid, Bowring inversion</td><td>Sub-millimetre</td></tr>
  <tr><td>Atmosphere 0–86 km</td><td class="mono">US Standard Atmosphere 1976</td><td>Reproduces published tables to &lt;0.1%</td></tr>
  <tr><td>Atmosphere 86–1000 km</td><td class="mono">Vallado piecewise-exponential</td><td>Mean solar activity; factor ~2</td></tr>
  <tr><td>Thermospheric variation</td><td class="mono">F10.7/Ap scale-height correction</td><td>Order of magnitude</td></tr>
  <tr><td>Integration</td><td class="mono">Dormand–Prince 5(4), adaptive</td><td>1e-10 relative energy drift / 50 orbits</td></tr>
  <tr><td>Solar ephemeris</td><td class="mono">Astronomical Almanac low-precision</td><td>0.01° (1950–2050)</td></tr>
  <tr><td>Eclipse</td><td class="mono">Exact solar/Earth disk overlap</td><td>Geometrically exact; no limb darkening</td></tr>
  <tr><td>Thermal</td><td class="mono">Stefan–Boltzmann + albedo/IR view factors</td><td>Physics exact; coatings representative</td></tr>
  <tr><td>Launch vehicles</td><td class="mono">Published stage data where available</td><td>Marked per vehicle</td></tr>
  <tr><td>Aerodynamics</td><td class="mono">Generic slender-body C<sub>d</sub>(Mach)</td><td>Shape model; ±tens of percent</td></tr>
  <tr><td>Radiation</td><td class="mono">Parametric fit to reference orbits</td><td><strong>Order of magnitude only</strong></td></tr>
  <tr><td>Cost</td><td class="mono">Named editable assumptions</td><td>Commercial, not physical</td></tr>
</table>

<h3>What the ascent simulation does not model</h3>
<p>It is 3DOF: a point mass with a thrust vector. There are no rotational
dynamics, no control authority limits, no gimbal rates, no bending modes, no
winds, no engine-out, no propellant slosh or residuals. It will fly a
trajectory no real vehicle could hold and report it without complaint — the
q·α readout exists so that this is visible rather than silent. Booster recovery
deducts reserved propellant but does not fly the return trajectory.</p>

<h3>Where the numbers come from</h3>
<p>Constants are CODATA 2018, WGS84 and IAU values. Vehicle stage masses and
thrusts are published figures where an operator has released them; vehicles
still in development are marked <code>ESTIMATED</code> in the selector and
their payload figures are stated targets, not demonstrated performance.</p>

<h3>The radiation model deserves a specific warning</h3>
<p>Real dose prediction runs AP-9/AE-9 trapped-particle maps through a
transport code such as SHIELDOSE-2 against a specific spacecraft geometry.
This uses a log-interpolated fit through commonly cited dose figures at a
handful of reference orbits. The individual numbers carry a factor of several.
The <em>structure</em> is robust and is what the tool is actually for: LEO
below ~600 km is benign, the inner proton belt from roughly 1000–10000 km is
not survivable for dense commercial electronics at any realistic shielding
mass, and GEO is moderate.</p>

<h3>Things the physics settles that intuition does not</h3>
<ul>
  <li><strong>All electrical power becomes heat.</strong> No work leaves the
  system and no mass flow carries enthalpy away, so the thermal load equals the
  electrical load exactly. A radiator rejects roughly 1 kW/m². The radiator
  area is therefore not a design choice.</li>
  <li><strong>Rejection scales as T⁴</strong>, so the temperature drop from
  silicon junction to radiator surface is expensive. A 40 K drop costs about a
  third of the rejection capability.</li>
  <li><strong>Batteries dominate LEO mass budgets.</strong> Depth of discharge
  is limited to ~30% for cycle life, so the pack is roughly three times the
  energy actually needed — and a LEO orbit demands ~5500 cycles a year. A
  dawn-dusk sun-synchronous orbit eliminates this entirely.</li>
  <li><strong>Huge arrays make terrible ballistic coefficients.</strong> The
  drag area that comes with hundreds of thousands of square metres of array is
  what sets the deorbit clock, not the vehicle's mass.</li>
  <li><strong>Launch site latitude dictates inclination.</strong> The orbit
  plane must pass through the pad. Changing inclination on orbit costs
  2·v·sin(Δi/2) — 3.8 km/s for 30° in LEO, more than an entire upper stage.</li>
</ul>

<h3>Running variations</h3>
<p>The <strong>EXPLORE</strong> tab sweeps a whole parameter matrix and
evaluates every combination with the full physics — no interpolation. Results
come back three ways: ranked, as a <em>Pareto front</em> (configurations no
other beats on every objective), and as a <em>sensitivity</em> readout showing
which axis actually drives the answer. Candidate orbits are drawn in the
viewport, green where the design closes.</p>
<p>The same sweeps run headless with CSV/JSON export:
<code>node tools/explore.mjs orbitBand --analyse --csv out.csv</code>, and
arbitrary matrices via <code>--custom</code>. There is also a stress harness,
<code>npm run stress</code>, which sweeps 3,888 ascents and 1,260 designs
asserting invariants that must hold for any input — no NaN anywhere, mass
budgets that close, monotonic physical trends, and the exact delta-v identity.
84,439 checks.</p>

<h3>Known limits</h3>
<p>Vulcan Centaur is handled poorly across the board. Its Centaur V sits at a
thrust-to-weight near 0.29 and takes 19 minutes to empty its tanks; real
missions fly a multi-burn profile with proper closed-loop targeting, which this
simulator does not implement. Vehicles are also marginal at exactly their
published rated payload — that figure is a theoretical maximum against an
optimised trajectory, so falling a little short of it is the expected result
rather than a fault.</p>

<h3>Keyboard</h3>
<p><code>Space</code> play/pause · <code>F</code> follow vehicle ·
<code>Esc</code> close · scroll to zoom (the spacecraft is drawn to scale, so
you can fly right up to it)</p>
`;

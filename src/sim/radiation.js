/**
 * Radiation environment and its effect on electronics.
 *
 * READ THIS BEFORE TRUSTING ANY NUMBER FROM THIS FILE.
 *
 * This is by a wide margin the least certain module in the simulator, and it
 * would be dishonest to present it with the same confidence as the orbital
 * mechanics. Real dose prediction uses the AP-8/AE-8 or AP-9/AE-9 trapped
 * particle models -- multi-megabyte empirical maps -- run through a shielding
 * transport code such as SHIELDOSE-2 or Geant4, against a specific spacecraft
 * geometry. Reproducing that is out of scope here.
 *
 * What this module provides instead is a parametric model anchored to
 * commonly cited dose figures at a handful of reference orbits, log-
 * interpolated in between. Treat the numbers as ORDER OF MAGNITUDE. They are
 * good enough to answer the question that actually matters for siting an
 * orbital datacenter, because that answer is not subtle:
 *
 *   - Below ~600 km, dose is low and commercial parts are viable.
 *   - Between roughly 1000 and 10000 km lies the inner proton belt, where dose
 *     rates are 2-3 orders of magnitude higher. Nobody puts long-lived
 *     electronics there, and no plausible shielding mass fixes it.
 *   - GEO is moderate: dominated by outer-belt electrons and solar events,
 *     manageable with normal spacecraft practice.
 *
 * That structure is robust even though the individual numbers carry a factor
 * of a few. Every function here returns an `uncertainty` field to keep that
 * visible at the call site.
 */

import { R_EARTH_EQ, DEG } from './constants.js';

/**
 * Reference annual total ionising dose behind 2.54 mm (100 mil) of aluminium,
 * in rad(Si) per year, for near-circular orbits at low-to-moderate inclination.
 *
 * [altitude km, dose rad(Si)/year]
 *
 * The peak near 3000-5000 km is the inner proton belt; the secondary structure
 * around 15000-20000 km is the outer electron belt. The dip between them near
 * 8000-10000 km is the classic "slot region".
 */
const DOSE_ANCHORS = [
  [200, 30],
  [400, 300],
  [600, 1.2e3],
  [800, 3.5e3],
  [1000, 1.0e4],
  [1500, 5.0e4],
  [2000, 1.2e5],
  [3000, 3.0e5],
  [5000, 3.5e5],
  [8000, 8.0e4],
  [10000, 4.0e4],
  [15000, 5.0e4],
  [20200, 3.0e4],
  [25000, 1.5e4],
  [35786, 6.0e3],
  [50000, 2.0e3],
];

/**
 * Log-log interpolation of the dose anchors.
 * Dose varies over four orders of magnitude across this altitude range, so
 * linear interpolation between anchors would be badly wrong in between.
 */
function interpolateDose(altitudeKm) {
  if (altitudeKm <= DOSE_ANCHORS[0][0]) {
    return DOSE_ANCHORS[0][1] * (altitudeKm / DOSE_ANCHORS[0][0]) ** 2;
  }
  const last = DOSE_ANCHORS[DOSE_ANCHORS.length - 1];
  if (altitudeKm >= last[0]) return last[1];

  for (let i = 1; i < DOSE_ANCHORS.length; i++) {
    const [a1, d1] = DOSE_ANCHORS[i];
    if (altitudeKm <= a1) {
      const [a0, d0] = DOSE_ANCHORS[i - 1];
      const f = (Math.log(altitudeKm) - Math.log(a0)) / (Math.log(a1) - Math.log(a0));
      return Math.exp(Math.log(d0) + f * (Math.log(d1) - Math.log(d0)));
    }
  }
  return last[1];
}

/**
 * Inclination multiplier.
 *
 * Two competing effects. Low-inclination LEO passes repeatedly through the
 * South Atlantic Anomaly, where the inner belt dips to ~200 km because the
 * geomagnetic field is offset from the planet's centre. High-inclination
 * orbits miss much of the SAA but cross the polar horns, where the field lines
 * are open to galactic cosmic rays and solar particle events.
 *
 * The net is a shallow minimum around 30-50 deg and a rise toward polar.
 */
export function inclinationFactor(inclinationDeg) {
  const i = Math.abs(inclinationDeg);
  const saa = 1.0 + 0.35 * Math.exp(-(((i - 15) / 25) ** 2));
  const polar = 1.0 + 0.9 * Math.exp(-(((i - 90) / 30) ** 2));
  return saa * polar * 0.75;
}

/**
 * Shielding attenuation factor for aluminium.
 *
 * Dose behind shielding falls steeply at first (stopping the soft electron
 * spectrum) then flattens as the remaining flux is penetrating protons and
 * bremsstrahlung that no realistic mass will stop. The classic lesson is that
 * going from 2.5 mm to 10 mm buys a lot, and going from 10 mm to 40 mm buys
 * very little for eight times the mass.
 *
 * Normalised to 1.0 at the 2.54 mm reference thickness.
 */
export function shieldingFactor(thicknessMm) {
  const t = Math.max(0.1, thicknessMm);
  // Two-component fit: a steep electron term plus a shallow penetrating floor.
  const soft = 0.85 * Math.exp(-(t - 2.54) / 2.2);
  const hard = 0.15 * Math.pow(2.54 / t, 0.35);
  return Math.max(0.02, soft + hard);
}

/** Areal mass of an aluminium shield [kg/m^2]. Aluminium density 2700 kg/m^3. */
export const shieldArealMass = (thicknessMm) => (thicknessMm / 1000) * 2700;

/**
 * Annual total ionising dose for an orbit [rad(Si)/year].
 *
 * @param {object} cfg
 * @param {number} cfg.altitude      [m] (mean altitude for eccentric orbits)
 * @param {number} cfg.inclination   [deg]
 * @param {number} [cfg.shieldingMm] aluminium equivalent [mm]
 * @param {number} [cfg.solarActivityFactor] 0.7 (solar max, inner belt suppressed)
 *                 to 1.4 (solar min, inner belt enhanced)
 */
export function annualDose({
  altitude,
  inclination = 0,
  shieldingMm = 2.54,
  solarActivityFactor = 1.0,
}) {
  const altKm = altitude / 1000;
  const base = interpolateDose(altKm);
  const dose = base * inclinationFactor(inclination) * shieldingFactor(shieldingMm) * solarActivityFactor;

  return {
    radPerYear: dose,
    kradPerYear: dose / 1000,
    shieldingFactor: shieldingFactor(shieldingMm),
    inclinationFactor: inclinationFactor(inclination),
    shieldArealMass: shieldArealMass(shieldingMm),
    uncertainty: 'order-of-magnitude; parametric fit, not AP-9/AE-9 + transport',
  };
}

/**
 * Typical total-dose tolerance of electronics classes [rad(Si)].
 * Commercial parts vary enormously part to part -- some commercial CMOS
 * survives 100 krad, some fails at 3 krad -- so the commercial figure here is
 * a conservative planning number, not a specification.
 */
export const DOSE_TOLERANCE = {
  commercialCots: { name: 'Commercial off-the-shelf', tolerance: 5e3 },
  upscreenedCots: { name: 'Upscreened COTS', tolerance: 3e4 },
  radTolerant: { name: 'Radiation-tolerant', tolerance: 1e5 },
  radHard: { name: 'Radiation-hardened', tolerance: 1e6 },
};

/**
 * Years until an electronics class reaches its total-dose limit.
 * This is a wear-out lifetime, not a failure prediction: parts degrade
 * gradually (leakage rises, timing slips) rather than stopping at a threshold.
 */
export function doseLifetime(annualRad, tolerance) {
  if (annualRad <= 0) return Infinity;
  return tolerance / annualRad;
}

/**
 * Single event upset rate.
 *
 * SEUs are caused by single ionising particles depositing charge in a storage
 * node, and unlike total dose they do not accumulate -- the rate is what
 * matters. For a datacenter this is arguably the more interesting effect,
 * because the memory footprint is enormous.
 *
 * `baseRatePerBitPerDay` is the dominant uncertainty and depends on process
 * node, cell design and critical charge. 1e-8 to 1e-6 per bit per day covers
 * most unhardened commercial memory in LEO. The default here is deliberately
 * mid-range; vary it and watch the answer move by two orders of magnitude,
 * which is an honest depiction of the state of knowledge.
 *
 * @returns upsets per day across the whole memory, plus mean time between
 *          upsets for a single machine.
 */
export function seuRate({
  memoryBytes,
  altitude,
  inclination = 0,
  baseRatePerBitPerDay = 1e-7,
  shieldingMm = 2.54,
  eccMitigation = true,
}) {
  const altKm = altitude / 1000;
  // SEU rate tracks the trapped-particle environment but far more weakly than
  // total dose: much of the LEO rate is galactic cosmic rays, which shielding
  // barely touches and which are nearly isotropic.
  const environment = Math.pow(interpolateDose(altKm) / interpolateDose(400), 0.45);
  const shield = Math.pow(shieldingFactor(shieldingMm), 0.35);
  const inc = 1 + 0.6 * Math.exp(-(((Math.abs(inclination) - 90) / 35) ** 2));

  const bits = memoryBytes * 8;
  const rawPerDay = bits * baseRatePerBitPerDay * environment * shield * inc;

  // Single-error-correcting ECC catches essentially all single-bit upsets. It
  // does not catch multi-bit upsets in one word, which are a few percent of
  // events at modern feature sizes and rise with particle LET.
  const multiBitFraction = 0.03;
  const uncorrectedPerDay = eccMitigation ? rawPerDay * multiBitFraction : rawPerDay;

  return {
    rawUpsetsPerDay: rawPerDay,
    rawUpsetsPerSecond: rawPerDay / 86400,
    uncorrectedPerDay,
    meanTimeBetweenUncorrectedHours: uncorrectedPerDay > 0 ? 24 / uncorrectedPerDay : Infinity,
    environmentFactor: environment,
    uncertainty:
      'base rate spans two orders of magnitude across real devices; treat as a ' +
      'sensitivity parameter rather than a prediction',
  };
}

/**
 * Single event latchup risk, the failure mode that actually destroys hardware.
 *
 * A latchup shorts a parasitic thyristor across the supply; if the current is
 * not interrupted within milliseconds the device is destroyed. Terrestrial
 * servers have no protection for this because it essentially never happens at
 * sea level. In orbit every power domain needs current-limiting and power
 * cycling, which is a real design burden rarely accounted for in
 * "just put the racks in space" proposals.
 */
export function latchupRate({ deviceCount, altitude, inclination = 0, ratePerDevicePerDay = 1e-6 }) {
  const environment = Math.pow(interpolateDose(altitude / 1000) / interpolateDose(400), 0.5);
  const inc = 1 + 0.5 * Math.exp(-(((Math.abs(inclination) - 90) / 35) ** 2));
  const perDay = deviceCount * ratePerDevicePerDay * environment * inc;
  return {
    eventsPerDay: perDay,
    eventsPerYear: perDay * 365.25,
    meanTimeBetweenEventsHours: perDay > 0 ? 24 / perDay : Infinity,
  };
}

/**
 * Classify an orbit's radiation environment into a plain verdict.
 * The band boundaries are deliberately coarse -- see the module header.
 */
export function radiationVerdict(altitude, inclination, shieldingMm = 2.54) {
  const dose = annualDose({ altitude, inclination, shieldingMm });
  const krad = dose.kradPerYear;

  let band;
  let verdict;
  if (krad < 1) {
    band = 'benign';
    verdict = 'Commercial parts viable with normal ECC and watchdog practice.';
  } else if (krad < 10) {
    band = 'moderate';
    verdict = 'Upscreened commercial parts; expect measurable degradation over a decade.';
  } else if (krad < 100) {
    band = 'harsh';
    verdict = 'Radiation-tolerant parts and active shielding needed; commercial silicon will not last.';
  } else {
    band = 'severe';
    verdict =
      'Inner radiation belt. Not a viable location for dense commercial electronics ' +
      'at any realistic shielding mass.';
  }

  return { ...dose, band, verdict };
}

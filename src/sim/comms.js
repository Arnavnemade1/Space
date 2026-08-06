/**
 * Communications link budget and downlink capacity.
 *
 * A datacenter that cannot move data is a space heater. This module answers
 * the question that most orbital-datacenter proposals skip: how much
 * bandwidth can you actually get to the ground, and what does it cost in
 * aperture, power and ground infrastructure?
 *
 * The physics is unforgiving in a specific way. Free space path loss goes as
 * (4*pi*d/lambda)^2 -- quadratic in distance, but also quadratic in frequency,
 * which is why higher frequency is not automatically worse: antenna gain for a
 * fixed aperture also goes as f^2, and the two cancel. What does not cancel is
 * rain: above ~20 GHz a heavy rain cell can close a link entirely, and optical
 * links simply do not pass through cloud at all.
 */

import { C_LIGHT, K_BOLTZMANN, R_EARTH_EQ, MU_EARTH, DEG } from './constants.js';

/** dB helpers. */
export const toDb = (x) => 10 * Math.log10(x);
export const fromDb = (db) => Math.pow(10, db / 10);

/** Wavelength from frequency [m]. */
export const wavelength = (frequencyHz) => C_LIGHT / frequencyHz;

/**
 * Free space path loss [dB].
 * FSPL = 20 log10(4*pi*d/lambda)
 */
export function freeSpacePathLoss(distance, frequencyHz) {
  return 20 * Math.log10((4 * Math.PI * distance) / wavelength(frequencyHz));
}

/**
 * Gain of a circular aperture antenna [dBi].
 * G = eta * (pi * D / lambda)^2
 * `efficiency` of 0.55-0.70 is typical for a real reflector.
 */
export function apertureGain(diameter, frequencyHz, efficiency = 0.6) {
  const lam = wavelength(frequencyHz);
  return toDb(efficiency * ((Math.PI * diameter) / lam) ** 2);
}

/** Half-power beamwidth of a circular aperture [deg]. */
export function beamwidth(diameter, frequencyHz) {
  return (70 * wavelength(frequencyHz)) / diameter;
}

/** Common downlink bands. */
export const BANDS = {
  sBand:  { name: 'S-band',  frequency: 2.2e9,   rainMarginDb: 0.3,  maxBandwidth: 20e6 },
  xBand:  { name: 'X-band',  frequency: 8.4e9,   rainMarginDb: 1.5,  maxBandwidth: 375e6 },
  kuBand: { name: 'Ku-band', frequency: 14e9,    rainMarginDb: 4,    maxBandwidth: 1e9 },
  kaBand: { name: 'Ka-band', frequency: 26e9,    rainMarginDb: 8,    maxBandwidth: 3.5e9 },
  vBand:  { name: 'V-band',  frequency: 50e9,    rainMarginDb: 20,   maxBandwidth: 5e9 },
  optical:{ name: 'Optical (1550 nm)', frequency: 193.4e12, rainMarginDb: 0, maxBandwidth: 100e9 },
};

/**
 * Full RF link budget.
 *
 * Received power:
 *   Pr = Pt + Gt - L_path - L_atm - L_pointing + Gr
 * Noise power:
 *   N = k * T_system * B
 *
 * @param {object} cfg
 * @param {number} cfg.transmitPower      [W]
 * @param {number} cfg.transmitDiameter   [m]
 * @param {number} cfg.receiveDiameter    [m] ground station
 * @param {number} cfg.distance           [m] slant range
 * @param {number} cfg.frequency          [Hz]
 * @param {number} [cfg.bandwidth]        [Hz]
 * @param {number} [cfg.systemNoiseTemp]  [K]
 */
export function linkBudget(cfg) {
  const {
    transmitPower,
    transmitDiameter,
    receiveDiameter,
    distance,
    frequency,
    bandwidth = 500e6,
    systemNoiseTemp = 150,
    apertureEfficiency = 0.6,
    pointingLossDb = 0.5,
    atmosphericLossDb = 1.0,
    rainMarginDb = 0,
    implementationLossDb = 2.0,
    requiredEbN0Db = 4.0, // modern LDPC near the Shannon limit
  } = cfg;

  const gt = apertureGain(transmitDiameter, frequency, apertureEfficiency);
  const gr = apertureGain(receiveDiameter, frequency, apertureEfficiency);
  const fspl = freeSpacePathLoss(distance, frequency);

  const eirpDbW = toDb(transmitPower) + gt - pointingLossDb;
  const receivedDbW =
    eirpDbW - fspl - atmosphericLossDb - rainMarginDb + gr - implementationLossDb;

  const noiseDbW = toDb(K_BOLTZMANN * systemNoiseTemp * bandwidth);
  const snrDb = receivedDbW - noiseDbW;
  const snr = fromDb(snrDb);

  // Shannon capacity is the hard ceiling; real modems reach 80-90% of it with
  // modern coding, so the practical figure is derived from the required Eb/N0.
  const shannonCapacity = bandwidth * Math.log2(1 + snr);

  // Achievable rate given the required Eb/N0: Eb/N0 = (C/N) * (B/R)
  const cn0Db = receivedDbW - toDb(K_BOLTZMANN * systemNoiseTemp);
  const achievableRate = fromDb(cn0Db - requiredEbN0Db);

  return {
    transmitGainDbi: gt,
    receiveGainDbi: gr,
    eirpDbW,
    pathLossDb: fspl,
    receivedPowerDbW: receivedDbW,
    receivedPowerW: fromDb(receivedDbW),
    noisePowerDbW: noiseDbW,
    snrDb,
    cn0DbHz: cn0Db,
    shannonCapacityBps: shannonCapacity,
    achievableRateBps: Math.min(achievableRate, shannonCapacity),
    linkMarginDb: snrDb - requiredEbN0Db,
    closed: snrDb > requiredEbN0Db,
    beamwidthDeg: beamwidth(transmitDiameter, frequency),
  };
}

/**
 * Optical (laser) downlink.
 *
 * Handled separately because the gain formula, the noise mechanism and the
 * failure mode are all different. Optical terminals achieve enormous gain from
 * small apertures -- a 10 cm telescope at 1550 nm has more gain than a 30 m
 * dish at Ka-band -- but the beam is so narrow (microradians) that pointing
 * becomes the dominant engineering problem, and cloud cover blocks the link
 * outright. Availability, not capacity, is the constraint.
 */
export function opticalLinkBudget(cfg) {
  const {
    transmitPower,           // [W] optical
    transmitAperture = 0.1,  // [m]
    receiveAperture = 1.0,   // [m]
    distance,
    wavelengthM = 1550e-9,
    pointingErrorRad = 1e-6,
    opticalEfficiency = 0.5,
    detectorSensitivityPhotonsPerBit = 10,
    cloudFreeProbability = 0.7,
  } = cfg;

  // Diffraction-limited transmit gain: Gt = (pi * D / lambda)^2
  const gt = (Math.PI * transmitAperture / wavelengthM) ** 2;
  // Far-field beam divergence and the resulting spot size at the ground.
  const divergence = (1.22 * wavelengthM) / transmitAperture;
  const spotDiameter = 2 * divergence * distance;

  // Fraction of the transmitted beam intercepted by the receive aperture.
  const captureFraction = Math.min(1, (receiveAperture / spotDiameter) ** 2);

  // Pointing loss: Gaussian beam, error relative to divergence.
  const pointingLoss = Math.exp(-2 * (pointingErrorRad / divergence) ** 2);

  const receivedPower =
    transmitPower * captureFraction * opticalEfficiency * pointingLoss;

  const photonEnergy = (6.62607015e-34 * C_LIGHT) / wavelengthM;
  const photonsPerSecond = receivedPower / photonEnergy;
  const rate = photonsPerSecond / detectorSensitivityPhotonsPerBit;

  return {
    transmitGainDbi: toDb(gt),
    divergenceRad: divergence,
    spotDiameterAtGround: spotDiameter,
    captureFraction,
    pointingLossDb: toDb(pointingLoss),
    receivedPowerW: receivedPower,
    photonsPerSecond,
    achievableRateBps: rate,
    // The number that actually matters operationally.
    availabilityFraction: cloudFreeProbability,
    effectiveRateBps: rate * cloudFreeProbability,
    note:
      'Optical capacity is rarely the constraint; cloud cover and pointing are. ' +
      'Sizing a system on clear-sky capacity overstates delivered throughput by ' +
      'roughly the cloud-free fraction.',
  };
}

/**
 * Slant range from a ground station to a satellite at a given elevation angle.
 * Law of cosines on the Earth-station-satellite triangle.
 *
 * @param {number} orbitRadius [m]
 * @param {number} elevationDeg minimum usable elevation [deg]
 */
export function slantRange(orbitRadius, elevationDeg = 10) {
  const el = elevationDeg * DEG;
  const re = R_EARTH_EQ;
  return Math.sqrt(orbitRadius ** 2 - (re * Math.cos(el)) ** 2) - re * Math.sin(el);
}

/**
 * Contact geometry for a circular orbit over a single ground station.
 *
 * `passFraction` is the fraction of each orbit spent above the minimum
 * elevation for a station on the ground track. Real coverage is lower because
 * the ground track precesses; this is the best case for a station directly
 * under the orbit.
 */
export function contactGeometry(orbitRadius, elevationDeg = 10) {
  const el = elevationDeg * DEG;
  const re = R_EARTH_EQ;

  // Central angle from station to the horizon-crossing point.
  const lambda = Math.acos((re / orbitRadius) * Math.cos(el)) - el;

  const period = 2 * Math.PI * Math.sqrt(orbitRadius ** 3 / MU_EARTH);
  const passFraction = lambda / Math.PI;

  return {
    horizonHalfAngleRad: lambda,
    maxPassDuration: (2 * lambda / (2 * Math.PI)) * period,
    passFraction,
    slantRangeMax: slantRange(orbitRadius, elevationDeg),
    slantRangeMin: orbitRadius - re,
    // Footprint radius on the ground.
    footprintRadius: re * lambda,
    footprintArea: 2 * Math.PI * re ** 2 * (1 - Math.cos(lambda)),
  };
}

/**
 * Ground stations needed to sustain an average downlink rate.
 *
 * Combines per-pass capacity with visibility. Continuous coverage from LEO
 * needs either a large ground network or a relay constellation -- the reason
 * NASA built TDRSS and the reason commercial LEO operators lease ground
 * station networks rather than building one site.
 */
export function downlinkCapacity({
  orbitRadius,
  peakRateBps,
  elevationDeg = 10,
  stationCount = 1,
  availability = 0.9,
}) {
  const geom = contactGeometry(orbitRadius, elevationDeg);
  // Visibility saturates as stations are added: they overlap, and a satellite
  // can only talk to so many at once.
  const coverageFraction = Math.min(1, geom.passFraction * stationCount);
  const averageRate = peakRateBps * coverageFraction * availability;

  return {
    ...geom,
    coverageFraction,
    averageRateBps: averageRate,
    dailyVolumeBytes: (averageRate * 86400) / 8,
    stationsForContinuous: Math.ceil(1 / geom.passFraction),
  };
}

/**
 * Time to move a dataset over a link, and the comparison that usually decides
 * the architecture: whether it is faster to compute in orbit and downlink the
 * answer, or to not send the data up in the first place.
 */
export function transferTime(bytes, rateBps) {
  return (bytes * 8) / rateBps;
}

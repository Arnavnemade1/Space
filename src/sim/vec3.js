/**
 * Minimal 3-vector helpers operating on plain [x, y, z] arrays.
 *
 * Deliberately allocation-light and dependency-free: the integrator calls
 * these tens of thousands of times per simulated trajectory, and the physics
 * layer must not depend on the rendering layer's math library.
 */

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const neg = (a) => [-a[0], -a[1], -a[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm2 = (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];

export function unit(a) {
  const n = norm(a);
  if (n === 0) return [0, 0, 0];
  return [a[0] / n, a[1] / n, a[2] / n];
}

/** Angle between two vectors [rad], numerically stable near 0 and pi. */
export function angleBetween(a, b) {
  const c = cross(a, b);
  return Math.atan2(norm(c), dot(a, b));
}

/** Rotate vector `v` about unit axis `k` by angle `theta` (Rodrigues). */
export function rotateAbout(v, k, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const kv = cross(k, v);
  const kd = dot(k, v);
  return [
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ];
}

/** Component of `a` projected onto unit vector `u`. */
export const projectOnto = (a, u) => scale(u, dot(a, u));

/** Component of `a` perpendicular to unit vector `u`. */
export const rejectFrom = (a, u) => sub(a, projectOnto(a, u));

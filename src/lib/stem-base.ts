import * as THREE from "three/webgpu";

/**
 * Convert a foliage mesh's baked stem positions into a usable `stemBase`
 * attribute, and record the longest leaf on the geometry's userData.
 *
 * The stem positions are the pivots the sway rotates around, baked on the
 * instance domain with Store Named Attribute in geometry nodes and dropped to
 * the vertex domain by Realize.
 *
 * The glTF exporter converts POSITION from Blender's Z-up to glTF's Y-up but
 * leaves custom attributes starting with an underscore in Blender's
 * coordinates. Used as-is the pivots are off by 3.58m on average; converted,
 * the error is 0.10m, about one leaf. The exporter can't be told otherwise, so
 * the two are reconciled here — and renamed to something TSL can read.
 *
 * `stemLength` is the distance from the pivot to the furthest vertex. It
 * normalises the bend, and a value below the real one pins the outer half of
 * every leaf at bend=1, which reads as the clump sliding rather than bending
 * (sway.ts, leafLength).
 *
 * Idempotent: a mesh that already has `stemBase` is returned untouched.
 */
export function fixStemBase(mesh: THREE.Mesh | null) {
  const geo = mesh?.geometry;
  const src = geo?.getAttribute("_stembase");
  if (!geo || !src || geo.getAttribute("stemBase")) return mesh;

  const pos = geo.getAttribute("position");
  const dst = new Float32Array(src.count * 3);
  let longest = 0;
  for (let i = 0; i < src.count; i++) {
    const x = src.getX(i);
    const y = src.getZ(i);
    const z = -src.getY(i);
    dst[i * 3] = x;
    dst[i * 3 + 1] = y;
    dst[i * 3 + 2] = z;
    const d = Math.hypot(pos.getX(i) - x, pos.getY(i) - y, pos.getZ(i) - z);
    if (d > longest) longest = d;
  }
  geo.setAttribute("stemBase", new THREE.BufferAttribute(dst, 3));
  geo.deleteAttribute("_stembase");
  geo.userData.stemLength = longest;
  return mesh;
}

import * as THREE from "three";

export function isMeshType(object?: THREE.Object3D): object is THREE.Mesh {
  return object?.type === "Mesh";
}

import type * as CesiumNS from 'cesium';
import type { TheaterContact, TheaterLayerId } from '@/lib/theater/layers';

export type CesiumGlobal = typeof CesiumNS;

/** What a picked primitive carries so the theater knows which layer to ask. */
export type PickId = { layer: TheaterLayerId; id: string };

export function isPickId(x: unknown): x is PickId {
  return !!x && typeof x === 'object' && typeof (x as PickId).layer === 'string' && typeof (x as PickId).id === 'string';
}

/** One drawable feed inside the Cesium scene. Data in, primitives out; no fetching here. */
export interface TheaterLayer {
  readonly id: TheaterLayerId;
  setVisible(visible: boolean): void;
  /** a fresh payload from the layer's /api route */
  update(payload: unknown, now: number): void;
  /** advance motion; called a few times a second, must be cheap */
  tick(now: number): void;
  contact(id: string): TheaterContact | undefined;
  contacts(): Iterable<TheaterContact>;
  count(): number;
  dispose(): void;
}

export const scratch = {
  // PointPrimitive.position clones on assignment, so one scratch Cartesian3 serves every point.
  cartesian: null as CesiumNS.Cartesian3 | null,
};

export function scratchCartesian(Cesium: CesiumGlobal): CesiumNS.Cartesian3 {
  return (scratch.cartesian ??= new Cesium.Cartesian3());
}

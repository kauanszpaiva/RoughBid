export type PlansViewMode = 'single' | 'continuous';
export type PlansFitMode = 'manual' | 'width' | 'page';
export type PlansInspectorTab = 'ai' | 'takeoff' | 'notes' | 'plan';
export type NormalizedBox = readonly [number, number, number, number];
export type NormalizedPoint = Readonly<{ x: number; y: number }>;

export type FindingTarget =
  | { kind: 'box'; page: number; box: NormalizedBox }
  | { kind: 'point'; page: number; point: NormalizedPoint }
  | { kind: 'page'; page: number };
